const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createCodexSessions } = require('../engines/codex/sessions');
const record = (type, payload) => JSON.stringify({ timestamp: '2026-11-16T00:00:00Z', type, payload });
const user = text => record('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-incremental-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, 'sessions'));
  const id = '11111111-1111-4111-8111-111111111111', file = path.join(home, 'sessions', 'rollout-' + id + '.jsonl');
  return { file, id, sessions: createCodexSessions({ home }) };
}
test('a large rollout rereads only appended bytes for both history and session summaries', t => {
  const { file, id, sessions } = fixture(t);
  fs.writeFileSync(file, record('session_meta', { cwd: '/work' }) + '\n' + user('first') + '\n');
  const padding = record('event_msg', { type: 'diagnostic', detail: 'x'.repeat(256 * 1024) }) + '\n';
  for (let i = 0; i < 80; i++) fs.appendFileSync(file, padding);
  assert.equal(sessions.messages(id).messages.length, 1); assert.equal(sessions.list()[0].count, 1);
  const read = fs.readSync; let bytes = 0;
  fs.readSync = (...args) => { const n = read(...args); bytes += n; return n; };
  try {
    assert.equal(sessions.messages(id).messages.length, 1); sessions.list(); assert.equal(bytes, 0);
    const appended = user('terminal continuation') + '\n' + record('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'new reply' }] }) + '\n';
    fs.appendFileSync(file, appended);
    assert.deepEqual(sessions.messages(id).messages.map(m => m.text), ['first', 'terminal continuation', 'new reply']);
    assert.equal(sessions.list()[0].count, 2); assert.equal(sessions.list()[0].title, 'terminal continuation');
    assert.ok(bytes <= Buffer.byteLength(appended) * 2 + 2, 'an append must not reread the 20 MB history');
  } finally { fs.readSync = read; }
});
test('partial UTF-8, unfinished JSON and exports without a final newline remain lossless without duplicates', t => {
  const { file, id, sessions } = fixture(t);
  fs.writeFileSync(file, user('first')); assert.equal(sessions.messages(id).messages.length, 1);
  fs.appendFileSync(file, '\n'); assert.equal(sessions.messages(id).messages.length, 1);
  const text = Buffer.from(user('中文继续'));
  const cut = text.indexOf(Buffer.from('文')) + 1;
  fs.appendFileSync(file, text.subarray(0, cut)); assert.equal(sessions.messages(id).messages.length, 1);
  fs.appendFileSync(file, text.subarray(cut));
  assert.deepEqual(sessions.messages(id).messages.map(m => m.text), ['first', '中文继续']);
  fs.appendFileSync(file, '\n' + user('next') + '\n');
  assert.deepEqual(sessions.messages(id).messages.map(m => m.text), ['first', '中文继续', 'next']);
});
test('rewritten and atomically replaced rollouts discard stale messages, summaries and tool associations', t => {
  const { file, id, sessions } = fixture(t);
  fs.writeFileSync(file, user('old history') + '\n'); sessions.messages(id); sessions.list();
  fs.writeFileSync(file, user('short') + '\n');
  assert.deepEqual(sessions.messages(id).messages.map(m => m.text), ['short']); assert.equal(sessions.list()[0].title, 'short');
  fs.writeFileSync(file + '.new', user('replacement history') + '\n'); fs.renameSync(file + '.new', file);
  assert.deepEqual(sessions.messages(id).messages.map(m => m.text), ['replacement history']); assert.equal(sessions.list()[0].count, 1);
});
test('later assistant appends refresh inferred timing without mutating an earlier replay snapshot', t => {
  const { file, id, sessions } = fixture(t);
  const reply = (text, time) => JSON.stringify({ timestamp: time, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }) + '\n';
  fs.writeFileSync(file, user('question') + '\n' + reply('first part', '2026-11-16T00:00:01Z'));
  const first = sessions.messages(id);
  fs.appendFileSync(file, reply('second part', '2026-11-16T00:00:02Z'));
  const next = sessions.messages(id);
  assert.equal(first.messages.at(-1).text, 'first part'); assert.equal(first.messages.at(-1).durationMs, 1000);
  assert.equal(next.messages.at(-1).text, 'first part\n\nsecond part'); assert.equal(next.messages.at(-1).durationMs, 2000);
});
