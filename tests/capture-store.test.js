const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createCaptureStore } = require('../capture-store');

test('byte indexing reads multibyte records across chunks without retaining bodies in list metadata', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-index-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'captures.jsonl');
  const first = { id: 1, respMsgId: 'msg-1', system: '系统提示'.repeat(300000), tools: [{ name: 'Read' }], messages: [{ text: '完整正文' }], requestBody: '原始请求' };
  const second = { id: 2, respMsgId: 'msg-2', thinking: '思考', responseBody: '完整响应' };
  fs.writeFileSync(file, JSON.stringify(first) + '\n' + JSON.stringify(second));
  const store = createCaptureStore(file); store.load();
  assert.deepEqual(store.list().map(r => r.id), [2, 1]);
  assert.equal(store.list()[1].system, undefined);
  assert.equal(store.list()[1].requestBody, undefined);
  assert.deepEqual(store.getByMessageId('msg-1'), first);
  assert.deepEqual(store.get(2), second);
  store.append({ id: store.nextId(), requestBody: '第三条' });
  store.load();
  assert.equal(store.list().length, 3);
  assert.equal(store.get(3).requestBody, '第三条');
  assert.equal(store.get(99), null);
});

test('an incomplete final line is preserved and does not swallow future captures', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-tail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'captures.jsonl');
  fs.writeFileSync(file, '{"id":1}\n{"id":');
  const store = createCaptureStore(file); store.load();
  store.append({ id: store.nextId(), model: 'next' });
  store.load();
  assert.equal(store.get(2).model, 'next');
  assert.ok(fs.readFileSync(file, 'utf8').startsWith('{"id":1}\n{"id":\n'));
});

test('session navigation restores historical metadata and orders overlapping requests by arrival, including every model and API', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-navigation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'captures.jsonl'), store = createCaptureStore(file);
  const sid = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
  const body = prompt => JSON.stringify({ metadata: { user_id: JSON.stringify({ session_id: sid }) }, messages: [{ role: 'user', content: prompt }] });
  // The second request finishes first. Both share a timestamp, so arrival order breaks ties.
  store.append({ id: 2, requestOrder: 2, startedAt: '2026-11-06T00:00:00Z', path: '/v1/messages', model: 'haiku', requestBody: body('Your task is to create a detailed summary of the conversation so far.') });
  store.append({ id: 3, requestOrder: 3, startedAt: '2026-11-06T00:00:00Z', path: '/v1/messages', sessionId: other });
  store.append({ id: 1, requestOrder: 1, startedAt: '2026-11-06T00:00:00Z', path: '/v1/messages', model: 'opus', requestBody: body('main task') });
  store.append({ id: 4, requestOrder: 4, path: '/v1/messages/count_tokens', requestBody: body('count') });
  assert.deepEqual(store.navigation(2), { sessionId: sid, position: 2, total: 3, previousId: '1', nextId: '4' });
  assert.equal(store.navigation(1).previousId, null);
  assert.equal(store.navigation(4).nextId, null);
  assert.equal(store.metadata(2).purpose, 'compaction');
  assert.equal(store.metadata(2).purposeInferred, true);
  assert.equal(store.metadata(4).purpose, 'count_tokens');
  store.load(); assert.equal(store.navigation(2).previousId, '1');
  assert.deepEqual(store.list().map(r => r.id), [4, 3, 2, 1]);
});

test('legacy start time is reconstructed; unmatched and ambiguous captures do not jump across sessions', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-legacy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createCaptureStore(path.join(dir, 'captures.jsonl'));
  store.append({ id: 1, ts: '2026-11-06T00:00:03Z', durationMs: 1000, respMsgId: 'a' });
  store.append({ id: 2, ts: '2026-11-06T00:00:04Z', durationMs: 4000, respMsgId: 'b' });
  store.linkSessions(new Map([['a', 'session-a'], ['b', 'session-a']]));
  assert.equal(store.navigation(2).nextId, '1');
  store.linkSessions(new Map([['a', 'session-a'], ['b', '']]));
  assert.equal(store.navigation(2).total, 0);
  assert.equal(store.navigation(1).nextId, null);
  assert.equal(store.navigation(1).previousId, null);
});

function fixture(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-index-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return path.join(dir, 'captures.jsonl'); }
test('background indexing permits new requests without id collisions or losing historical bodies', async t => {
  const file = fixture(t), old = { id: 10, requestBody: JSON.stringify({ model: 'test' }), responseBody: 'old full response' };
  fs.writeFileSync(file, JSON.stringify(old)); // Interrupted last newline remains recoverable.
  const store = createCaptureStore(file), loading = store.loadAsync();
  assert.equal(store.status().loading, true);
  const id = store.nextId(); assert.ok(id > 10);
  store.append({ id, requestBody: '{}', responseBody: 'new full response' });
  await loading;
  assert.equal(store.list().length, 2); assert.equal(store.get(10).responseBody, old.responseBody); assert.equal(store.get(id).responseBody, 'new full response');
  const replay = createCaptureStore(file); replay.load(); assert.equal(replay.list().length, 2);
});
test('clearing captures during indexing cannot resurrect the historical index', async t => {
  const file = fixture(t); fs.writeFileSync(file, JSON.stringify({ id: 1 }) + '\n');
  const store = createCaptureStore(file), loading = store.loadAsync(); store.clear(); await loading; assert.deepEqual(store.list(), []);
});
