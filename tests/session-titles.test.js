const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { normalizeTitle, isManualTitle, autoTitlePatch } = require('../session-store');

test('automatic names follow new prompts while explicit and legacy manual names remain fixed', () => {
  const automatic = { title: 'First question', initialPrompt: 'First question', createdAt: 1 };
  assert.equal(isManualTitle(automatic, 'First question'), false);
  assert.equal({ ...automatic, ...autoTitlePatch(automatic, 'Latest\nquestion') }.title, 'Latest question');
  const manual = { ...automatic, title: 'My project', titleSource: 'manual' };
  assert.equal({ ...manual, ...autoTitlePatch(manual, 'Latest question') }.title, 'My project');
  assert.equal(isManualTitle({ title: 'Old manual name' }), true);
  assert.equal(isManualTitle({ ...automatic, title: 'Old manual name' }, 'First question'), true);
});

test('latest transcript prompt scans backwards past large replies, tools and interrupt notices', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-titles-'));
  try {
    const file = path.join(dir, 'session.jsonl');
    const lines = [
      { type: 'user', timestamp: '2026-11-06T10:00:00Z', message: { content: 'First question' } },
      { type: 'user', timestamp: '2026-11-06T10:01:00Z', message: { content: '最新的问题' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(160000) }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'Tool output' }] } },
      { type: 'user', message: { content: '[Request interrupted by user]' } },
    ];
    fs.writeFileSync(file, lines.map(JSON.stringify).join('\n') + '\n');
    const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const start = source.indexOf('function transcriptUserText('), end = source.indexOf('function sessionMessages(', start);
    const context = vm.createContext({ codexSessions: { list: () => [], pathFor: () => '', messages: () => null }, isCodexPath: () => false, isCodexSession: () => false, fs, Buffer, normalizeTitle });
    vm.runInContext(source.slice(start, end), context);
    context.file = file;
    assert.equal(vm.runInContext('latestTranscriptPrompt(file).title', context), '最新的问题');
    fs.appendFileSync(file, JSON.stringify({ type: 'user', message: { content: 'Another question' } }) + '\n');
    assert.equal(vm.runInContext('latestTranscriptPrompt(file).title', context), 'Another question');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
