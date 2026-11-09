const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createWorkspaces } = require('../core/workspaces');
function fixture(t, self = 'mac') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-workspaces-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const resolved = [];
  const hosts = { mac: { homeDir: () => '/Users/test', resolveDir: async value => { resolved.push(['mac', value]); if (!value.startsWith('/Users/')) throw Error('missing'); return value; } }, linux: { homeDir: () => '/home/test', resolveDir: async value => { resolved.push(['linux', value]); if (!value.startsWith('/home/')) throw Error('missing'); return value; } } };
  const store = createWorkspaces({ dir, selfId: () => self, machines: () => Object.keys(hosts).map(id => ({ id, label: id, online: true })), hostFor: id => hosts[id] });
  return { dir, store, hosts, resolved };
}
test('project mappings validate paths on their own machine and resolve after a leader move', async t => {
  const f = fixture(t, 'linux');
  await f.store.save({ defaults: { mac: '/Users/test/work', linux: '/home/test/work' }, projects: [{ id: 'app', name: 'App', paths: { mac: '/Users/test/app', linux: '/home/test/app' } }] });
  assert.deepEqual(f.resolved, [['mac','/Users/test/work'],['linux','/home/test/work'],['mac','/Users/test/app'],['linux','/home/test/app']]);
  assert.deepEqual(f.store.resolve({ machineId: 'mac', workspaceId: 'app' }), { machineId: 'mac', node: 'mac', cwd: '/Users/test/app' });
  assert.deepEqual(f.store.resolve({ machineId: 'linux', workspaceId: 'app' }), { machineId: 'linux', node: 'local', cwd: '/home/test/app' });
  assert.deepEqual(f.store.resolve({ machineId: 'linux' }, { machineId: 'mac', project: '/Users/test/app' }), { machineId: 'mac', node: 'mac', cwd: '/Users/test/app' });
});
test('foreign paths fail without rewriting or creating directories', async t => {
  const f = fixture(t);
  await assert.rejects(f.store.save({ defaults: { linux: '/Users/test/app' }, projects: [] }), /linux.*missing/);
  assert.deepEqual(f.store.read(), { defaults: {}, projects: [] });
});
test('an unchanged path can be retained while its machine is offline', async t => {
  const f = fixture(t);
  await f.store.save({ defaults: { linux: '/home/test' }, projects: [] });
  f.hosts.linux = null;
  await f.store.save({ defaults: { linux: '/home/test' }, projects: [] });
  await assert.rejects(f.store.save({ defaults: { linux: '/home/other' }, projects: [] }), /未连接/);
});
