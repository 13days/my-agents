const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os'), http = require('node:http');
const { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream');
const { createCodexProxy, codexCredentials, RELAY_TOKEN_ENV } = require('../engines/codex/proxy');
const { createCodexEngine } = require('../engines/codex');
const { createRegistry } = require('../core/registry');
const { createLocalHost } = require('../hosts/local');
const { createPeer } = require('../node/rpc');
const { pairTransports } = require('../node/transports');
const { serveNode } = require('../node/agent');
const { attachRemoteNode } = require('../node/remote');

const AUTH = { tokens: { access_token: 'mac-access', account_id: 'acct-1', refresh_token: 'never-sent' }, OPENAI_API_KEY: 'sk-mac' };

// A proxy whose upstream records the headers it was sent and answers 200.
async function proxyWith(relay, status = 200) {
  const sent = [];
  const https = { request(options, onResponse) {
    sent.push(options);
    const req = new PassThrough();
    req.setTimeout = () => {};
    req.on('finish', () => { const res = new PassThrough(); Object.assign(res, { statusCode: status, headers: { 'content-type': 'application/json' }, complete: true }); onResponse(res); res.end('{}'); });
    return req;
  } };
  const proxy = createCodexProxy({ request: { http, https }, relay });
  const server = http.createServer(proxy.handle);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { sent, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

test('the relay token is swapped for this machine\'s Codex login; other callers keep their own', async t => {
  let auth = AUTH;
  const p = await proxyWith({ token: 'relay-secret', credentials: mode => codexCredentials(auth, mode) });
  t.after(p.close);
  const post = (path, authorization) => fetch(p.url + path, { method: 'POST', headers: { authorization, 'session-id': 'thread-1' }, body: '{"model":"gpt"}' });

  assert.equal((await post('/backend-api/codex/responses', 'Bearer relay-secret')).status, 200);
  assert.equal(p.sent[0].headers.authorization, 'Bearer mac-access');
  assert.equal(p.sent[0].headers['chatgpt-account-id'], 'acct-1');
  assert.ok(!JSON.stringify(p.sent[0].headers).includes('never-sent'), 'the refresh token never leaves auth.json');

  assert.equal((await post('/codex-openai/v1/responses', 'Bearer relay-secret')).status, 200);
  assert.equal(p.sent[1].headers.authorization, 'Bearer sk-mac');

  assert.equal((await post('/backend-api/codex/responses', 'Bearer own-login')).status, 200);
  assert.equal(p.sent[2].headers.authorization, 'Bearer own-login', 'local Codex runs pass through untouched');
  assert.equal(p.sent[2].headers['chatgpt-account-id'], undefined);

  auth = {};
  const refused = await post('/backend-api/codex/responses', 'Bearer relay-secret');
  assert.equal(refused.status, 401);
  assert.match((await refused.json()).error.message, /未登录/);
  assert.equal(p.sent.length, 3);
});

test('a routed Codex session on a node uses the relay provider and token, not its own login', async t => {
  const spawned = [];
  const host = { ...createLocalHost(), spawn(cli, args, options) {
    spawned.push({ args, env: options.env });
    const child = new EventEmitter();
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
    setImmediate(() => { child.stdout.end(); child.emit('close', 0); child.emit('exit', 0); });
    return child;
  } };
  const engine = createCodexEngine({ sessions: { pathFor: () => '', provider: () => '' }, capture: () => ({ config: ['model_provider="local-capture"'] }), env: { ...process.env, CODEX_CLI: '/usr/bin/true' } });
  const [hubSide, nodeSide] = pairTransports();
  serveNode({ peer: createPeer(nodeSide), host, engines: [engine], id: 'devbox' });
  const registry = createRegistry({ defaultEngine: 'codex' });
  registry.addNode({ id: 'local', host: createLocalHost() });
  const route = Object.assign(() => ({ MY_AGENTS_CODEX_BASE: '/backend-api/codex', [RELAY_TOKEN_ENV]: 'relay-secret' }), { accounts: false });
  await attachRemoteNode({ peer: createPeer(hubSide), registry, routing: { target: 'http://127.0.0.1:9', engines: { codex: route } }, log: { warn() {} } });
  t.after(() => hubSide.close());
  const adapter = registry.adapter('codex', 'devbox');
  assert.equal(adapter.capabilities.capture, true);
  assert.equal(adapter.capabilities.accounts, false, 'Codex has no account picker');

  const noop = () => {};
  const session = await adapter.open({ emit: noop, onIdle: noop, onClosed: noop, cwd: os.tmpdir() });
  assert.equal(session.routed, true);
  session.submit('turn-1', { prompt: 'hi' });
  const until = async check => { const end = Date.now() + 2000; while (!check()) { if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 5)); } };
  await until(() => spawned.length);
  const { args, env } = spawned[0];
  const provider = args.find(arg => arg.startsWith('model_providers.panel='));
  assert.match(provider, /base_url="http:\/\/127\.0\.0\.1:\d+\/backend-api\/codex"/, 'Codex talks to the node-local relay');
  assert.match(provider, new RegExp(`env_key="${RELAY_TOKEN_ENV}",requires_openai_auth=false`));
  assert.ok(!args.includes('model_provider="local-capture"'), 'the node\'s own capture setting does not apply');
  assert.equal(env[RELAY_TOKEN_ENV], 'relay-secret');
  assert.ok(env.NO_PROXY.split(',').includes('127.0.0.1'));
});

test('Codex can use another panel login and fail over authentication rejections before streaming', async t => {
  const rejected = await proxyWith({ token: 'owner-a', credentials: mode => codexCredentials(AUTH, mode) }, 401);
  const accepted = await proxyWith({ token: 'owner-b', credentials: mode => codexCredentials(AUTH, mode) });
  const selected = [];
  const coordinator = await proxyWith({ token: 'coordinator', credentials: () => null, resolve: async (_mode, _session, excluded = []) => {
    selected.push(excluded);
    return excluded.includes('a') ? { id: 'b', url: accepted.url, token: 'owner-b' } : { id: 'a', url: rejected.url, token: 'owner-a' };
  } });
  t.after(() => { rejected.close(); accepted.close(); coordinator.close(); });
  const response = await fetch(coordinator.url + '/backend-api/codex/responses', { method: 'POST', headers: { authorization: 'Bearer coordinator', 'session-id': 'remote-thread' }, body: '{"model":"gpt"}' });
  assert.equal(response.status, 200); await response.text();
  assert.equal(coordinator.sent.length, 0, 'coordinator never needs an upstream login');
  assert.equal(rejected.sent.length, 1); assert.equal(accepted.sent.length, 1);
  assert.equal(accepted.sent[0].headers.authorization, 'Bearer mac-access');
  assert.equal(accepted.sent[0].headers['x-my-agents-local-account'], undefined);
  assert.deepEqual(selected, [[], ['a']]);
});
