const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { createCluster } = require('../core/cluster');

const sleep = ms => new Promise(r => setTimeout(r, ms));
function mesh(ids) {
  const handlers = new Map(ids.map(id => [id, new Map()]));
  const blocked = new Set();
  return Object.fromEntries(ids.map(id => [id, {
    start() {}, stop() {}, connected: () => ids.filter(other => other !== id && !blocked.has([id, other].sort().join(':'))),
    handle(method, fn) { handlers.get(id).set(method, fn); },
    async call(other, method, params) { if (blocked.has([id, other].sort().join(':'))) throw new Error('partition'); const fn = handlers.get(other).get(method); if (!fn) throw new Error('missing handler'); return fn(id, params); },
    async broadcast(method, params) { return Promise.allSettled(ids.filter(other => other !== id).map(async other => ({ id: other, value: await this.call(other, method, params) }))); },
    block(other) { blocked.add([id, other].sort().join(':')); }, unblock(other) { blocked.delete([id, other].sort().join(':')); },
  }]));
}
function fixture(spec) {
  const ids = spec.map(x => x.id), networks = mesh(ids), gateways = {}, clusters = {}, dirs = {};
  for (const member of spec) {
    const gateway = gateways[member.id] = { active: false, starts: 0, reloads: 0, async start() { this.active = true; this.starts++; }, async stop() { this.active = false; }, async reload() { this.reloads++; } };
    const dir = dirs[member.id] = fs.mkdtempSync(path.join(os.tmpdir(), `cluster-${member.id}-`));
    clusters[member.id] = createCluster({ dir, config: { clusterId: 'c', nodeId: member.id, members: spec }, network: networks[member.id], gateway, heartbeatMs: 30, electionMinMs: 60, leaseMs: 100, random: () => ids.indexOf(member.id) / 10 });
  }
  return { clusters, gateways, networks, dirs };
}

test('three voters elect exactly one Feishu gateway leader', async t => {
  const f = fixture([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  t.after(() => Promise.all(Object.values(f.clusters).map(c => c.stop())));
  await Promise.all(Object.values(f.clusters).map(c => c.start())); await sleep(260);
  assert.equal(Object.values(f.gateways).filter(g => g.active).length, 1);
  assert.equal(Object.values(f.clusters).filter(c => c.status().role === 'leader').length, 1);
});

test('minority partition is fenced while majority keeps one leader', async t => {
  const f = fixture([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  t.after(() => Promise.all(Object.values(f.clusters).map(c => c.stop())));
  await Promise.all(Object.values(f.clusters).map(c => c.start())); await sleep(220);
  const leader = Object.keys(f.clusters).find(id => f.clusters[id].status().role === 'leader');
  for (const other of Object.keys(f.clusters).filter(id => id !== leader)) f.networks[leader].block(other);
  await sleep(260);
  assert.equal(f.gateways[leader].active, false, 'isolated old leader is fenced');
  assert.equal(Object.values(f.gateways).filter(g => g.active).length, 1, 'majority elects one replacement');
});

test('two panels without a witness do not advertise automatic failover', async t => {
  const f = fixture([{ id: 'a' }, { id: 'b' }]);
  t.after(() => Promise.all(Object.values(f.clusters).map(c => c.stop())));
  await Promise.all(Object.values(f.clusters).map(c => c.start())); await sleep(180);
  assert.equal(f.clusters.a.status().automaticFailover.enabled, false);
  f.networks.a.block('b'); await sleep(220);
  assert.equal(Object.values(f.gateways).filter(g => g.active).length, 0);
});

test('two panels plus witness keep automatic failover and witness never starts gateway', async t => {
  const f = fixture([{ id: 'a' }, { id: 'b' }, { id: 'w', witness: true }]);
  t.after(() => Promise.all(Object.values(f.clusters).map(c => c.stop())));
  await Promise.all(Object.values(f.clusters).map(c => c.start())); await sleep(220);
  assert.equal(f.clusters.a.status().automaticFailover.enabled, true);
  assert.equal(f.gateways.w.starts, 0);
});


test('the leader replicates versioned Feishu configuration and state', async t => {
  const f = fixture([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  t.after(() => Promise.all(Object.values(f.clusters).map(c => c.stop())));
  for (const dir of Object.values(f.dirs)) { fs.writeFileSync(path.join(dir, 'panel-feishu.json'), '{"enabled":true}'); fs.writeFileSync(path.join(dir, 'panel-feishu-state.json'), '{"bindings":{}}'); }
  await Promise.all(Object.values(f.clusters).map(c => c.start())); await sleep(220);
  const leader = Object.keys(f.clusters).find(id => f.clusters[id].status().role === 'leader');
  fs.writeFileSync(path.join(f.dirs[leader], 'panel-feishu-state.json'), '{"bindings":{"topic":{"id":"s"}}}');
  await sleep(140);
  for (const id of Object.keys(f.clusters).filter(id => id !== leader)) assert.match(fs.readFileSync(path.join(f.dirs[id], 'panel-feishu-state.json'), 'utf8'), /topic/);
});
