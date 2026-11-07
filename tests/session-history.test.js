const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');

test('history pages preserve all long text, cover every message, and reuse unchanged transcripts', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-history-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.jsonl'), rows = [];
  for (let i = 0; i < 100; i++) {
    rows.push({ type: 'user', message: { content: 'question-' + i } });
    rows.push({ type: 'assistant', message: { content: [{ type: 'text', text: i === 85 ? '长回复'.repeat(20000) : 'answer-' + i }] } });
  }
  fs.writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n');
  let reads = 0;
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const context = vm.createContext({ codexSessions: { list: () => [], pathFor: () => '', messages: () => null }, isCodexPath: () => false, isCodexSession: () => false, fs: { ...fs, readFileSync(...args) { reads++; return fs.readFileSync(...args); } }, path,
    readHistory: () => [], transcriptPathFor: () => file, transcriptHead: () => ({ cwd: dir }),
    transcriptUserText: text => text, CLAUDE_DIR: dir,
  });
  vm.runInContext(source.slice(source.indexOf('const sessionMessageCache ='), source.indexOf('function listSessions()')), context);
  const latest = context.sessionMessages('session-id');
  assert.equal(latest.messages.length, 80);
  assert.equal(latest.historyBefore, 120);
  assert.equal(latest.messages.find(m => m.text.startsWith('长回复')).text.length, 60000);
  const middle = context.sessionMessages('session-id', { before: latest.historyBefore });
  const first = context.sessionMessages('session-id', { before: middle.historyBefore });
  const complete = [...first.messages, ...middle.messages, ...latest.messages];
  assert.equal(complete.length, 200);
  assert.equal(first.truncated, false);
  assert.equal(complete[0].text, 'question-0');
  assert.equal(complete.at(-1).text, 'answer-99');
  assert.equal(reads, 1);
  fs.appendFileSync(file, JSON.stringify({ type: 'user', message: { content: 'new question' } }) + '\n');
  assert.equal(context.sessionMessages('session-id').messages.at(-1).text, 'new question');
  assert.equal(reads, 2);
});
