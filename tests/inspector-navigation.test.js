const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');
async function port() { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value; }

test('Inspector API links legacy responses to their exact transcript and navigates every call type within the session', { timeout: 15000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-inspector-api-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sid = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
  const requestBody = JSON.stringify({ metadata: { user_id: 'account_session_' + sid }, model: 'haiku', stream: true, thinking: { type: 'adaptive' }, messages: [{ role: 'user', content: 'Your task is to create a detailed summary of the conversation so far.' }] });
  fs.writeFileSync(path.join(dir, 'panel-captures.jsonl'), [
    { id: 4, requestOrder: 4, ts: '2026-11-06T00:00:05Z', sessionId: sid, path: '/v1/messages/count_tokens', status: 200 },
    { id: 2, requestOrder: 2, ts: '2026-11-06T00:00:03Z', requestBody, path: '/v1/messages', status: 200 },
    { id: 3, engine: 'codex', requestOrder: 3, ts: '2026-11-06T00:00:04Z', sessionId: other, path: '/v1/models', status: 200 },
    { id: 1, ts: '2026-11-06T00:00:02Z', durationMs: 1000, respMsgId: 'legacy-response', path: '/v1/messages', status: 200 },
  ].map(rec => JSON.stringify(rec)).join('\n') + '\n');
  const projectDir = path.join(dir, 'projects', 'fixture'); fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, sid + '.jsonl'), [
    { type: 'user', sessionId: sid, cwd: dir, timestamp: '2026-11-06T00:00:00Z', message: { role: 'user', content: 'Primary session' } },
    { type: 'assistant', sessionId: sid, timestamp: '2026-11-06T00:00:01Z', message: { id: 'legacy-response', role: 'assistant', model: 'test', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'response' }] } },
  ].map(rec => JSON.stringify(rec)).join('\n') + '\n');
  const panelPort = await port(), proxyPort = await port();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, CLAUDE_DIR: dir, PORT: String(panelPort), PROXY_PORT: String(proxyPort), CCP_NO_PROXY_SETUP: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); } });
  await new Promise((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => reject(new Error(output)), 8000);
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('已启动')) { clearTimeout(timer); resolve(); } });
    child.stderr.on('data', chunk => { output += chunk; }); child.once('error', reject);
  });
  const base = `http://127.0.0.1:${panelPort}/api/inspector`;
  let list = await (await fetch(base)).json();
  assert.equal(list.items.length, 4); // The list is usable before legacy linking finishes.
  for (let attempt = 0; list.linking && attempt < 100; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 20));
    list = await (await fetch(base)).json();
  }
  assert.equal(list.linking, false);
  assert.deepEqual(list.items.map(item => item.key), ['4', '3', '2', '1']);
  assert.equal(list.items.find(item => item.key === '3').engine, 'codex');
  assert.equal(list.items.find(item => item.key === '1').engine, 'claude');
  assert.equal(list.items.find(item => item.key === '2').purpose, 'compaction');
  assert.equal(list.items.find(item => item.key === '1').sessionId, sid);
  const detail = await (await fetch(base + '/2')).json();
  assert.deepEqual(detail.navigation, { sessionId: sid, position: 2, total: 3, previousId: '1', nextId: '4', sessionTitle: 'Primary session' });
  const lightweight = await (await fetch(base + '/2/navigation')).json(); assert.deepEqual(lightweight.navigation, detail.navigation);
  assert.equal(lightweight.requestBody, undefined);
  assert.deepEqual(detail.requestPolicy, { stream: true, thinking: { type: 'adaptive' } });
  const isolated = await (await fetch(base + '/3')).json();
  assert.equal(isolated.navigation.total, 1); assert.equal(isolated.navigation.nextId, null); assert.equal(isolated.navigation.previousId, null);
});
