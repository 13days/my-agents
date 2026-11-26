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
  assert.deepEqual(f.store.resolve({ machineId: 'mac', workspaceId: 'app' }), { machineId: 'mac', node: 'mac', cwd: '/Users/test/app', workspaceId: 'app' });
  assert.deepEqual(f.store.resolve({ machineId: 'linux', workspaceId: 'app' }), { machineId: 'linux', node: 'local', cwd: '/home/test/app', workspaceId: 'app' });
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

test('offline execution follows the valid leader using project mappings; manual selection remains explicit', async t => {
  const f = fixture(t, 'linux');
  await f.store.save({ defaults: {}, projects: [{ id:'app',name:'App',paths:{mac:'/Users/test/app',linux:'/home/test/app'} }] });
  const store=createWorkspaces({dir:f.dir,selfId:()=> 'linux',machines:()=>[{id:'mac',online:false},{id:'linux',online:true}],hostFor:id=>f.hosts[id],leaderId:()=> 'linux'});
  const owner={machineId:'mac',project:'/Users/test/app'};
  const target=store.resolve({sessionId:'saved-session',machineId:'mac'},owner);
  assert.equal(target.machineId,'linux');assert.equal(target.cwd,'/home/test/app');assert.equal(target.handoff.reason,'offline');
  assert.throws(()=>store.resolve({machineId:'mac',allowFailover:false},owner),/离线/);
  assert.throws(()=>store.resolve({machineId:'mac'}, {...owner,worktree:{repository:'/Users/test/app',branch:'task'}}),/独立工作区/);
  assert.equal(store.resolve({switchMachine:true,machineId:'linux',workspaceId:'app'},owner).handoff.reason,'manual');
  assert.throws(()=>store.resolve({machineId:'mac'}, {...owner,project:'/Users/test/missing'}),/项目文件夹.*linux.*路径/);
});

test('new tasks share a stable default machine, explicit selections and existing conversations take precedence', async t => {
  const { dir, store, hosts } = fixture(t);
  const app = { id: 'app', name: 'App', paths: { mac: '/Users/test/app', linux: '/home/test/app' } };
  await store.save({ projects: [app], defaults: {} });
  await store.save({ defaultMachine: 'linux' });
  assert.equal(store.resolve({ workspaceId: 'app' }).cwd, '/home/test/app');
  assert.equal(store.resolve({ cwd: '/Users/test/app' }).cwd, '/home/test/app');
  assert.throws(() => store.resolve({ cwd: '/Users/test/unmapped' }), /明确指定执行机器/);
  assert.equal(store.resolve({ node: 'local' }).machineId, 'mac');
  assert.equal(store.resolve({}, { machineId: 'mac', project: '/Users/test/app' }).cwd, '/Users/test/app');
  await assert.rejects(store.save({ defaultMachine: 'missing' }), /执行机器/);
  await Promise.all([store.save({ projects: [app], previousProjects: [app] }), store.save({ directory: { machineId: 'linux', path: '/home/test/work' } })]);
  assert.deepEqual(store.read(), { projects: [app], defaults: { linux: '/home/test/work' }, defaultMachine: 'linux' });
  await assert.rejects(store.save({ projects: [], previousProjects: [] }), { status: 409 });
  assert.equal(createWorkspaces({ dir, selfId: () => 'mac', machines: () => [{ id: 'linux', online: true }], hostFor: id => hosts[id] }).resolve().cwd, '/home/test/work');
  await store.save({ defaultMachine: '' });
  assert.equal(store.resolve().machineId, 'mac');
});
