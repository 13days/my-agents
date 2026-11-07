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
  const worker = createHistoryWorker(path.join(__dirname, '../server.js'), { env: { ...process.env, CLAUDE_DIR: dir, CODEX_HOME: path.join(dir, 'codex'), PORT: port, PROXY_PORT: port, MY_AGENTS_NO_PROXY_SETUP: '1' } });
  t.after(async () => { await worker.close(); await new Promise(resolve => occupied.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const first = worker.read('stats'); assert.equal(worker.read('stats'), first);
  const stats = await first; assert.equal(stats.totalSessions, 1);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'main service');
  const counts = await worker.read('usage'); assert.deepEqual(Object.keys(counts), ['commands', 'skills', 'agents', 'workflows']);
  await assert.rejects(worker.read('unknown'), /Unknown history operation/);
  assert.equal((await worker.read('stats')).totalSessions, 1);
});
