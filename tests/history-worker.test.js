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
