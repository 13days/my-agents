const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const portsUsed = new Set();
async function port() { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const value = server.address().port; await new Promise(resolve => server.close(resolve)); if (portsUsed.has(value)) return port(); portsUsed.add(value); return value; }
test('three real isolated server processes expose build identity and connect their execution runtimes', { timeout: 30000 }, async t => {
 const errors = [];
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-boot-')), children = [], ids = ['audit-a','audit-b','audit-c'], ports = await Promise.all(ids.map(port)), proxyPorts = await Promise.all(ids.map(port));
 t.after(async () => { await Promise.all(children.map(child => new Promise(resolve => { if (child.exitCode !== null || child.signalCode) return resolve(); const timer = setTimeout(() => child.kill('SIGKILL'), 5000); child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM'); }))); fs.rmSync(dir, { recursive: true, force: true }); });
 for (let i = 0; i < ids.length; i++) {
  const home = path.join(dir, ids[i]); fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'panel-cluster.json'), JSON.stringify({ clusterId: 'isolated-boot-audit', nodeId: ids[i], token: 'isolated-test-only', members: ids.map((id, n) => ({ id, url: `http://127.0.0.1:${ports[n]}`, voter: true })) }));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, MY_AGENTS_HOME: home, CLAUDE_DIR: path.join(home, 'claude'), CLAUDE_CONFIG_DIR: path.join(home, 'claude'), CODEX_HOME: path.join(home, 'codex'), MY_AGENTS_BIND: '127.0.0.1', MY_AGENTS_NO_PROXY_SETUP: '1', MY_AGENTS_BACKGROUND_SERVICE: '0', PORT: String(ports[i]), PROXY_PORT: String(proxyPorts[i]) }, stdio: ['ignore','ignore','pipe'] }); child.stderr.on('data', bytes => { const lines = bytes.toString().split('\n').filter(line => /集群执行连接|集群运行通道|ReferenceError|TypeError/.test(line)); errors.push(...lines); }); children.push(child);
 }
 let states;
 const deadline = Date.now() + 23000;
 while (Date.now() < deadline) {
  assert.ok(children.every(child => child.exitCode === null), 'isolated server exited during bootstrap');
  try {
   states = await Promise.all(ports.map(async port => { const response = await fetch(`http://127.0.0.1:${port}/api/cluster`, { signal: AbortSignal.timeout(1000) }); return response.json(); }));
   if (states.every(s => s.quorum?.online === 3 && s.hasQuorum && s.members.every(m => m.runtimeConnected && m.build?.protocolVersion === 2))) break;
  } catch {}
  await sleep(150);
 }
 assert.ok(states?.every(s => s.quorum?.online === 3 && s.hasQuorum && s.members.every(m => m.runtimeConnected && m.build?.protocolVersion === 2)), 'real cluster runtimes did not finish connecting: ' + JSON.stringify({ states: states?.map(s => ({node:s.nodeId,leader:s.leader,quorum:s.quorum,members:s.members?.map(m=>({id:m.id,runtime:m.runtimeConnected,build:m.build}))})),errors }));
 for (const port of ports) { const response = await fetch(`http://127.0.0.1:${port}/api/health`), health = await response.json(); assert.equal(health.ready, true); assert.equal(health.build.protocolVersion, 2); }
 assert.equal(new Set(states.map(s => s.leader)).size, 1); assert.ok(states.every(s => s.lease.clock === 'monotonic'));
});
