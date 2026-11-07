const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { resolveCodex, parseVersion, compareVersions } = require('../codex-cli');
const { createCodexSessions, codexUserText } = require('../codex-sessions');
const { createCodexRunner, codexArgs, explainCodexError } = require('../codex-engine');
const { extractResponses, codexProviderConfig, isCodexPath, normalizeUsage } = require('../codex-proxy');

test('the newest Codex install wins regardless of PATH order, and CODEX_CLI overrides detection', () => {
  assert.deepEqual(parseVersion('codex-cli 0.167.0'), [0, 167, 0]);
  assert.ok(compareVersions([0, 167, 0], [0, 27, 0]) > 0);
  const probe = file => { if (file === '/old/codex') return 'codex-cli 0.27.0'; if (file === '/new/codex') return 'codex-cli 0.167.0'; throw new Error('missing'); };
  const found = resolveCodex({ env: { PATH: '/old:/new' }, refresh: true, probe });
  assert.equal(found.path, '/new/codex'); assert.equal(found.version, '0.167.0');
  assert.deepEqual(found.candidates.map(item => item.version), ['0.167.0', '0.27.0']);
  assert.equal(resolveCodex({ env: { CODEX_CLI: '/custom/codex' } }).path, '/custom/codex');
});

test('rollout files become session summaries, readable history and token/quota stats', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-codex-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const id = '01a1b251-c5d4-7ee2-8183-7029e07ad554', dir = path.join(home, 'sessions', '2026', '11', '06');
  fs.mkdirSync(dir, { recursive: true });
  const at = '2026-11-06T08:00:00.000Z', line = (type, payload) => JSON.stringify({ timestamp: at, type, payload });
  const user = text => line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
  fs.writeFileSync(path.join(dir, `rollout-2026-11-06T08-00-00-${id}.jsonl`), [
    line('session_meta', { id, cwd: '/work/demo', model_provider: 'openai', base_instructions: 'x'.repeat(200000) }),
    line('turn_context', { cwd: '/work/demo', model: 'gpt-5.5' }),
    user('# AGENTS.md instructions for /work/demo\n...'),
    user('<environment_context>\n<cwd>/work/demo</cwd>\n</environment_context>'),
    user('[Claude Panel 飞书发送上下文，本轮有效]\n{}\n[/Claude Panel 飞书发送上下文]\n\n运行 echo hi'),
    line('response_item', { type: 'function_call', name: 'shell', arguments: '{"command":["echo","hi"]}', call_id: 'call_1' }),
    line('response_item', { type: 'function_call_output', call_id: 'call_1', output: '{"output":"hi\\n","metadata":{"exit_code":0}}' }),
    line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] }),
    line('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10, reasoning_output_tokens: 2 } }, rate_limits: { primary: { used_percent: 10, window_minutes: 10080 } } }),
    line('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 250, cached_input_tokens: 140, output_tokens: 30, reasoning_output_tokens: 2 } } }),
  ].join('\n') + '\n');
  const sessions = createCodexSessions({ home });
  const [item] = sessions.list();
  assert.equal(item.id, id); assert.equal(item.engine, 'codex'); assert.equal(item.project, '/work/demo'); assert.equal(item.title, '运行 echo hi'); assert.equal(item.count, 1); assert.equal(item.model, 'gpt-5.5');
  const history = sessions.messages(id);
  assert.deepEqual(history.messages.map(m => m.role), ['user', 'assistant']);
  assert.equal(history.messages[1].text, 'hi');
  assert.deepEqual(history.messages[1].tools.map(tool => [tool.name, tool.output, tool.state]), [['shell', 'hi\n', 'done']]);
  const stats = sessions.stats();
  assert.deepEqual(stats.totals, { input: 250, cached: 140, output: 30, reasoning: 2, turns: 2 });
  assert.equal(stats.models[0].key, 'gpt-5.5'); assert.equal(stats.rateLimits.primary.used_percent, 10);
  assert.equal(sessions.messages('00000000-0000-0000-0000-000000000000'), null);
  assert.equal(sessions.provider(id), 'openai'); assert.equal(sessions.provider('00000000-0000-0000-0000-000000000000'), '');
  assert.equal(codexUserText([{ type: 'input_text', text: '<turn_aborted>' }]), '');
});

function fakeSpawn(script) {
  const spawned = [];
  const spawnImpl = (cli, args) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new PassThrough(); let input = ''; child.stdin.on('data', c => { input += c; });
    child.kill = signal => { child.killedWith = signal; setImmediate(() => child.emit('close', null, signal)); };
    const entry = { args, child, get input() { return input; } }; spawned.push(entry);
    setImmediate(() => script(entry, spawned.length));
    return child;
  };
  return { spawnImpl, spawned };
}
const emitLines = (child, items) => { for (const item of items) child.stdout.write(JSON.stringify(item) + '\n'); };

test('a Codex runner streams tools and replies, then resumes the same thread on the next turn', async () => {
  const { spawnImpl, spawned } = fakeSpawn(({ child }, n) => {
    emitLines(child, [
      ...(n === 1 ? [{ type: 'thread.started', thread_id: 'thread-1' }] : []), { type: 'turn.started' },
      { type: 'item.started', item: { id: 'item_0', type: 'command_execution', command: 'echo hi', status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'item_0', type: 'command_execution', command: 'echo hi', aggregated_output: 'hi\n', exit_code: 0, status: 'completed' } },
      { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: `reply ${n}` } },
      { type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 1 } },
    ]);
    child.stdout.end(); setImmediate(() => child.emit('close', 0, null));
  });
  const events = []; let idle;
  const idled = () => new Promise(resolve => { idle = resolve; });
  const runner = createCodexRunner({ cli: 'codex', cwd: '/work', config: codexProviderConfig(4992), spawnImpl, emit: (event, data) => events.push([event, data]), onIdle: () => idle?.() });
  let waiting = idled();
  runner.submit('aaaaaaaa-1', { prompt: '-run it' });
  assert.equal(await runner.ready, 'thread-1');
  await waiting;
  assert.deepEqual(spawned[0].args.slice(0, 2), ['exec', '--json']);
  assert.ok(spawned[0].args.includes('-C') && spawned[0].args.at(-1) === '-');
  assert.ok(spawned[0].args.includes('model_provider="panel"'));
  assert.equal(spawned[0].input, '-run it');
  assert.deepEqual(events.map(([event]) => event), ['turn', 'tool', 'tool_result', 'text', 'done']);
  assert.deepEqual(events[2][1], { id: 'aaaaaaaa-item_0', output: 'hi\n', isError: false });
  assert.deepEqual(events[4][1], { sessionId: 'thread-1', cost: null, turns: 1, usage: { input_tokens: 5, output_tokens: 1 }, isError: false, error: '', interrupted: false });
  waiting = idled();
  runner.submit('bbbbbbbb-2', { prompt: 'again' });
  await waiting;
  assert.deepEqual(spawned[1].args.slice(0, 3), ['exec', 'resume', '--json']);
  assert.equal(spawned[1].args.at(-2), 'thread-1');
  assert.equal(events.filter(([event]) => event === 'text').at(-1)[1].text, 'reply 2');
});

test('steering interrupts the running Codex turn and continues with the new input', async () => {
  const { spawnImpl, spawned } = fakeSpawn(({ child }, n) => {
    if (n === 1) { emitLines(child, [{ type: 'thread.started', thread_id: 'thread-2' }, { type: 'turn.started' }]); return; } // waits until killed
    emitLines(child, [{ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'steered' } }, { type: 'turn.completed', usage: null }]);
    child.stdout.end(); setImmediate(() => child.emit('close', 0, null));
  });
  const events = []; let idle; const idled = new Promise(resolve => { idle = resolve; });
  const runner = createCodexRunner({ cli: 'codex', cwd: '/work', spawnImpl, emit: (event, data) => events.push([event, data]), onIdle: () => idle() });
  runner.submit('first-turn', { prompt: 'sleep' });
  await runner.ready;
  runner.submit('second-turn', { prompt: 'stop waiting' }, true);
  await idled;
  assert.equal(spawned[0].child.killedWith, 'SIGINT');
  const dones = events.filter(([event]) => event === 'done').map(([, data]) => data);
  assert.deepEqual(dones.map(item => item.interrupted), [true, false]);
  assert.equal(spawned[1].input, 'stop waiting');
  assert.ok(spawned[1].args.includes('resume'));
  assert.equal(events.find(([event]) => event === 'text')[1].text, 'steered');
});

test('resuming a thread held by another Codex process forks it into a new session', async () => {
  const { spawnImpl, spawned } = fakeSpawn(({ child }, n) => {
    if (n === 1) {
      child.stderr.write('ERROR thread-store conflict: thread busy-1 already has an active writer\n');
      child.stdout.end(); setImmediate(() => child.emit('close', 1, null)); return;
    }
    emitLines(child, [{ type: 'thread.started', thread_id: 'forked-1' }, { type: 'item.completed', item: { id: 'i', type: 'agent_message', text: `ok ${n}` } }, { type: 'turn.completed', usage: null }]);
    child.stdout.end(); setImmediate(() => child.emit('close', 0, null));
  });
  const events = []; let idle; let idled = new Promise(resolve => { idle = resolve; });
  const runner = createCodexRunner({ cli: 'codex', cwd: '/work', threadId: 'busy-1', spawnImpl, emit: (event, data) => events.push([event, data]), onIdle: () => idle() });
  runner.submit('first-turn', { prompt: 'hello' });
  assert.equal(await runner.ready, 'forked-1');
  await idled;
  assert.deepEqual(spawned.slice(0, 2).map(s => s.args[1]), ['resume', 'fork']);
  assert.equal(spawned[1].args.at(-2), 'busy-1'); assert.equal(spawned[1].input, 'hello');
  assert.ok(events.some(([event, data]) => event === 'warning' && /新会话/.test(data.warning)));
  assert.ok(!events.some(([event]) => event === 'error'));
  idled = new Promise(resolve => { idle = resolve; });
  runner.submit('second-turn', { prompt: 'again' });
  await idled;
  assert.deepEqual([spawned[2].args[1], spawned[2].args.at(-2)], ['resume', 'forked-1']);
});

test('Codex Responses captures expose system prompt, flattened tools, transcript, reply and usage', () => {
  assert.ok(isCodexPath('/backend-api/codex/responses')); assert.ok(isCodexPath('/codex-openai/v1/responses')); assert.ok(!isCodexPath('/v1/messages'));
  assert.match(codexProviderConfig(4992, { apiKey: true })[0], /127\.0\.0\.1:4992\/codex-openai\/v1/);
  const request = JSON.stringify({ model: 'gpt-5.5', instructions: 'Base rules', input: [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Developer rules' }] },
    { type: 'additional_tools', tools: [{ type: 'namespace', name: 'mcp__docs', tools: [{ name: 'search', description: 'Search docs', parameters: { type: 'object' } }] }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
  ], tools: [{ type: 'function', name: 'shell', parameters: {} }] });
  const response = [
    'data: {"type":"response.output_text.delta","delta":"Hi "}',
    'data: {"type":"response.output_text.delta","delta":"there"}',
    'data: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":60},"output_tokens":7}}}',
  ].join('\n\n');
  const rec = extractResponses(request, response, true);
  assert.equal(rec.engine, 'codex'); assert.equal(rec.model, 'gpt-5.5');
  assert.equal(rec.system, 'Base rules\n\nDeveloper rules');
  assert.deepEqual(rec.tools.map(tool => tool.name), ['shell', 'mcp__docs.search']);
  assert.equal(rec.lastUser, 'hello'); assert.equal(rec.messagesCount, 1);
  assert.equal(rec.outText, 'Hi there'); assert.equal(rec.respMsgId, 'resp_1');
  assert.deepEqual(rec.usage, normalizeUsage({ input_tokens: 100, input_tokens_details: { cached_tokens: 60 }, output_tokens: 7 }));
  assert.equal(rec.usage.input_tokens, 40); assert.equal(rec.usage.cache_read_input_tokens, 60);
  // ChatGPT 订阅后端的 SSE 可能没有 event-stream 类型：按正文识别
  const untyped = extractResponses(request, 'event: response.created\n' + response, false);
  assert.equal(untyped.outText, 'Hi there'); assert.equal(untyped.usage.output_tokens, 7); assert.equal(untyped.finished, 'response.completed');
  assert.match(explainCodexError('thread/resume failed: thread x already has an active writer'), /^这个 Codex 会话正在别处打开[\s\S]*active writer$/);
  assert.equal(explainCodexError('something else'), 'something else'); assert.equal(explainCodexError(''), '');
  assert.deepEqual(codexArgs({ threadId: 't', cwd: '/w', images: ['/tmp/a.png'] }).slice(0, 4), ['exec', 'resume', '-i', '/tmp/a.png']);
});

test('recovered Codex transport errors do not override a completed reply', async () => {
  const { spawnImpl } = fakeSpawn(({ child }) => {
    emitLines(child, [
      { type: 'thread.started', thread_id: 'recovered' },
      { type: 'error', message: 'Reconnecting... 3/5 (502 Bad Gateway)' },
      { type: 'item.completed', item: { id: 'reply', type: 'agent_message', text: 'Recovered reply' } },
      { type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 2 } },
    ]);
    child.stdout.end(); setImmediate(() => child.emit('close', 0, null));
  });
  const events = []; let finish;
  const idle = new Promise(resolve => { finish = resolve; });
  const runner = createCodexRunner({ cli: 'codex', cwd: '/work', spawnImpl, emit: (event, data) => events.push([event, data]), onIdle: finish });
  runner.submit('recovered-turn', { prompt: 'hello' });
  await idle;
  assert.ok(events.some(([event]) => event === 'warning'));
  assert.ok(!events.some(([event]) => event === 'error'));
  assert.equal(events.find(([event]) => event === 'done')[1].isError, false);
});

test('usage caches unchanged rollouts and invalidates changed files', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'my-agents-usage-'));
  try {
    const dir = path.join(home, 'sessions'); fs.mkdirSync(dir);
    const fp = path.join(dir, 'rollout-00000000-0000-0000-0000-000000000001.jsonl');
    const event = total => JSON.stringify({ timestamp: '2026-11-07T00:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: total } } } }) + '\n';
    fs.writeFileSync(fp, event(10));
    const sessions = createCodexSessions({ home });
    assert.equal(sessions.stats().totals.input, 10);
    const original = fs.readFileSync; let reads = 0;
    fs.readFileSync = (...args) => { if (args[0] === fp) reads++; return original(...args); };
    try { assert.equal(sessions.stats().totals.input, 10); assert.equal(reads, 0); }
    finally { fs.readFileSync = original; }
    fs.appendFileSync(fp, event(15));
    assert.equal(sessions.stats().totals.input, 15);
    fs.unlinkSync(fp); assert.equal(sessions.stats().totals.input, 0);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('Codex public reasoning summaries stream once per update alongside tools and survive replay', async () => {
  const { spawnImpl } = fakeSpawn(({ child }) => {
    emitLines(child, [
      { type: 'thread.started', thread_id: 'reasoning-thread' },
      { type: 'item.completed', item: { id: 'summary', type: 'reasoning', text: 'I will check the file.' } },
      { type: 'item.completed', item: { id: 'summary', type: 'reasoning', text: 'I will check the file.' } },
      { type: 'item.completed', item: { id: 'tool', type: 'command_execution', command: 'pwd', aggregated_output: '/work', exit_code: 0, status: 'completed' } },
      { type: 'turn.completed', usage: {} },
    ]); child.stdout.end(); setImmediate(() => child.emit('close', 0, null));
  });
  const events = []; let finish; const idle = new Promise(resolve => finish = resolve);
  const runner = createCodexRunner({ cli: 'codex', cwd: '/work', spawnImpl, emit: (event, data) => events.push([event, data]), onIdle: finish });
  runner.submit('reasoning-turn', { prompt: 'Check the file' }); await idle;
  assert.equal(events.filter(([event]) => event === 'reasoning').length, 1);
  assert.equal(events.filter(([event]) => event === 'tool_result')[0][1].output, '/work');
  assert.ok(codexArgs({ cwd: '/work' }).includes('model_reasoning_summary="auto"'));
  const { reasoningText } = require('../codex-engine');
  assert.equal(reasoningText({ encrypted_content: 'opaque-internal-content' }), '');
  assert.equal(reasoningText({ summary: [{ type: 'summary_text', text: 'Public summary' }] }), 'Public summary');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'my-agents-reasoning-'));
  try {
    fs.mkdirSync(path.join(home, 'sessions')); const id = '11111111-1111-4111-8111-111111111111';
    fs.writeFileSync(path.join(home, 'sessions', `rollout-${id}.jsonl`), [
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Question' }] } },
      { type: 'response_item', payload: { type: 'reasoning', id: 'summary', summary: [{ type: 'summary_text', text: 'Public summary' }], encrypted_content: 'never shown' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Answer' }] } },
    ].map(x => JSON.stringify(x)).join('\n'));
    const messages = createCodexSessions({ home }).messages(id).messages;
    assert.equal(messages[1].reasoning[0].text, 'Public summary'); assert.equal(messages[1].text, 'Answer');
    assert.ok(!JSON.stringify(messages).includes('never shown'));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
