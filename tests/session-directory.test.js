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
test('passive history reads use cached ownership without rescanning all local transcripts', async () => {
  let scans = 0;
  const directory = createSessionDirectory({ selfId: () => 'self', local: () => { scans++; return [{ id: 'local', native: true, project: '/local' }]; }, peers: () => [{ id: 'remote', peer: { call: async () => [{ id: 'other', native: true, project: '/remote' }] } }] });
  await directory.list(); const before = scans;
  assert.equal(directory.findCached('local').project, '/local'); assert.equal(directory.findCached('other').project, '/remote');
  assert.equal(directory.findCached('missing'), undefined); assert.equal(scans, before);
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


test('handoff follows the native worktree directory without changing recorded machine ownership', () => {
  const { liveSessionMetadata } = require('../core/session-directory');
  const meta = { machineId: 'mac', project: '/repo', engine: 'claude' };
  const item = { machineId: 'mac', project: '/repo/.claude/worktrees/task', native: true };
  assert.equal(liveSessionMetadata(meta, item).project, item.project);
  assert.equal(liveSessionMetadata(meta, { ...item, machineId: 'other' }), meta);
  assert.equal(liveSessionMetadata(meta, { ...item, sourceUnavailable: true }), meta);
});

test('legacy truncated image titles use the full native caption in the directory', () => {
  const marker = '<image name="[Image #1]" path="/private/local/file.png"></image>[Image #1]';
  const dir = createSessionDirectory({selfId:()=>'local',peers:()=>[],local:()=>[
    {id:'caption',title:marker.slice(0,40),latestPrompt:marker+' 请看这个问题'},
    {id:'image',title:marker.slice(0,40)},
    {id:'manual',title:'自己的名称',titleSource:'manual',latestPrompt:marker},
  ]});
  const rows = dir.snapshot();
  assert.equal(rows.find(r=>r.id==='caption').title,'请看这个问题');
  assert.equal(rows.find(r=>r.id==='image').title,'图片对话');
  assert.equal(rows.find(r=>r.id==='manual').title,'自己的名称');
  assert.doesNotMatch(JSON.stringify(rows),/private\/local/);
});

test('web listing can return local rows while a peer refresh is in flight', async () => {
  let finish;
  const dir = createSessionDirectory({
    selfId: () => 'local', local: () => { throw Error('synchronous scan'); },
    localList: async () => [{ id: 'local-row' }],
    peers: () => [{ id: 'remote', peer: { call: () => new Promise(resolve => { finish = resolve; }) } }],
  });
  const first = await dir.list({ cachedPeers: true });
  assert.deepEqual(first.sessions.map(row => row.id), ['local-row']);
  const refreshed = dir.list();
  finish([{ id: 'remote-row', native: true }]);
  assert.equal((await refreshed).sessions.length, 2);
  assert.equal(dir.findCached('remote-row').machineId, 'remote');
});

test('only explicit handoffs collapse into a conversation, keeping every stage and the current leaf', () => {
  const { sessionGroups } = require('../conversation-state');
  const base = { cwd: '/same', gitBranch: 'same', engine: 'claude', running: false };
  const old = { ...base, key: 'one', name: '原始问题', pinnedAt: 12, last: 200 };
  const middle = { ...base, key: 'two', previousSessionId: 'one', name: '继续', last: 100 };
  const head = { ...base, key: 'three', previousSessionId: 'two', name: '继续', running: true, last: 150 };
  const other = { ...base, key: 'four', name: '原始问题' };
  const grouped = sessionGroups([middle, other, head, old]);
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].key, 'three');
  assert.equal(grouped[0].name, '原始问题');
  assert.equal(grouped[0].pinKey, 'one');
  assert.equal(grouped[0].pinnedAt, 12);
  assert.equal(grouped[0].stages.length, 3);
  assert.equal(grouped[1], other);
  assert.equal(sessionGroups([{ ...head, titleSource: 'manual' }, middle, old])[0].name, '继续');
});
