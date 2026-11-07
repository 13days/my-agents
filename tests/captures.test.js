const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-captures-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const context = vm.createContext({ codexSessions: { list: () => [], pathFor: () => '', messages: () => null }, isCodexPath: () => false, isCodexSession: () => false, fs, path, zlib, createCaptureStore: require('../capture-store').createCaptureStore, CLAUDE_DIR: dir,
    extractText: content => typeof content === 'string' ? content : (content || []).filter(b => b.type === 'text').map(b => b.text).join(' '),
  });
  vm.runInContext(source.slice(source.indexOf('const CAPTURES_FILE ='), source.indexOf('const accountRouter =')), context);
  return { context, file: path.join(dir, 'panel-captures.jsonl') };
}

test('captures preserve long context, schemas, unknown blocks and complete SSE responses', t => {
  const { context, file } = fixture(t);
  const long = '技能正文'.repeat(10000);
  const request = JSON.stringify({ model: 'test', system: long.repeat(6), tools: [{ name: 'Skill', description: long, input_schema: { type: 'object' } }],
    messages: [...Array.from({ length: 130 }, () => ({ role: 'user', content: 'earlier' })),
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'Skill', input: { text: long } }] },
      { role: 'user', content: [{ type: 'text', text: long }, { type: 'tool_result', tool_use_id: 'call-1', content: long }, { type: 'image', source: { data: 'original-image' } }, { type: 'future-block', value: long }] }] });
  const response = [
    { type: 'content_block_delta', delta: { type: 'text_delta', text: long } },
    { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: long } },
  ].map(e => 'data: ' + JSON.stringify(e) + '\n\n').join('');
  context.request = Buffer.from(request);
  context.response = zlib.gzipSync(response);
  vm.runInContext("recordExchange('/v1/messages', 200, 1, request, response, true, {}, 'gzip', '', '')", context);
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(rec.requestBody, request);
  assert.equal(rec.responseBody, response);
  assert.equal(rec.messages.length, 132);
  assert.equal(rec.messages[0].parts[0].text, 'earlier');
  assert.equal(rec.messages.at(-1).parts[0].text, long);
  assert.equal(rec.messages.at(-1).parts[1].text, long);
  assert.equal(JSON.parse(rec.messages.at(-2).parts[0].input).text, long);
  assert.equal(rec.tools[0].description, long);
  assert.deepEqual(rec.tools[0].input_schema, { type: 'object' });
  assert.equal(rec.system, long.repeat(6));
  assert.equal(rec.outText, long);
  assert.equal(rec.thinking, long);
});

test('capture history survives the former 600-record cleanup threshold and reloads fully', t => {
  const { context, file } = fixture(t);
  vm.runInContext(`for (let i = 1; i <= 605; i++) {
    const rec = { id: i, respMsgId: 'message-' + i };
    persistCapture(rec);
  }`, context);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 605);
  vm.runInContext('loadCaptures()', context);
  assert.equal(vm.runInContext('captureStore.list().length', context), 605);
  assert.equal(vm.runInContext('captureStore.list()[0].id', context), 605);
  assert.equal(vm.runInContext('captureStore.list().at(-1).id', context), 1);
});
