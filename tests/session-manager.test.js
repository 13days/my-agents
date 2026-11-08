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
