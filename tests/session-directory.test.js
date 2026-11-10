const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createSessionDirectory, searchSessions } = require('../core/session-directory');
const { transcriptLabels } = require('../core/transcript-labels');
test('live native sessions are aggregated from machines and outrank copied checkpoints', async () => {
  const directory = createSessionDirectory({ selfId: () => 'leader', local: () => [{ id: 'active', title: 'old checkpoint', machineId: 'mac', last: 999 }], peers: () => [{ id: 'mac', peer: { call: async method => { assert.equal(method, 'history.list'); return [{ id: 'active', native: true, title: 'project-plugin-recommendations', project: '/repo/.claude/worktrees/isolated-task', last: 10, running: true }]; } } }] });
  const { sessions } = await directory.list({ refresh: true });
  assert.equal(sessions.length, 1); assert.equal(sessions[0].title, 'project-plugin-recommendations'); assert.equal(sessions[0].machineId, 'mac');
  assert.equal(sessions[0].repository, '/repo'); assert.equal(sessions[0].workspaceLabel, 'isolated-task');
  assert.equal(directory.find('active').project, '/repo/.claude/worktrees/isolated-task');
});
test('name, machine, branch and recent question share case-insensitive multiword search', () => {
  const rows = [{ id: 'one', title: 'project-plugin-recommendations', machineId: 'mac', gitBranch: 'worktree-isolated-task', latestPrompt: '需要新建表吗', project: '/repo/mino_server', last: 10 }, { id: 'two', title: 'other', last: 20 }];
  for (const q of ['PROJECT-plugin', 'mac mino', 'isolated-task', '新建表']) assert.equal(searchSessions(rows, q)[0].id, 'one');
  assert.equal(searchSessions(rows)[0].id, 'two'); assert.equal(searchSessions([{ ...rows[0], running: true }, rows[1]])[0].id, 'one');
});
test('unavailable peers retain cached records without claiming they are running', async () => {
  let fail = false;
  const directory = createSessionDirectory({ selfId: () => 'self', local: () => [], peers: () => [{ id: 'mac', peer: { call: async () => { if (fail) throw Error('offline'); return [{ id: 'terminal', native: true, running: true }]; } } }] });
  await directory.list({ refresh: true }); fail = true;
  const result = await directory.list({ refresh: true });
  assert.deepEqual(result.unavailable, ['mac']); assert.equal(result.sessions[0].sourceUnavailable, true); assert.equal(result.sessions[0].running, false);
});
test('concurrent listing requests share refresh and do not recursively collect foreign checkpoints', async () => {
  let calls = 0;
  const directory = createSessionDirectory({ selfId: () => 'self', local: () => [], peers: () => [{ id: 'mac', peer: { call: async () => { calls++; await new Promise(r => setTimeout(r, 5)); return [{ id: 'foreign', machineId: 'elsewhere' }, { id: 'local', machineId: 'mac' }]; } } }] });
  const results = await Promise.all([directory.list({ refresh: true }), directory.list({ refresh: true })]);
  assert.equal(calls, 1); assert.deepEqual(results[0].sessions.map(s => s.id), ['local']);
});
test('native Claude session name, branch and working directory refresh after transcript changes', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-labels-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'user', cwd: '/repo', gitBranch: 'main' })+'\n');
  assert.equal(transcriptLabels(file).gitBranch, 'main');
  fs.appendFileSync(file, JSON.stringify({ type: 'agent-name', agentName: 'project-plugin-recommendations' })+'\n'+JSON.stringify({ type: 'assistant', cwd: '/repo/.claude/worktrees/isolated-task', gitBranch: 'worktree-isolated-task' })+'\n');
  assert.deepEqual(transcriptLabels(file), { sessionName: 'project-plugin-recommendations', cwd: '/repo/.claude/worktrees/isolated-task', gitBranch: 'worktree-isolated-task' });
});
