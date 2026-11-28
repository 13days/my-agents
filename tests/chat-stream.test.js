const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PassThrough } = require('node:stream');

const { EventEmitter } = require('node:events');
const { openClaudeSession } = require('../engines/claude/session');

// A fake Claude CLI process driven through the real session adapter.
function fakeHost() {
  const spawned = [];
  return {
    spawned,
    spawn(cmd, args) {
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.writes = [];
      child.stdin = { destroyed: false, writableEnded: false, on() {}, write: data => child.writes.push(JSON.parse(data)), end() { this.writableEnded = true; } };
      child.kills = []; child.kill = signal => child.kills.push(signal);
      child.args = args;
      spawned.push(child);
      return child;
    },
  };
}

// Exercise the actual CLI stdout handler without starting the panel or a paid request.
function streamHarness(history = null, options = {}) {
  const host = fakeHost();
  const frames = [];
  let idle = 0;
  const session = openClaudeSession({
    host, cli: 'claude', env: {}, cwd: '/tmp', sessionId: 'test-session',
    emit: (event, data) => frames.push({ type: event, data }), onIdle: () => idle++, onClosed() {},
    transcript: () => history?.messages || [], ...options,
  });
  const child = host.spawned[0];
  const events = () => frames.map(({ type, data }) => ({ type, data: JSON.parse(JSON.stringify(data)) }));
  const send = msg => child.stdout.write(JSON.stringify(msg) + '\n');
  const partial = event => send({ type: 'stream_event', event });
  return { child, session, events, send, partial, get idle() { return idle; } };
}

test('first text delta is emitted before the assistant message or result exists', () => {
  const h = streamHarness();
  h.partial({ type: 'message_start' });
  h.partial({ type: 'content_block_delta', delta: { type: 'text_delta', text: '你' } });
  assert.deepEqual(h.events().filter(e => e.type === 'text').map(e => e.data.text), ['你']);
  assert.equal(h.events().some(e => e.type === 'done'), false);
  h.partial({ type: 'content_block_delta', delta: { type: 'text_delta', text: '好' } });
  h.send({ type: 'assistant', message: { content: [{ type: 'text', text: '你好' }] } });
  assert.deepEqual(h.events().filter(e => e.type === 'text').map(e => e.data.text), ['你', '好']);
});

test('only the main assistant response supplies the model for the current turn', () => {
  const h = streamHarness();
  h.session.submit('first', { prompt: 'hi' });
  for (const [model, extra] of [['sub-model',{parent_tool_use_id:'tool'}], ['<synthetic>',{}], ['wrong',{error:'api_error'}], ['gpt-6.2',{}]]) {
    h.send({type:'assistant', message:{model,content:[]}, ...extra});
  }
  const reports = h.events().filter(e => e.type === 'status' && e.data.kind === 'response_model');
  assert.deepEqual(reports.map(e => [e.data.messageId, e.data.model]), [['first', 'gpt-6.2']]);
});

test('raw streaming IDs and final CLI IDs reconcile into one tool call', () => {
  const h = streamHarness();
  h.partial({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'raw-1', name: 'Bash', input: {} } });
  h.send({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'final-1', name: 'Bash', input: { command: 'ls' } }] } });
  h.send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'final-1', content: 'file.txt' }] } });
  assert.deepEqual(h.events().filter(e => e.type === 'tool').map(e => e.data.id), ['raw-1', 'raw-1']);
  assert.deepEqual(h.events().find(e => e.type === 'tool_result').data, { id: 'raw-1', output: 'file.txt', isError: false });
});

test('tool results are recovered from the transcript when the CLI omits them', () => {
  const h = streamHarness({ messages: [{ tools: [{ id: 'final-2', output: 'Recovered output', state: 'done' }] }] });
  h.partial({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'raw-2', name: 'Read', input: {} } });
  h.send({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'final-2', name: 'Read', input: { file_path: 'a' } }] } });
  h.send({ type: 'result', result: 'Done' });
  assert.equal(h.events().find(e => e.type === 'tool_result').data.output, 'Recovered output');
  assert.equal(h.events().find(e => e.type === 'tool_result').data.id, 'raw-2');
});

test('tool input deltas and results retain their call IDs including failures', () => {
  const h = streamHarness();
  h.partial({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call-1', name: 'Read', input: {} } });
  h.partial({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"a.txt"}' } });
  h.send({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: { file_path: 'a.txt' } }] } });
  h.send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'File missing', is_error: true }] } });
  const events = h.events();
  assert.equal(events.find(e => e.type === 'tool_input').data.id, 'call-1');
  assert.deepEqual(events.filter(e => e.type === 'tool').at(-1).data.input, { file_path: 'a.txt' });
  assert.deepEqual(events.find(e => e.type === 'tool_result').data, { id: 'call-1', output: 'File missing', isError: true });
});

test('split UTF-8 chunks preserve the first token and incomplete JSON is held', () => {
  const h = streamHarness();
  const bytes = Buffer.from(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '你好' } } }) + '\n');
  const split = bytes.indexOf(Buffer.from('你')) + 1;
  h.child.stdout.write(bytes.subarray(0, split));
  assert.equal(h.events().some(e => e.type === 'text'), false);
  h.child.stdout.write(bytes.subarray(split));
  assert.equal(h.events().find(e => e.type === 'text').data.text, '你好');
});

test('CLI errors[] are surfaced as failures even when result text is empty', () => {
  const h = streamHarness();
  h.send({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Tool execution failed'], result: '' });
  assert.equal(h.events().find(event => event.type === 'error').data.error, 'Tool execution failed');
  assert.equal(h.events().find(event => event.type === 'done').data.isError, true);
  assert.equal(h.events().some(event => event.type === 'text'), false);
});

test('internal interrupt notices do not appear as user prompts in saved sessions', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = source.indexOf('function transcriptUserText(');
  const end = source.indexOf('function sessionMessages(', start);
  const context = vm.createContext({}); vm.runInContext(source.slice(start, end), context);
  assert.equal(vm.runInContext('transcriptUserText("[Request interrupted by user]")', context), '');
  assert.equal(vm.runInContext('transcriptUserText([{type:"text",text:"[Request interrupted by user for tool use]"}])', context), '');
  assert.equal(vm.runInContext('transcriptUserText("这个目录下有什么")', context), '这个目录下有什么');
});

test('steering writes a real interrupt; a refused interrupt keeps the reply and warns', async () => {
  const h = streamHarness();
  h.session.submit('first', { prompt: 'first' }, false);
  h.session.submit('steer', { prompt: 'new direction' }, true);
  const interrupt = h.child.writes.find(w => w.request?.subtype === 'interrupt');
  assert.ok(interrupt);
  h.send({ type: 'control_response', response: { request_id: interrupt.request_id, subtype: 'error' } });
  assert.equal(h.events().filter(e => e.type === 'warning').length, 1);
  h.send({ type: 'result', result: 'ok' });
  assert.equal(h.events().find(e => e.type === 'done').data.interrupted, false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.session.currentId, 'steer');
  assert.equal(h.child.writes.at(-1).message.content[0].text ?? h.child.writes.at(-1).message.content, 'new direction');
});

test('thinking deltas surface as reasoning events', () => {
  const h = streamHarness();
  h.partial({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
  h.partial({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan' } });
  h.partial({ type: 'content_block_stop', index: 0 });
  assert.equal(h.events().find(e => e.type === 'reasoning').data.text, 'plan');
});

test('a resumed Claude process drains its zero-turn recovery result before the new stdin prompt', async () => {
  const h = streamHarness(null, { resume: true });
  assert.ok(h.child.args.includes('--replay-user-messages'));
  h.session.submit('new-turn', { prompt: '改完了吗' });
  h.session.submit('follow-up', { prompt: 'second' });
  h.send({ type: 'user', uuid: 'old-turn', isReplay: true });
  h.send({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] } });
  h.send({ type: 'result', subtype: 'success', num_turns: 0, result: '' });
  assert.equal(h.session.currentId, 'new-turn');
  assert.equal(h.events().some(e => ['text', 'done', 'idle'].includes(e.type)), false);
  h.send({ type: 'user', uuid: 'new-turn', isReplay: true });
  h.send({ type: 'assistant', message: { model: 'normal-model', content: [{ type: 'text', text: 'No response requested.' }] } });
  h.send({ type: 'result', subtype: 'success', num_turns: 1, result: 'No response requested.' });
  assert.equal(h.events().find(e => e.type === 'text').data.messageId, 'new-turn');
  assert.equal(h.events().find(e => e.type === 'done').data.messageId, 'new-turn');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.session.currentId, 'follow-up');
  h.send({ type: 'user', uuid: 'follow-up', isReplay: true });
  h.send({ type: 'result', subtype: 'success', num_turns: 0, result: '' });
  assert.equal(h.session.currentId, '');
});

test('a failed Claude resume before acknowledgement still reports the error', () => {
  const h = streamHarness(null, { resume: true });
  h.session.submit('failed-input', { prompt: 'try' });
  h.send({ type: 'result', subtype: 'error_during_execution', num_turns: 0, errors: ['session missing'], is_error: true });
  assert.equal(h.events().find(e => e.type === 'error').data.messageId, 'failed-input');
  assert.equal(h.events().find(e => e.type === 'done').data.isError, true);
});

test('Claude receives supplements while its first tool is active and one combined result settles each UUID', async () => {
  const h = streamHarness();
  h.session.submit('main', { prompt: 'start' });
  h.partial({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'reading', name: 'Read', input: {} } });
  for (const id of ['additional', 'last']) h.session.submit(id, { prompt: id, mode: 'insert' });
  assert.deepEqual(h.child.writes.filter(row => row.type === 'user').map(row => row.uuid), ['main','additional','last']);
  assert.ok(!h.child.writes.some(row => row.request?.subtype === 'interrupt'));
  h.session.submit('queued', { prompt: 'queue' }, false);
  for (const uuid of ['main','additional','last']) h.send({ type: 'user', isReplay: true, uuid });
  assert.equal(h.session.currentId, 'last');
  h.send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'reading', content: 'file' }] } });
  h.partial({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'combined' } });
  h.send({ type: 'result', subtype: 'success', num_turns: 2, total_cost_usd: 1, result: 'combined' });
  const events = h.events();
  assert.equal(events.find(e => e.type === 'tool_result').data.messageId, 'main');
  assert.equal(events.find(e => e.type === 'text').data.messageId, 'last');
  assert.deepEqual(events.filter(e => e.type === 'done').map(e => [e.data.messageId, !!e.data.continued]), [['main',true], ['additional',true], ['last',false]]);
  assert.equal(events.filter(e => e.type === 'done' && e.data.cost).length, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.session.currentId,'queued');
});

test('a written supplement acknowledged after a result starts the next turn without a second write', async () => {
  const h = streamHarness();
  h.session.submit('first', { prompt: 'question' });
  h.session.submit('second', { prompt: 'supplement', mode: 'insert' });
  h.send({ type: 'result', subtype: 'success', num_turns: 1, result: 'first answer' });
  h.send({ type: 'user', uuid: 'second', isReplay: true });
  h.send({ type: 'result', subtype: 'success', num_turns: 1, result: 'second answer' });
  assert.equal(h.child.writes.filter(row => row.uuid === 'second').length, 1);
  assert.deepEqual(h.events().filter(e => e.type === 'text').map(e => e.data.messageId), ['first','second']);
});
