const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { createRegistry } = require('../core/registry');
const { createSessionManager } = require('../core/session-manager');
const { createLocalHost } = require('../hosts/local');
const { createPeer } = require('../node/rpc');
const { pairTransports, wsTransport } = require('../node/transports');
const { serveNode } = require('../node/agent');
const { attachRemoteNode } = require('../node/remote');
const { createNodeHub, remoteCommand } = require('../node/hub');

// An engine on the node that echoes prompts, with optional permission requests.
function echoEngine() {
  const opened = [];
  return {
    opened,
    id: 'echo', meta: { label: 'Echo', short: 'Echo' }, capabilities: { sessionId: 'discovered', steer: 'restart', permissions: 'none' },
    detect: () => ({ path: '/usr/bin/echo', version: '1.0' }),
    validModel: model => model === 'ok-model', owns: async id => id === 'thread-on-node',
    async open(options) {
      opened.push(options);
      let current = '', resolveReady; const responses = [];
      return {
        ready: new Promise(resolve => { resolveReady = resolve; }), responses,
        submit(turnId, input, steer, onAccept) {
          current = turnId; onAccept?.();
          options.emit('turn', { id: turnId });
          resolveReady(options.sessionId || 'thread-on-node');
          setImmediate(() => { options.emit('text', { text: 'echo:' + input.prompt }); options.emit('done', {}); current = ''; options.onIdle(); });
        },
        stop() { current = ''; options.onClosed(); }, close() { options.onClosed(); },
        respondPermission(id, behavior) { responses.push([id, behavior]); },
        get currentId() { return current; }, get pendingCount() { return 0; }, get busy() { return !!current; },
      };
    },
  };
}

async function connected() {
  const [hubSide, nodeSide] = pairTransports();
  const engine = echoEngine();
  serveNode({ peer: createPeer(nodeSide), host: createLocalHost(), engines: [engine], id: 'devbox', label: '云端开发机' });
  const registry = createRegistry({ defaultEngine: 'echo' });
  registry.addNode({ id: 'local', host: createLocalHost() });
  const hubPeer = createPeer(hubSide);
  const node = await attachRemoteNode({ peer: hubPeer, registry, log: { warn() {} } });
  const touched = [];
  const manager = createSessionManager({ registry, log: { warn() {} }, history: { ownerOf: () => null, messages: () => null, touch: (id, patch) => touched.push([id, patch]) } });
  return { registry, manager, node, engine, hubPeer, touched };
}
const until = async (check, ms = 2000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 5)); } };

test('a remote node registers proxy adapters and runs sessions through the same manager', async () => {
  const { registry, manager, node, engine, touched } = await connected();
  assert.equal(node.id, 'devbox');
  assert.equal(node.remote, true);
  assert.equal(registry.adapter('echo', 'local'), null);
  assert.equal(registry.describe(registry.get('echo')).nodes[0].label, '云端开发机');
  const { sessionId, run } = await manager.start({ engine: 'echo', node: 'devbox', prompt: 'hi', cwd: os.tmpdir(), model: 'bad model!' });
  assert.equal(sessionId, 'thread-on-node');
  assert.equal(touched[0][1].node, 'devbox');
  assert.equal(engine.opened[0].model, '', 'the node re-validates models');
  await until(() => run.job.events.some(e => e.event === 'done'));
  assert.deepEqual(run.job.events.map(e => e.event), ['input', 'turn', 'text', 'done']);
  assert.equal(run.job.events.find(e => e.event === 'text').data.text, 'echo:hi');
  await until(() => !manager.busy(sessionId));
  manager.send(sessionId, { prompt: 'again', mode: 'queue' });
  await until(() => run.job.events.filter(e => e.event === 'done').length === 2);
  assert.ok(run.job.events.some(e => e.event === 'input' && e.data.prompt === 'again'), 'accepted queued input is published');
});

test('remote errors keep their status; unknown nodes are user errors', async () => {
  const { manager } = await connected();
  await assert.rejects(manager.start({ engine: 'echo', node: 'devbox', prompt: 'x', cwd: '/definitely/missing/dir' }), { status: 400, message: /工作目录不存在/ });
  await assert.rejects(manager.start({ engine: 'echo', node: 'nowhere', prompt: 'x' }), { status: 400 });
});

test('losing the node ends its runs with an error and removes the node', async () => {
  const { registry, manager, hubPeer } = await connected();
  const { run } = await manager.start({ engine: 'echo', node: 'devbox', prompt: 'hi', cwd: os.tmpdir() });
  hubPeer.close();
  await until(() => run.job.closed);
  assert.ok(run.job.events.some(e => e.event === 'error' && /连接已断开/.test(e.data.error)));
  assert.equal(registry.node('devbox'), null);
  assert.equal(registry.has('echo'), false);
});

test('nodes dial the hub over WebSocket with the panel token', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
  const registry = createRegistry(); registry.addNode({ id: 'local', host: createLocalHost() });
  const hub = createNodeHub({ registry, token: 'secret-token', dir, log: { log() {}, warn() {} } });
  const server = http.createServer((req, res) => res.end());
  server.on('upgrade', (req, socket, head) => { if (!hub.upgrade(req, socket, head)) socket.destroy(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { hub.stop(); server.close(); });
  const WebSocket = require('ws'), url = `ws://127.0.0.1:${server.address().port}/api/nodes/connect`;

  const rejected = new WebSocket(url, { headers: { authorization: 'Bearer wrong' } });
  const status = await new Promise(resolve => { rejected.on('unexpected-response', (_, res) => resolve(res.statusCode)); rejected.on('error', () => resolve('error')); });
  assert.ok(status === 401 || status === 'error');

  const socket = new WebSocket(url, { headers: { authorization: 'Bearer secret-token' } });
  // Serve synchronously on open (as the daemon does): the hub says hello right away.
  await new Promise((resolve, reject) => { socket.on('open', () => { serveNode({ peer: createPeer(wsTransport(socket)), host: createLocalHost(), engines: [echoEngine()], id: 'ws-box' }); resolve(); }); socket.on('error', reject); });
  await until(() => registry.node('ws-box'));
  const listed = hub.list().find(node => node.id === 'ws-box');
  assert.equal(listed.transport, 'ws');
  assert.deepEqual(listed.engines.map(engine => engine.id), ['echo']);
  socket.close();
  await until(() => !registry.node('ws-box'));
});

test('SSH nodes are validated, saved, launched with the stdio command and retried', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ssh-'));
  const registry = createRegistry(); registry.addNode({ id: 'local', host: createLocalHost() });
  const spawned = [];
  const { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream');
  const spawnImpl = (cmd, args) => {
    const child = new EventEmitter();
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { child.stdout.end(); child.emit('exit', 255); } });
    spawned.push({ cmd, args, child });
    // Act as the remote `my-agents node --stdio`.
    const { streamTransport } = require('../node/transports');
    child.stdout.write('hello from a chatty login profile\n');
    serveNode({ peer: createPeer(streamTransport(child.stdin, child.stdout)), host: createLocalHost(), engines: [echoEngine()], id: 'whatever-the-node-says' });
    return child;
  };
  const hub = createNodeHub({ registry, token: 't', dir, spawnImpl, retryMs: 300, log: { log() {}, warn() {} } });
  assert.throws(() => hub.add({ id: 'bad id', ssh: 'me@box' }), { status: 400 });
  assert.throws(() => hub.add({ id: 'box', ssh: '-oProxyCommand=evil' }), { status: 400 });
  hub.add({ id: 'gpu-box', label: 'GPU 开发机', ssh: 'me@gpu.example' });
  assert.deepEqual(spawned[0].args.slice(-2), ['me@gpu.example', remoteCommand('my-agents node --stdio')]);
  await until(() => registry.node('gpu-box'));
  assert.equal(registry.node('gpu-box').label, 'GPU 开发机', 'saved SSH nodes keep the name they were added under');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'panel-nodes.json'), 'utf8')).nodes[0].ssh, 'me@gpu.example');
  spawned[0].child.stderr.write('[my-agents node] ready\n');
  spawned[0].child.kill();
  await until(() => !registry.node('gpu-box'));
  assert.match(hub.list().find(n => n.id === 'gpu-box').error, /连接已断开/, 'a dropped connection is not reported as the ready banner');
  await until(() => spawned.length === 2 && registry.node('gpu-box'), 3000);
  assert.ok(hub.remove('gpu-box'));
  hub.stop();
});

test('a message for a node between reconnects waits for it instead of failing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ensure-'));
  const registry = createRegistry(); registry.addNode({ id: 'local', host: createLocalHost() });
  const spawned = [];
  const { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream');
  const { streamTransport } = require('../node/transports');
  const spawnImpl = () => {
    const child = new EventEmitter();
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { child.stdout.end(); child.emit('exit', 255); } });
    spawned.push(child);
    serveNode({ peer: createPeer(streamTransport(child.stdin, child.stdout)), host: createLocalHost(), engines: [echoEngine()], id: 'x' });
    return child;
  };
  // The backoff is far longer than the test: only ensure() can bring the node back.
  const hub = createNodeHub({ registry, token: 't', dir, spawnImpl, retryMs: 60000, log: { log() {}, warn() {} } });
  hub.add({ id: 'devbox', ssh: 'me@devbox' });
  await until(() => registry.node('devbox'));
  spawned[0].kill();
  await until(() => !registry.node('devbox'));
  await hub.ensure('devbox', 3000);
  assert.ok(registry.node('devbox'), 'reconnected on demand');
  assert.equal(spawned.length, 2);
  await hub.ensure('unknown', 50);
  hub.stop();
});

test('the SSH command runs in the login shell and survives quoting', () => {
  const { execFileSync } = require('node:child_process');
  const command = `printf '%s|%s' "it's" '$HOME'`;
  assert.equal(execFileSync('/bin/sh', ['-c', remoteCommand(command)], { env: { SHELL: '/bin/sh', HOME: '/x', PATH: process.env.PATH }, encoding: 'utf8' }), "it's|$HOME");
});

test('the login profile cannot read the protocol stream', t => {
  const { execFileSync } = require('node:child_process');
  const shell = ['/bin/dash', '/usr/bin/dash', '/bin/zsh', '/usr/bin/zsh'].find(file => fs.existsSync(file));
  if (!shell) return t.skip('needs dash or zsh');
  // A profile that tries to read a password from stdin, like kinit, must get nothing.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-profile-'));
  for (const file of ['.profile', '.zshrc']) fs.writeFileSync(path.join(dir, file), 'read -r password; [ -z "$password" ] || echo "profile stole: $password" >&2\n');
  const output = execFileSync('/bin/sh', ['-c', remoteCommand('read -r line; echo "got: $line"')], { input: '{"hello":1}\n', env: { SHELL: shell, HOME: dir, ZDOTDIR: dir, ENV: path.join(dir, '.profile'), PATH: process.env.PATH }, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  assert.equal(output.trim(), 'got: {"hello":1}');
});

test('routed engines reach the hub proxy through the node link; others keep their own login', async t => {
  // Stands in for the panel proxy: checks the forwarded request and streams an answer.
  const seen = [];
  const proxy = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: a\n\n'); setTimeout(() => res.end('event: b\n\n'), 20);
    });
  });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  t.after(() => proxy.close());
  const [hubSide, nodeSide] = pairTransports();
  const routed = echoEngine(), plain = echoEngine(); plain.id = 'plain';
  serveNode({ peer: createPeer(nodeSide), host: createLocalHost(), engines: [routed, plain], id: 'devbox' });
  const registry = createRegistry({ defaultEngine: 'echo' });
  registry.addNode({ id: 'local', host: createLocalHost() });
  const asked = [];
  const routing = { target: `http://127.0.0.1:${proxy.address().port}`, engines: { echo: async options => { asked.push(options.accountId); return { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4322', ANTHROPIC_AUTH_TOKEN: 'local-token' }; } } };
  await attachRemoteNode({ peer: createPeer(hubSide), registry, routing, log: { warn() {} } });
  t.after(() => hubSide.close());
  assert.equal(registry.adapter('echo', 'devbox').capabilities.accounts, true);
  assert.equal(registry.adapter('plain', 'devbox').capabilities.accounts, false);

  const noop = () => {};
  const events = { emit: noop, onIdle: noop, onClosed: noop, cwd: os.tmpdir() };
  await registry.adapter('echo', 'devbox').open({ ...events, sessionId: 's1', accountId: 'acct-2' });
  await registry.adapter('plain', 'devbox').open({ ...events, sessionId: 's2' });
  assert.deepEqual(asked, ['acct-2']);
  assert.equal(plain.opened[0].routeEnv, null, 'engines without a hook are not routed');
  const env = routed.opened[0].routeEnv;
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'local-token');
  assert.match(env.ANTHROPIC_BASE_URL, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.notEqual(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4322', 'the base URL points at the node-local relay');
  assert.ok(env.NO_PROXY.split(',').includes('127.0.0.1') && env.no_proxy === env.NO_PROXY, 'an HTTP proxy in the shell cannot intercept the relay');

  const res = await fetch(env.ANTHROPIC_BASE_URL + '/v1/messages?beta=true', { method: 'POST', headers: { authorization: 'Bearer local-token', 'content-type': 'application/json' }, body: '{"model":"m"}' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  assert.equal(await res.text(), 'event: a\n\nevent: b\n\n');
  assert.deepEqual(seen, [{ method: 'POST', url: '/v1/messages?beta=true', auth: 'Bearer local-token', body: '{"model":"m"}' }]);

  proxy.close();
  await new Promise(r => setTimeout(r, 20));
  const down = await fetch(env.ANTHROPIC_BASE_URL + '/v1/messages', { method: 'POST', body: '{}' });
  assert.equal(down.status, 502, 'an unreachable panel proxy becomes an API error the CLI can show');
  assert.match((await down.json()).error.message, /面板代理不可用/);
});

test('the relay refuses paths that could leave the panel proxy', async () => {
  const { serveRelay } = require('../node/relay');
  const [a, b] = pairTransports();
  serveRelay({ peer: createPeer(a), target: 'http://127.0.0.1:9' });
  const node = createPeer(b);
  await assert.rejects(node.call('relay.request', { rid: 'x', method: 'GET', path: '//evil.example/x', headers: {}, body: '' }), /无效/);
  await assert.rejects(node.call('relay.request', { rid: 'x', method: 'GET', path: 'http://evil.example/', headers: {}, body: '' }), /无效/);
});

test('worktree creation is routed to the session node', async () => {
  const [hubSide, nodeSide] = pairTransports(), engine = echoEngine();
  const host = createLocalHost(); let directory;
  const workspace = { cwd: os.tmpdir(), branch: 'my-agents/task-remote', path: os.tmpdir(), repository: '/remote/repo' };
  host.createWorktree = async dir => { directory = dir; return workspace; };
  serveNode({ peer: createPeer(nodeSide), host, engines: [engine], id: 'worktree-node' });
  const registry = createRegistry({ defaultEngine: 'echo' }), peer = createPeer(hubSide);
  await attachRemoteNode({ peer, registry });
  const manager = createSessionManager({ registry, history: { ownerOf: () => null, messages: () => null, touch() {} } });
  try {
    const { run } = await manager.start({ node: 'worktree-node', prompt: 'Task', cwd: os.tmpdir(), worktree: true });
    assert.equal(directory, fs.realpathSync(os.tmpdir())); assert.deepEqual(run.job.meta.worktree, workspace);
    assert.equal(engine.opened[0].cwd, fs.realpathSync(workspace.cwd));
  } finally { manager.shutdown(); peer.close(); }
});

test('working directories typed in chat may start with ~ on the machine that runs the CLI', () => {
  assert.equal(createLocalHost().resolveDir('~'), fs.realpathSync(os.homedir()));
  assert.throws(() => createLocalHost().resolveDir('~/definitely-missing-dir-xyz'), { status: 400 });
});
