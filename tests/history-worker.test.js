const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { createHistoryWorker } = require('../history-worker');

test('history worker coalesces reads and never starts a duplicate HTTP server or proxy', { timeout: 15000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-agents-history-worker-'));
  const occupied = http.createServer((req, res) => res.end('main service'));
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  const port = String(occupied.address().port);
  const project = path.join(dir, 'projects', 'demo'); fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, '11111111-1111-4111-8111-111111111111.jsonl'), JSON.stringify({ type: 'user', timestamp: '2026-11-07T00:00:00Z', message: { role: 'user', content: 'Hello' } }) + '\n');
  const worker = createHistoryWorker(path.join(__dirname, '../server.js'), { env: { ...process.env, MY_AGENTS_HOME: dir, MY_AGENTS_BIND: '127.0.0.1', CLAUDE_DIR: dir, CODEX_HOME: path.join(dir, 'codex'), PORT: port, PROXY_PORT: port, MY_AGENTS_NO_PROXY_SETUP: '1' } });
  t.after(async () => { await worker.close(); await new Promise(resolve => occupied.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const first = worker.read('stats'); assert.equal(worker.read('stats'), first);
  const stats = await first; assert.equal(stats.totalSessions, 1);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'main service');
  const counts = await worker.read('usage'); assert.deepEqual(Object.keys(counts), ['commands', 'skills', 'agents', 'workflows']);
  await assert.rejects(worker.read('unknown'), /Unknown history operation/);
  assert.equal((await worker.read('stats')).totalSessions, 1);
});

test('session previews count transcript sends for both engines without relying on history index totals', { timeout: 15000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-agents-preview-worker-'));
  const sid = '11111111-1111-4111-8111-111111111111', cid = '22222222-2222-4222-8222-222222222222';
  const project = path.join(dir, 'projects', 'demo'); fs.mkdirSync(project, { recursive: true });
  const fp = path.join(project, sid + '.jsonl');
  const rows = [
    { type: 'user', timestamp: '2026-11-01T01:00:00Z', message: { content: 'First user question' } },
    { type: 'assistant', timestamp: '2026-11-01T01:00:01Z', message: { content: [{ type: 'tool_use', id: 'tool1', name: 'Read', input: {} }] } },
    { type: 'user', timestamp: '2026-11-01T01:00:02Z', message: { content: [{ type: 'tool_result', tool_use_id: 'tool1', content: 'tool output' }] } },
    { type: 'user', timestamp: '2026-11-02T01:00:00Z', message: { content: 'Second user question' } },
  ];
  fs.writeFileSync(fp, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const codex = path.join(dir, 'codex'), rollout = path.join(codex, 'sessions', '2026', '11', '01'); fs.mkdirSync(rollout, { recursive: true });
  fs.writeFileSync(path.join(rollout, `rollout-demo-${cid}.jsonl`), [
    { timestamp: '2026-11-01T01:00:00Z', type: 'session_meta', payload: { cwd: '/project' } },
    { timestamp: '2026-11-01T01:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions\ncontext' }] } },
    { timestamp: '2026-11-01T01:00:02Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Real Codex question' }] } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const worker = createHistoryWorker(path.join(__dirname, '../server.js'), { env: { ...process.env, CLAUDE_DIR: dir, CODEX_HOME: codex, MY_AGENTS_HOME: path.join(dir, 'panel'), MY_AGENTS_NO_PROXY_SETUP: '1' } });
  t.after(async () => { await worker.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const items = [{ id: sid, engine: 'claude', last: 1 }, { id: cid, engine: 'codex', last: 1 }, { id: 'missing-session', engine: 'claude' }];
  const previews = await worker.read('sessionPreviews', items);
  assert.equal(previews[0].turns, 2); assert.equal(previews[1].turns, 1); assert.equal(previews[2].turns, null);
  assert.equal(previews[0].createdAt, Date.parse('2026-11-01T01:00:00Z'));
  assert.equal((await worker.read('sessionUserPage', { item: items[0], page: 0 })).messages.length, 2);
  fs.appendFileSync(fp, JSON.stringify({ type: 'user', timestamp: '2026-11-03T01:00:00Z', message: { content: 'Third question' } }) + '\n');
  assert.equal((await worker.read('sessionPreviews', [{ ...items[0], last: 2 }]))[0].turns, 3);
});

test('search finds visible Claude and Codex questions and answers, including later appends', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-search-'));
  const claude = path.join(dir, 'projects', 'sample'), codex = path.join(dir, 'codex'), panel = path.join(dir, 'panel');
  fs.mkdirSync(claude, { recursive: true }); fs.mkdirSync(path.join(codex, 'sessions'), { recursive: true });
  fs.mkdirSync(panel);
  const claudeId = '11111111-1111-4111-8111-111111111111', codexId = '22222222-2222-4222-8222-222222222222';
  const append = (file, row) => fs.appendFileSync(file, JSON.stringify(row) + '\n');
  const claudeFile = path.join(claude, claudeId + '.jsonl'), rollout = path.join(codex, 'sessions', 'rollout-' + codexId + '.jsonl');
  append(claudeFile, { type: 'user', message: { content: 'Blue：需要更新吗？' } });
  append(claudeFile, { type: 'assistant', message: { content: [{ type: 'text', text: '已经更新 BLUE 版本' }] } });
  append(claudeFile, { type: 'user', message: { content: [{ type: 'tool_result', content: 'blue' }] } });
  append(claudeFile, { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'blue' }] } });
  const codexRow = (role, text) => ({ type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] });
  append(rollout, { type: 'session_meta', payload: { cwd: '/project' } });
  append(rollout, codexRow('user', 'Blue 旧格式提问'));
  append(rollout, { type: 'response_item', payload: codexRow('assistant', 'Blue 的\n完整回答') });
  append(rollout, codexRow('user', '# AGENTS.md instructions\nBlue'));
  append(rollout, { type: 'event_msg', payload: { type: 'agent_message', message: 'Blue 的完整回答' } });
  const worker = createHistoryWorker(path.join(__dirname, '../server.js'), { env: { ...process.env, CLAUDE_DIR: dir, CODEX_HOME: codex, MY_AGENTS_HOME: panel } });
  t.after(async () => { await worker.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const search = (q, engine = 'all') => worker.read('search', { q, engine });
  assert.deepEqual((await search('blue')).map(hit => [hit.engine, hit.role]), [
    ['codex', 'assistant'], ['codex', 'user'], ['claude', 'assistant'], ['claude', 'user'],
  ]);
  const harnessId = 'df3f1e35-ec3e-41a8-8c54-372ccc13b336';
  fs.writeFileSync(path.join(panel, 'panel-conversations.json'), JSON.stringify({
    [harnessId]: { id:harnessId, engine:'deepseek', project:'/harness', messages:[{role:'assistant',text:'Harness checkpoint note',timestamp:'2026-11-04T01:00:00Z'}] },
  }));
  const [harness] = await search('checkpoint', 'deepseek');
  assert.equal(harness.session, harnessId); assert.equal(harness.project, '/harness');
  assert.equal((await search('checkpoint'))[0].engine,'deepseek');
  const [reply] = await search('完整 blue', 'codex');
  assert.equal(reply.session, codexId); assert.equal(reply.project, '/project'); assert.match(reply.snippet, /完整回答/);
  append(rollout, codexRow('user', '新增的后续问题'));
  assert.equal((await search('续'))[0].session, codexId);
  fs.writeFileSync(path.join(panel, 'panel-sessions.json'), JSON.stringify({ [claudeId]: { deleted: true } }));
  assert.equal((await search('更新', 'claude')).length, 0);
});

test('global search merges peers by message time, deduplicates replicas and pages past the first 80 hits', async () => {
  const { searchMachines } = require('../core/transcript-search');
  const hit = n => ({ key: String(n).padStart(5, '0'), session: 'session', role: 'assistant' });
  const source = (id, rows) => ({ id, search: async ({ before }) => rows.filter(r => !before || r.key < before).slice(0, 81) });
  const rows = Array.from({ length: 170 }, (_, i) => hit(170 - i));
  const sources = [source('a', rows.filter((_, i) => i % 2 === 0)), source('b', rows.slice(1)), { id: 'offline', search: () => Promise.reject(Error()) }];
  let next, results = [];
  do {
    const page = await searchMachines(sources, { q: '示例', before: next });
    assert.deepEqual(page.unavailable, ['offline']);
    results.push(...page.results); next = page.next;
  } while (next);
  assert.deepEqual(results.map(row => row.key), rows.map(row => row.key));
});
