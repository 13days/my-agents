const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createRegistry } = require('../core/registry');
const { createSessionManager } = require('../core/session-manager');
const { createLocalHost } = require('../hosts/local');
const { createAuth } = require('../http/auth');

// A scripted engine: every turn answers with its prompt and finishes.
function fakeEngine(id, sessionId, opened) {
  return {
    id, meta: { label: id, short: id }, capabilities: { sessionId },
    validModel: () => true, owns: async sid => sid === 'existing-thread',
    async open(options) {
      opened.push(options);
      let current = '', ready;
      const realId = sessionId === 'discovered' ? options.sessionId || 'thread-from-cli' : options.sessionId;
      return {
        ready: new Promise(resolve => { ready = resolve; }),
        submit(turnId, input) {
          current = turnId;
          options.emit('turn', { id: turnId });
          ready(realId);
          setImmediate(() => { options.emit('text', { text: input.prompt }); options.emit('done', {}); current = ''; options.onIdle(); });
        },
        stop() { current = ''; options.onClosed(); }, close() { options.onClosed(); },
        respondPermission() {},
        get currentId() { return current; }, get pendingCount() { return 0; }, get busy() { return !!current; },
      };
    },
  };
}

function setup() {
  const opened = [], touched = [];
  const registry = createRegistry({ defaultEngine: 'assigned' });
  registry.addNode({ id: 'local', host: createLocalHost() });
  registry.register(fakeEngine('assigned', 'assigned', opened));
  registry.register(fakeEngine('discovered', 'discovered', opened));
  const manager = createSessionManager({
    registry, log: { warn() {} },
    history: { ownerOf: () => null, messages: () => ({ messages: [] }), touch: (id, patch) => touched.push([id, patch]) },
  });
  return { manager, registry, opened, touched };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('idle engine runs restart with a new model while keeping the same resumable conversation', async () => {
  const { manager, opened } = setup();
  const first = await manager.start({ sessionId: 'existing-thread', prompt: 'one', cwd: os.tmpdir(), model: 'model-one' });
  await settle();
  const second = await manager.start({ sessionId: first.sessionId, prompt: 'two', cwd: os.tmpdir(), model: 'model-two' });
  assert.equal(first.run.job.closed, true);
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.run.job.meta.model, 'model-two');
  assert.equal(opened[1].model, 'model-two');
  assert.equal(opened[1].resume, true);
  await settle(); manager.stop(second.sessionId);
});

test('assigned engines keep the requested id; events reach the job in order', async () => {
  const { manager, opened, touched } = setup();
  const { sessionId, run } = await manager.start({ prompt: 'hi', sessionId: 'aaaaaaaa-1111', cwd: os.tmpdir() });
  assert.equal(sessionId, 'aaaaaaaa-1111');
  assert.equal(opened[0].resume, false);
  await settle();
  assert.deepEqual(run.job.events.map(e => e.event), ['input', 'turn', 'text', 'done']);
  assert.equal(touched[0][1].engine, 'assigned');
  assert.equal(manager.busy(sessionId), false);
});

test('discovered engines start unknown ids fresh and alias the requested id', async () => {
  const { manager, opened } = setup();
  const { sessionId } = await manager.start({ engine: 'discovered', prompt: 'hi', sessionId: 'panel-temp-id', cwd: os.tmpdir() });
  assert.equal(opened[0].sessionId, '');
  assert.equal(sessionId, 'thread-from-cli');
  assert.equal(manager.resolveId('panel-temp-id'), 'thread-from-cli');
  assert.equal(manager.get('panel-temp-id').id, 'thread-from-cli');
});

test('input validation, unknown engines and bad directories are user errors', async () => {
  const { manager } = setup();
  await assert.rejects(manager.start({ prompt: '' }), { status: 400 });
  await assert.rejects(manager.start({ prompt: 'x', context: 'x'.repeat(12001) }), { status: 400 });
  await assert.rejects(manager.start({ prompt: 'x', engine: 'nope' }), { status: 400 });
  await assert.rejects(manager.start({ prompt: 'x', cwd: path.join(os.tmpdir(), 'missing-' + Date.now()) }), { status: 400 });
  assert.throws(() => manager.send('unknown-session', { prompt: 'x' }), { status: 409 });
});

test('stop closes the job; warnings land in the active turn only', async () => {
  const { manager } = setup();
  const { sessionId, run } = await manager.start({ prompt: 'hi', cwd: os.tmpdir() });
  manager.warn(sessionId, 'upstream 500');
  assert.equal(run.job.events.filter(e => e.event === 'warning').length, 1);
  assert.equal(manager.stop(sessionId), true);
  assert.equal(run.job.closed, true);
  assert.equal(manager.stop(sessionId), false);
});

test('registry rejects incomplete adapters and describes nodes', () => {
  const { registry } = setup();
  assert.throws(() => registry.register({ id: 'broken' }), /缺少/);
  assert.deepEqual(registry.describe(registry.get('assigned')).nodes.map(node => node.id), ['local']);
  assert.equal(registry.find('DISCOVERED').id, 'discovered');
});

test('auth: loopback needs no token but blocks foreign hosts and cross-site origins; remote binds need the token', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-'));
  const local = createAuth({ port: 4321, dir });
  assert.equal(local.check({ headers: { host: 'localhost:4321' } }), '');
  assert.ok(local.check({ headers: { host: 'evil.example:4321' } }));
  assert.ok(local.check({ headers: { host: 'localhost:4321', origin: 'https://evil.example' } }));
  const remote = createAuth({ port: 4321, bindHost: '0.0.0.0', dir });
  assert.equal(remote.token, local.token, 'the token persists across restarts');
  assert.ok(remote.check({ headers: { host: 'dev-box:4321' } }));
  assert.equal(remote.check({ headers: { host: 'dev-box:4321', authorization: `Bearer ${remote.token}` } }), '');
  assert.equal(remote.check({ headers: { host: 'dev-box:4321', cookie: `my_agents_token=${remote.token}` } }), '');
  assert.equal((fs.statSync(path.join(dir, 'panel-token')).mode & 0o777).toString(8), '600');
  const loopback = { headers: { host: 'localhost:4321' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(remote.check(loopback), ''); assert.equal(remote.pageAllowed(loopback), true);
  assert.ok(remote.check({ ...loopback, socket: { remoteAddress: '10.1.2.3' } }));
  assert.ok(remote.check({ ...loopback, headers: { host: 'attacker.example:4321' } }));
  assert.doesNotThrow(() => remote.check({ headers: { host: 'dev-box:4321', authorization: 'Bearer ' + '中'.repeat(remote.token.length) } }));
});

test('fresh tasks open in their isolated directory and resume keeps its persisted directory', async () => {
  const { manager, registry, opened, touched } = setup();
  const host = registry.node('local').host;
  let creates = 0;
  const workspace = { cwd: os.tmpdir(), branch: 'my-agents/task-test', path: os.tmpdir(), repository: '/source' };
  host.createWorktree = async () => { creates++; return workspace; };
  const { sessionId, run } = await manager.start({ sessionId: 'isolated-new-thread', prompt: 'Task', cwd: os.tmpdir(), worktree: true });
  assert.equal(creates, 1); assert.equal(opened[0].cwd, workspace.cwd);
  assert.deepEqual(run.job.meta.worktree, workspace); assert.deepEqual(touched[0][1].worktree, workspace);
  manager.shutdown();
  const second = createSessionManager({ registry, history: { ownerOf: () => ({ engine: 'assigned', node: 'local', project: os.tmpdir(), worktree: workspace }), messages: () => null, touch() {} } });
  await second.start({ sessionId, prompt: 'Continue', cwd: '/missing-ignored-client-path', worktree: true });
  assert.equal(creates, 1); assert.equal(opened[1].cwd, fs.realpathSync(os.tmpdir())); second.shutdown();
});

test('shared mode and known CLI sessions never create a fresh worktree', async () => {
  const { manager, registry } = setup(); let creates = 0;
  registry.node('local').host.createWorktree = async () => { creates++; return null; };
  await manager.start({ sessionId: 'shared-new-thread', prompt: 'Shared', cwd: os.tmpdir(), worktree: false });
  await manager.start({ sessionId: 'existing-thread', prompt: 'Existing', cwd: os.tmpdir(), worktree: true });
  assert.equal(creates, 0); manager.shutdown();
});

test('older nodes give an actionable update error when isolation is requested', async () => {
  const { manager, registry, opened } = setup();
  registry.node('local').host.createWorktree = undefined;
  await assert.rejects(manager.start({ prompt: 'Task', cwd: os.tmpdir(), worktree: true }), error => error.status === 400 && /更新节点/.test(error.message));
  assert.equal(opened.length, 0); manager.shutdown();
});

test('a machine handoff creates a fresh native session and carries checkpoints without replaying previous commands', async () => {
  const {registry,opened}=setup();
  const manager=createSessionManager({registry,resolveLocation:()=>({machineId:'linux',node:'local',cwd:os.tmpdir(),handoff:{from:'mac',to:'linux',reason:'offline',previousSessionId:'existing-thread'}}),history:{ownerOf:()=>({engine:'assigned',machineId:'mac'}),messages:()=>({messages:[{role:'user',text:'Previous request'},{role:'assistant',text:'Previous result'}]}),touch(){}}});
  const result=await manager.start({sessionId:'existing-thread',prompt:'Continue with the next task'});
  assert.notEqual(result.sessionId,'existing-thread');assert.equal(opened[0].resume,false);assert.equal(result.run.job.meta.handoff.context,'checkpoint');
  await settle();assert.equal(result.run.job.events.filter(e=>e.event==='input').length,1);
  manager.shutdown();
});

test('model resolution pins a supported default at launch while preserving an explicit user model', async () => {
  const opened = [], registry = createRegistry({ defaultEngine: 'discovered' }); registry.addNode({ id: 'local', host: createLocalHost() }); registry.register(fakeEngine('discovered', 'discovered', opened));
  let resolutions = 0;
  const manager = createSessionManager({ registry, resolveModel: async () => { resolutions++; return 'account-recommended'; }, history: { ownerOf: () => null, messages: () => ({ messages: [] }), touch() {} } });
  await manager.start({ cwd: os.tmpdir(), prompt: 'first', engine: 'discovered' });
  assert.equal(opened[0].model, 'account-recommended');
  await new Promise(resolve => setImmediate(resolve));
  await manager.start({ cwd: os.tmpdir(), prompt: 'second', engine: 'discovered', model: 'chosen-explicitly' });
  assert.equal(opened[1].model, 'chosen-explicitly'); assert.equal(resolutions, 1);
  manager.closeAll?.();
});

test('workspace preparation is counted as busy before an engine has started', async () => {
 const {manager,registry}=setup();let release;registry.node('local').host.createWorktree=()=>new Promise(resolve=>release=resolve);
 const pending=manager.start({prompt:'prepare',cwd:os.tmpdir(),worktree:true});await settle();
 assert.equal(manager.preparing().length,1);assert.equal(manager.running().length,1);assert.equal(manager.preparing()[0].state,'preparing');
 release(null);const {sessionId}=await pending;assert.equal(manager.preparing().length,0);await settle();manager.stop(sessionId);
});

test('cancelling preparation prevents the engine from launching the first query', async () => {
 const {manager,registry,opened}=setup();registry.node('local').host.createWorktree=(_dir,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));
 const pending=manager.start({prompt:'must not run',sessionId:'cancel-before-launch',cwd:os.tmpdir(),worktree:true});await settle();assert.equal(manager.stop('cancel-before-launch'),true);
 await assert.rejects(pending,/cancelled/);assert.equal(opened.length,0);assert.equal(manager.running().length,0);
});

test('restart retains the newest native-session alias after repeated handoffs', t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'handoff-alias-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let tick=0;
 const store=require('../core/run-store').createRunStore({dir,now:()=>++tick});
 const old=store.begin({requestedId:'original-native',conversationId:'stable-conversation'},{messageId:'first-message'});store.update(old.id,{sessionId:'older-native',state:'completed'});
 const latest=store.begin({requestedId:'original-native',conversationId:'stable-conversation'},{messageId:'second-message'});store.update(latest.id,{sessionId:'newest-native',state:'completed'});
 const {registry}=setup(),manager=createSessionManager({registry,history:{},runStore:store});assert.equal(manager.resolveId('original-native'),'newest-native');
});
