const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createClusterNetwork } = require('../node/cluster-peer');
const until = async check => { const end = Date.now() + 3000; while (!check()) { if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 10)); } };

test('panel cluster peers authenticate, discover identity and exchange RPC independently of engine nodes', async t => {
  const servers = [], networks = [], members = [{ id: 'a', url: '' }, { id: 'b', url: '' }];
  for (const member of members) { const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); member.url = `http://127.0.0.1:${server.address().port}`; servers.push(server); }
  for (let i = 0; i < 2; i++) { const network = createClusterNetwork({ token: 'shared-cluster-token', selfId: members[i].id, members, retryMs: 20 }); networks.push(network); servers[i].on('upgrade', (req, socket, head) => { if (!network.upgrade(req, socket, head)) socket.destroy(); }); }
  networks[1].handle('echo', (from, input) => ({ from, input }));
  t.after(() => { networks.forEach(n => n.stop()); servers.forEach(s => s.close()); });
  networks.forEach(n => n.start()); await until(() => networks[0].connected().includes('b'));
  assert.deepEqual(await networks[0].call('b', 'echo', { ok: true }), { from: 'a', input: { ok: true } });
});
