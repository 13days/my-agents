const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('external transcript updates move existing sessions ahead of stale CLI history', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = source.indexOf('function listSessions() {');
  const end = source.indexOf('function transcriptPathFor(', start);
  const context = vm.createContext({ machineId: () => 'mac',
    codexSessions: { list: () => [], pathFor: () => '', messages: () => null }, isCodexPath: () => false, isCodexSession: () => false,
    path,
    require: name => { assert.equal(name, './core/transcript-labels'); return { transcriptLabels: file => file.includes('new-cli') ? { sessionName: 'project-plugin-recommendations', gitBranch: 'worktree-isolated-task', cwd: '/project/.claude/worktrees/isolated-task' } : {} }; },
    accountRouter: { sessions: () => ({ items: [] }) },
    sessionStore: { read: () => ({ older: { title: 'Renamed older session' }, removed: { deleted: true } }) },
    transcriptFiles: () => ({ sessionFiles: ['/sessions/older.jsonl', '/sessions/recent.jsonl', '/sessions/new-cli.jsonl', '/sessions/removed.jsonl'] }),
    readHistory: () => [{ sessionId: 'older', display: 'Old title', timestamp: 100 }, { sessionId: 'recent', display: 'Recent', timestamp: 200 }],
    fs: { statSync: file => ({ mtimeMs: file.includes('older') ? 500 : file.includes('new-cli') ? 300 : 200 }) },
    transcriptHead: () => ({ title: 'CLI print session', cwd: '/project' }),
    latestTranscriptPrompt: () => ({ title: '', at: 0 }),
    isManualTitle: require('../session-store').isManualTitle,
    manager: { busy: () => false },
  });
  vm.runInContext(source.slice(start, end), context);
  const sessions = vm.runInContext('listSessions()', context);
  assert.deepEqual(Array.from(sessions, item => item.id), ['older', 'new-cli', 'recent']);
  assert.equal(sessions[1].title, 'project-plugin-recommendations');
  assert.equal(sessions[1].gitBranch, 'worktree-isolated-task');
  assert.equal(sessions[1].project, '/project/.claude/worktrees/isolated-task');
  assert.equal(sessions[1].native, true);
  assert.equal(sessions[0].last, 500);
  assert.equal(sessions[0].title, 'Renamed older session');
});
