const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createClusterNetwork } = require('../node/cluster-peer');
const until = async check => { const end = Date.now() + 3000; while (!check()) { if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 10)); } };

test('a different panel resumes an existing session on its original machine over the cluster link', async t => {
  const { serveNode } = require('../node/agent'), { attachRemoteNode } = require('../node/remote');
  const { createRegistry } = require('../core/registry'), { createSessionManager } = require('../core/session-manager');
  const members = [{ id: 'mac' }, { id: 'linux' }], servers = [], networks = [], opened = [];
  const registries = members.map(() => createRegistry({ defaultEngine: 'echo' }));
  for (const member of members) { const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); member.url = `http://127.0.0.1:${server.address().port}`; servers.push(server); }
  for (let index = 0; index < members.length; index++) {
    const id = members[index].id;
    const host = { id: 'local', platform: index ? 'linux' : 'darwin', homeDir: () => `/${id}`, resolveDir: dir => { if (dir !== `/${id}/project`) throw Error('wrong machine directory'); return dir; } };
    const engine = { id: 'echo', meta: { label: 'Echo' }, capabilities: { sessionId: 'assigned' }, detect: () => null, validModel: () => true, owns: async sid => id === 'mac' && sid === 'saved-session', async open(options) { opened.push({ id, ...options }); return { ready: Promise.resolve(options.sessionId), currentId: '', pendingCount: 0, busy: false, submit() { options.emit('text', { text: 'saved context on ' + id }); options.emit('done', {}); }, close: options.onClosed, stop: options.onClosed }; } };
    registries[index].addNode({ id: 'local', host }); registries[index].register(engine);
    const network = createClusterNetwork({ token: 'test-token', selfId: id, members, retryMs: 20, onPeer: (_, peer) => serveNode({ peer, host, engines: [engine], id }) });
    networks.push(network); servers[index].on('upgrade', (req, socket, head) => network.upgrade(req, socket, head));
  }
  t.after(() => { networks.forEach(network => network.stop()); servers.forEach(server => server.close()); });
  networks.forEach(network => network.start());
  await until(() => networks.every(network => network.connected().length === 1));
  await attachRemoteNode({ peer: networks[1].peer('mac'), registry: registries[1], transport: 'cluster' });
  const manager = createSessionManager({ registry: registries[1], resolveLocation: () => ({ machineId: 'mac', node: 'mac', cwd: '/mac/project' }), history: { ownerOf: () => null, messages: () => null, touch() {} } });
  t.after(() => manager.shutdown());
  const { run } = await manager.start({ engine: 'echo', sessionId: 'saved-session', machineId: 'mac', prompt: 'continue', cwd: '/mac/project' });
  await until(() => run.job.events.some(event => event.event === 'done'));
  assert.equal(opened[0].id, 'mac'); assert.equal(opened[0].resume, true); assert.equal(opened[0].cwd, '/mac/project');
  assert.equal(run.job.meta.machineId, 'mac');
  assert.match(run.job.events.find(event => event.event === 'text').data.text, /saved context on mac/);
});

test('panel cluster peers authenticate, discover identity and exchange RPC independently of engine nodes', async t => {
  const servers = [], networks = [], members = [{ id: 'a', url: '' }, { id: 'b', url: '' }];
  for (const member of members) { const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); member.url = `http://127.0.0.1:${server.address().port}`; servers.push(server); }
  for (let i = 0; i < 2; i++) { const network = createClusterNetwork({ token: 'shared-cluster-token', selfId: members[i].id, members, retryMs: 20 }); networks.push(network); servers[i].on('upgrade', (req, socket, head) => { if (!network.upgrade(req, socket, head)) socket.destroy(); }); }
  networks[1].handle('echo', (from, input) => ({ from, input }));
  t.after(() => { networks.forEach(n => n.stop()); servers.forEach(s => s.close()); });
  networks.forEach(n => n.start()); await until(() => networks[0].connected().includes('b'));
  assert.deepEqual(await networks[0].call('b', 'echo', { ok: true }), { from: 'a', input: { ok: true } });
});

test('members stay connected when only the reverse connection direction is reachable', async t => {
  const members = [{ id: 'a' }, { id: 'b' }], servers = [], networks = [];
  for (const member of members) { const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); member.url = `http://127.0.0.1:${server.address().port}`; servers.push(server); }
  for (let index = 0; index < members.length; index++) {
    const network = createClusterNetwork({ token: 'reverse-direction', selfId: members[index].id, members, retryMs: 20 });
    networks.push(network);
    servers[index].on('upgrade', (req, socket, head) => { if (index === 1) { socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n'); return; } network.upgrade(req, socket, head); });
  }
  t.after(() => { networks.forEach(network => network.stop()); servers.forEach(server => server.close()); });
  networks[0].handle('echo', (from, input) => ({ from, input }));
  networks.forEach(network => network.start());
  await until(() => networks.every(network => network.connected().length === 1));
  assert.deepEqual(await networks[1].call('a', 'echo', { alive: true }), { from: 'b', input: { alive: true } });
});
