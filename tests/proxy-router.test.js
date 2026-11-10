'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRouter, parseEnvInput } = require('../proxy-router');
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(t, handlers) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-router-'));
  const servers = handlers.map(fn => http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    fn(req, res, Buffer.concat(chunks).toString());
  }));
  const urls = await Promise.all(servers.map(listen));
  const captures = []; let sequence = 0;
  const router = createRouter({ dir, port: 4322, record: (...args) => captures.push(args), reserveCapture: () => ({ id: ++sequence, startedAt: new Date().toISOString() }) });
  const proxy = http.createServer(router.handle);
  const url = await listen(proxy);
  t.after(async () => {
    for (const server of [...servers, proxy]) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const accounts = urls.map((url, i) => ({ id: `a${i}`, name: `Account ${i}`, url, token: `secret-${i}`, authType: 'bearer', enabled: true, modelMap: {} }));
  const send = (data = { model: 'claude-sonnet', messages: [] }, options = {}) => fetch(url + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer client-credential', 'x-api-key': 'old-client-key', ...options.headers }, body: JSON.stringify(data), signal: options.signal });
  return { dir, router, accounts, send, captures, url };
}

test('model discovery uses the pinned account, authenticates upstream, and caches results', async t => {
  // Explicit model env takes precedence over discovery; keep the host shell's values out of this test.
  for (const key of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL']) {
    if (!(key in process.env)) continue;
    const saved = process.env[key]; delete process.env[key];
    t.after(() => { process.env[key] = saved; });
  }
  const hits = [0, 0];
  const f = await fixture(t, [0, 1].map(index => (req, res) => {
    hits[index]++;
    assert.equal(req.url, '/v1/models');
    assert.equal(req.headers.authorization, `Bearer secret-${index}`);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: `auto/claude-haiku-${index + 5}-5` }] }));
  }));
  f.router.save({ mode: 'manual', selected: 'a0', accounts: f.accounts });
  const sid = '11111111-1111-4111-8111-111111111111';
  f.router.setSessionRoute(sid, 'a1');
  assert.equal((await f.router.modelEnvForSession(sid)).ANTHROPIC_DEFAULT_HAIKU_MODEL, 'auto/claude-haiku-6-5');
  assert.equal((await f.router.modelEnvForSession(sid)).ANTHROPIC_SMALL_FAST_MODEL, 'auto/claude-haiku-6-5');
  assert.deepEqual(hits, [0, 1]);
});
const reply = (req, res, raw) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ id: req.headers.authorization, model: JSON.parse(raw).model, apiKey: req.headers['x-api-key'] || null })); };
test('model picker discovers the selected or pinned account and shares its cache with defaults', async t => {
  const hits = [0, 0];
  const f = await fixture(t, [0, 1].map(index => (req, res) => {
    hits[index]++;
    assert.equal(req.headers.authorization, `Bearer secret-${index}`);
    res.end(JSON.stringify({ data: [{ id: `claude-sonnet-${index + 5}`, display_name: `Model ${index}` }, null, { id: 123 }] }));
  }));
  f.accounts[1].modelMap = { '*': 'fixed-model' };
  f.router.save({ mode: 'manual', selected: 'a0', accounts: f.accounts });
  const sid = '11111111-1111-4111-8111-111111111111';
  f.router.setSessionRoute(sid, 'a1');
  assert.deepEqual(await f.router.models({ sessionId: sid }), { accountName: 'Account 1', forcedModel: 'fixed-model', models: [{ id: 'claude-sonnet-6', name: 'Model 1' }] });
  const global = await f.router.models();
  assert.equal(global.models[0].id, 'claude-sonnet-5');
  await f.router.modelEnvForSession('');
  assert.deepEqual(hits, [1, 1]);
  await f.router.models({ accountId: 'a0', refresh: true });
  assert.deepEqual(hits, [2, 1]);
  await assert.rejects(f.router.models({ accountId: 'unknown' }), /账号不存在/);
  assert.doesNotMatch(JSON.stringify(global), /secret|token|http:/);
});

test('unavailable model discovery leaves manual/default selection usable', async t => {
  const f = await fixture(t, [(req, res) => { res.writeHead(503); res.end('unavailable'); }]);
  f.router.save({ mode: 'manual', selected: 'a0', accounts: f.accounts });
  assert.deepEqual((await f.router.models()).models, []);
});
test('manual switching applies to the next request, preserves hidden tokens and maps models', async t => {
  const f = await fixture(t, [reply, reply]);
  f.accounts[0].modelMap = { sonnet: 'gateway-sonnet' };
  f.router.save({ mode: 'manual', selected: 'a0', accounts: f.accounts });
  let result = await (await f.send()).json();
  assert.equal(result.id, 'Bearer secret-0'); assert.equal(result.apiKey, null); assert.equal(result.model, 'gateway-sonnet');
  const publicConfig = f.router.status();
  assert.ok(!JSON.stringify(publicConfig).includes('secret-'));
  f.router.save({ ...publicConfig, selected: 'a1' });
  result = await (await f.send()).json(); assert.equal(result.id, 'Bearer secret-1');
  assert.equal(fs.statSync(path.join(f.dir, 'panel-proxy.json')).mode & 0o777, 0o600);
  const restored = createRouter({ dir: f.dir, port: 4322 }); assert.equal(restored.status().selected, 'a1');
  assert.equal(f.captures[0][3].toString().includes('gateway-sonnet'), true);
  assert.equal(f.captures[0][9], 'Account 0');
});
test('rate limit fails over, honors cooldown, and reset clears it', async t => {
  let first = 0;
  const f = await fixture(t, [(req, res) => { first++; res.writeHead(429, { 'retry-after': '120' }); res.end('limited'); }, reply]);
  f.router.save({ mode: 'failover', accounts: f.accounts });
  assert.equal((await (await f.send()).json()).id, 'Bearer secret-1');
  assert.equal((await (await f.send()).json()).id, 'Bearer secret-1'); assert.equal(first, 1);
  assert.ok(f.router.status().accounts[0].cooldownUntil > Date.now() + 100000);
  f.router.reset(); await f.send(); assert.equal(first, 2);
});
test('manual mode returns upstream errors without trying another account', async t => {
  let second = 0;
  const f = await fixture(t, [(req, res) => { res.writeHead(429); res.end('limited'); }, (req, res) => { second++; res.end('unexpected'); }]);
  f.router.save({ mode: 'manual', selected: 'a0', accounts: f.accounts });
  const response = await f.send(); assert.equal(response.status, 429); assert.equal(await response.text(), 'limited'); assert.equal(second, 0);
});
test('round robin distributes requests and API key replaces client auth', async t => {
  const handler = (req, res) => res.end(JSON.stringify({ bearer: req.headers.authorization || null, apiKey: req.headers['x-api-key'] }));
  const f = await fixture(t, [handler, reply]); f.accounts[0].authType = 'api-key';
  f.router.save({ mode: 'round-robin', accounts: f.accounts });
  assert.deepEqual(await (await f.send()).json(), { bearer: null, apiKey: 'secret-0' });
  assert.equal((await (await f.send()).json()).id, 'Bearer secret-1');
  assert.deepEqual(await (await f.send()).json(), { bearer: null, apiKey: 'secret-0' });
});
test('streams deliver immediately and remain on the original account during a switch', async t => {
  let finish;
  const f = await fixture(t, [(req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {"type":"message_start"}\n\n'); finish = () => res.end('data: {"type":"message_stop"}\n\n'); }, reply]);
  f.router.save({ mode: 'manual', selected: 'a0', accounts: f.accounts });
  const response = await f.send(); const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /message_start/);
  f.router.save({ ...f.router.status(), selected: 'a1' }); finish();
  assert.match(new TextDecoder().decode((await reader.read()).value), /message_stop/);
  assert.equal((await (await f.send()).json()).id, 'Bearer secret-1');
});
test('setup backs up settings, preserves other keys and imports the old env', async t => {
  const f = await fixture(t, [reply]);
  const original = { permissions: { allow: ['Read'] }, model: 'custom', env: { OTHER_FLAG: 'keep', ANTHROPIC_BASE_URL: 'https://example.org', ANTHROPIC_AUTH_TOKEN: 'old-secret', ANTHROPIC_API_KEY: 'obsolete' } };
  fs.writeFileSync(path.join(f.dir, 'settings.json'), JSON.stringify(original));
  f.router.save({ mode: 'manual', selected: 'a0', accounts: f.accounts });
  const result = f.router.setup();
  assert.deepEqual(JSON.parse(fs.readFileSync(result.backup)), original);
  const current = JSON.parse(fs.readFileSync(path.join(f.dir, 'settings.json')));
  assert.deepEqual(current.permissions, original.permissions); assert.equal(current.model, 'custom'); assert.equal(current.env.OTHER_FLAG, 'keep');
  assert.equal(current.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4322'); assert.equal(current.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(f.router.status().accounts.length, 2); assert.ok(!JSON.stringify(f.router.status()).includes('old-secret'));
  const again = f.router.setup(); assert.equal(f.router.status().accounts.length, 2); assert.equal(again.alreadyConfigured, true); assert.equal(again.backup, null);
});
test('invalid config is rejected atomically and disabled accounts are never selected', async t => {
  const f = await fixture(t, [reply]);
  f.router.save({ mode: 'manual', selected: 'a0', accounts: f.accounts });
  assert.throws(() => f.router.save({ mode: 'manual', selected: 'a0', accounts: [{ ...f.accounts[0], url: 'http://localhost:4322' }] }));
  assert.throws(() => f.router.save({ mode: 'failover', accounts: [{ ...f.accounts[0], modelMap: [] }] }));
  assert.equal(f.router.status().accounts[0].url, f.accounts[0].url);
  f.router.save({ mode: 'failover', accounts: [{ ...f.accounts[0], enabled: false }] });
  assert.equal((await f.send()).status, 503);
});
test('ordinary request errors are not retried; cross-origin requests are blocked', async t => {
  let second = 0;
  const f = await fixture(t, [(req, res) => { res.writeHead(400); res.end('invalid request'); }, (req, res) => { second++; res.end(); }]);
  f.router.save({ mode: 'failover', accounts: f.accounts });
  assert.equal((await f.send()).status, 400); assert.equal(second, 0);
  assert.equal((await f.send(undefined, { headers: { origin: 'https://foreign.example' } })).status, 403);
});
test('connection errors fail over and do not leak credentials in errors', async t => {
  const f = await fixture(t, [reply]);
  const unused = http.createServer(); const deadURL = await listen(unused); await new Promise(r => unused.close(r));
  f.router.save({ mode: 'failover', accounts: [{ ...f.accounts[0], id: 'dead', url: deadURL }, ...f.accounts] });
  assert.equal((await (await f.send()).json()).id, 'Bearer secret-0');
  f.router.save({ mode: 'manual', selected: 'dead', accounts: [{ ...f.accounts[0], id: 'dead', url: deadURL }] });
  const response = await f.send(); assert.equal(response.status, 502); assert.ok(!(await response.text()).includes('secret-0'));
});

test('exhausted credits (402) trigger automatic failover', async t => {
  const f = await fixture(t, [(req, res) => { res.writeHead(402); res.end('credits exhausted'); }, reply]);
  f.router.save({ mode: 'failover', accounts: f.accounts });
  assert.equal((await (await f.send()).json()).id, 'Bearer secret-1');
  assert.equal(f.router.status().accounts[0].lastStatus, 402);
});

test('one click imports the current account from an empty state and connects Claude', async t => {
  const f = await fixture(t, [reply]);
  const original = { env: { ANTHROPIC_BASE_URL: f.accounts[0].url, ANTHROPIC_AUTH_TOKEN: 'initial-secret', ANTHROPIC_DEFAULT_SONNET_MODEL: 'mapped-sonnet', KEEP: 'keep' }, permissions: { allow: ['Read'] } };
  fs.writeFileSync(path.join(f.dir, 'settings.json'), JSON.stringify(original));
  assert.equal(f.router.status().accounts.length, 0);
  assert.equal(f.router.status().connection.canImport, true);
  const result = f.router.setup();
  const status = f.router.status();
  assert.equal(status.accounts.length, 1); assert.equal(status.selected, status.accounts[0].id);
  assert.equal(status.connection.connected, true); assert.equal(status.accounts[0].modelMap.sonnet, 'mapped-sonnet');
  assert.deepEqual(JSON.parse(fs.readFileSync(result.backup)), original);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'settings.json'))).env.KEEP, 'keep');
  assert.ok(!JSON.stringify(status).includes('initial-secret'));
  assert.equal(f.router.setup().alreadyConfigured, true); assert.equal(f.router.status().accounts.length, 1);
});
test('one click imports official API key without an explicit base URL', async t => {
  const f = await fixture(t, []);
  fs.writeFileSync(path.join(f.dir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'official-key' } }));
  f.router.setup(); const status = f.router.status();
  assert.equal(status.accounts[0].url, 'https://api.anthropic.com'); assert.equal(status.accounts[0].authType, 'api-key'); assert.equal(status.connection.connected, true);
});
test('setup without an API account leaves settings untouched, import deduplicates', async t => {
  const f = await fixture(t, [reply]);
  const file = path.join(f.dir, 'settings.json'); fs.writeFileSync(file, '{"permissions":{"allow":["Read"]}}');
  const original = fs.readFileSync(file, 'utf8'); assert.throws(() => f.router.setup()); assert.equal(fs.readFileSync(file, 'utf8'), original);
  fs.writeFileSync(file, JSON.stringify({ env: { ANTHROPIC_BASE_URL: f.accounts[0].url, ANTHROPIC_AUTH_TOKEN: 'same-token' } }));
  f.router.importSettings(); f.router.importSettings(); assert.equal(f.router.status().accounts.length, 1);
});

test('env parser supports full settings, env fragments and bare env with empty API key', () => {
  const env = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8790', ANTHROPIC_AUTH_TOKEN: 'ferry', ANTHROPIC_API_KEY: '', CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1', CLAUDE_CODE_AUTO_MODE_SERVER: '0' };
  for (const raw of [JSON.stringify({ env, permissions: {} }), '"env":' + JSON.stringify(env) + ',', JSON.stringify(env)]) {
    const parsed = parseEnvInput(raw); assert.deepEqual(parsed.env, env); assert.equal(parsed.token, 'ferry'); assert.equal(parsed.authType, 'bearer');
  }
  assert.throws(() => parseEnvInput('{broken secret-token'), error => !error.message.includes('secret-token'));
  assert.throws(() => parseEnvInput({ ANTHROPIC_AUTH_TOKEN: 'key', BAD: {} }));
});
test('full env persists securely, applies on selection and restores prior values when switching', async t => {
  const f = await fixture(t, [reply, reply]);
  const initial = { env: { EXISTING: 'preserve', CLAUDE_CODE_AUTO_MODE_SERVER: 'original' }, permissions: { allow: ['Read'] } };
  const file = path.join(f.dir, 'settings.json'); fs.writeFileSync(file, JSON.stringify(initial));
  const extra = { ANTHROPIC_BASE_URL: f.accounts[0].url, ANTHROPIC_AUTH_TOKEN: 'ferry', ANTHROPIC_API_KEY: '', CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1', CLAUDE_CODE_AUTO_MODE_SERVER: '0', CUSTOM_SECRET: 'hidden-custom-secret' };
  f.router.save({ mode: 'manual', selected: 'a0', accounts: [{ id: 'a0', name: 'Ferry', env: extra }, f.accounts[1]] });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir, 'panel-proxy.json'))).accounts[0].env, extra);
  f.router.setup(); let settings = JSON.parse(fs.readFileSync(file));
  assert.equal(settings.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, '1'); assert.equal(settings.env.CLAUDE_CODE_AUTO_MODE_SERVER, '0');
  assert.equal(settings.env.EXISTING, 'preserve'); assert.equal(settings.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4322');
  assert.equal(settings.env.CUSTOM_SECRET, 'hidden-custom-secret');
  const publicStatus = f.router.status(); assert.ok(!JSON.stringify(publicStatus).includes('hidden-custom-secret')); assert.ok(!JSON.stringify(publicStatus).includes('ferry'));
  assert.deepEqual(publicStatus.accounts[0].clientEnvKeys, ['CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY', 'CLAUDE_CODE_AUTO_MODE_SERVER', 'CUSTOM_SECRET']);
  const switched = f.router.save({ ...publicStatus, selected: 'a1' }); assert.equal(switched.restartRequired, true);
  settings = JSON.parse(fs.readFileSync(file)); assert.equal(settings.env.CLAUDE_CODE_AUTO_MODE_SERVER, 'original'); assert.equal(settings.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, undefined); assert.equal(settings.env.CUSTOM_SECRET, undefined);
  assert.equal(settings.env.EXISTING, 'preserve'); assert.deepEqual(settings.permissions, initial.permissions);
  const back = f.router.save({ ...f.router.status(), selected: 'a0' }); assert.equal(back.restartRequired, true);
  assert.equal(JSON.parse(fs.readFileSync(file)).env.CLAUDE_CODE_AUTO_MODE_SERVER, '0');
  assert.equal(f.router.save(f.router.status()).restartRequired, false);
});
test('editing a pasted account retains extra env and updates its credentials', async t => {
  const f = await fixture(t, [reply]);
  f.router.save({ mode: 'manual', selected: 'a0', accounts: [{ id: 'a0', name: 'Account', env: { ANTHROPIC_BASE_URL: f.accounts[0].url, ANTHROPIC_AUTH_TOKEN: 'old-token', FLAG: true } }] });
  const status = f.router.status(); status.accounts[0].token = 'new-token';
  f.router.save(status);
  const stored = JSON.parse(fs.readFileSync(path.join(f.dir, 'panel-proxy.json'))).accounts[0]; assert.equal(stored.env.FLAG, 'true'); assert.equal(stored.env.ANTHROPIC_AUTH_TOKEN, 'new-token');
  assert.equal((await (await f.send()).json()).id, 'Bearer new-token');
});

test('session pins route one session to its own account while others follow the global route', async t => {
  const f = await fixture(t, [reply, reply]);
  f.router.save({ mode: 'manual', selected: 'a0', accounts: f.accounts });
  const sid = '11111111-2222-4333-8444-555555555555';
  const body = id => ({ model: 'claude-sonnet', messages: [], metadata: { user_id: `user_abc_account__session_${id}` } });
  f.router.setSessionRoute(sid, 'a1');
  assert.equal((await (await f.send(body(sid))).json()).id, 'Bearer secret-1');
  assert.equal((await (await f.send(body('99999999-2222-4333-8444-555555555555'))).json()).id, 'Bearer secret-0');
  assert.equal((await (await f.send({ model: 'claude-sonnet', messages: [], metadata: { user_id: JSON.stringify({ session_id: sid }) } })).json()).id, 'Bearer secret-1');
  const live = f.router.sessions().items.find(s => s.id === sid);
  assert.equal(live.accountId, 'a1'); assert.equal(live.routeAccountId, 'a1'); assert.equal(live.running, false);
  assert.equal(createRouter({ dir: f.dir, port: 4322 }).sessions().routes[sid], 'a1');
  f.router.setSessionRoute(sid, '');
  assert.equal((await (await f.send(body(sid))).json()).id, 'Bearer secret-0');
  assert.throws(() => f.router.setSessionRoute(sid, 'missing'));
});

test('all API endpoints and full responses over 8 MB are captured, including failed failover attempts', async t => {
  const large = 'x'.repeat(8 * 1024 * 1024 + 123);
  const f = await fixture(t, [(req, res) => { res.writeHead(429); res.end('complete rate limit body'); }, (req, res) => { res.end(req.url.includes('/models') ? large : '{"ok":true}'); }]);
  f.router.save({ mode: 'failover', accounts: f.accounts });
  const response = await fetch(f.url + '/v1/models'); assert.equal((await response.text()).length, large.length);
  assert.equal(f.captures.length, 2);
  assert.equal(f.captures[0][0], '/v1/models'); assert.equal(f.captures[0][1], 429);
  assert.equal(f.captures[0][4].toString(), 'complete rate limit body');
  assert.equal(f.captures[1][4].length, large.length);
  assert.equal(f.captures[0][10].id, 1); assert.equal(f.captures[1][10].id, 2);
  assert.equal(f.captures[1][10].requestOrder, 1);
  assert.equal(f.captures[1][10].routing.attempt, 2);
  const count = await fetch(f.url + '/v1/messages/count_tokens', { method: 'POST', body: JSON.stringify({ model: 'haiku', messages: [] }) }); await count.text();
  assert.equal(f.captures.at(-1)[0], '/v1/messages/count_tokens');
});

test('arrival sequence stays stable when concurrent session requests complete in reverse order', async t => {
  let finishFirst, entered;
  const firstEntered = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, [(req, res, body) => {
    if (JSON.parse(body).tag === 'first') { finishFirst = () => res.end('{"id":"first"}'); entered(); }
    else res.end('{"id":"second"}');
  }]);
  f.router.save({ mode: 'manual', selected: 'a0', accounts: f.accounts });
  const sid = '11111111-1111-4111-8111-111111111111';
  const first = f.send({ tag: 'first', metadata: { user_id: 'account_session_' + sid }, model: 'opus' });
  await firstEntered;
  await (await f.send({ tag: 'second', metadata: { user_id: 'account_session_' + sid }, model: 'haiku' })).text();
  finishFirst(); await (await first).text();
  assert.deepEqual(f.captures.map(args => args[10].id), [2, 1]);
  assert.ok(f.captures.every(args => args[10].sessionId === sid));
});

test('a client disconnect before response headers is preserved as an interrupted attempt', async t => {
  let entered; const started = new Promise(resolve => { entered = resolve; });
  let disconnected; const closed = new Promise(resolve => { disconnected = resolve; });
  const f = await fixture(t, [(req, res) => { res.on('close', disconnected); entered(); }]);
  f.router.save({ mode: 'manual', selected: 'a0', accounts: f.accounts });
  const controller = new AbortController();
  const request = f.send({ model: 'opus', messages: [] }, { signal: controller.signal });
  const rejected = assert.rejects(request);
  await started; controller.abort(); await rejected;
  await closed;
  assert.equal(f.captures.length, 1);
  assert.equal(f.captures[0][1], 499);
  assert.equal(f.captures[0][10].incomplete, true);
});

test('a panel without local accounts routes via the owner pool and cannot forge owner selection', async t => {
  const owner = await fixture(t, [(req, res) => {
    assert.equal(req.headers.authorization, 'Bearer secret-0');
    assert.equal(req.headers['x-my-agents-account'], undefined, 'internal selector must never reach a provider');
    res.setHeader('content-type', 'application/json'); res.end('{"ok":true}');
  }]);
  owner.router.save({ mode: 'manual', selected: 'a0', accounts: owner.accounts });
  const user = await fixture(t, []);
  const catalog = owner.router.sharedCatalog();
  user.router.setShared([{ id: 'cluster:owner:a0', name: 'Owner account', url: owner.url, token: catalog.token, authType: 'bearer', modelMap: {}, enabled: true, shared: true, delegateAccount: 'a0' }]);
  assert.ok(user.router.clientEnv().ANTHROPIC_BASE_URL);
  assert.equal((await user.send()).status, 200);
  const forged = await fetch(owner.url + '/v1/messages', { method: 'POST', headers: { authorization: 'Bearer wrong', 'x-my-agents-account': 'a0' }, body: '{}' });
  assert.equal(forged.status, 403);
  user.router.route({ selected: 'cluster:owner:a0' });
  assert.equal(user.router.status().selected, 'cluster:owner:a0');
  assert.equal(JSON.parse(fs.readFileSync(path.join(user.dir, 'panel-proxy.json'))).accounts.length, 0, 'remote proxy tokens never enter local account storage');
  assert.equal((await user.send()).status, 200);
  assert.ok(!JSON.stringify(user.router.status()).includes(catalog.token));
});

test('an unconfigured panel fails over rejected shared accounts instead of requiring its own login', async t => {
  const f = await fixture(t, [(_req, res) => { res.writeHead(401); res.end('{"error":"expired"}'); }, (_req, res) => { res.end('{"ok":true}'); }]);
  f.router.setShared(f.accounts.map(a => ({ ...a, shared: true })));
  assert.equal((await f.send()).status, 200);
  assert.deepEqual(f.captures.map(row => row[1]), [401, 200]);
});

test('Claude subscription routes preserve native OAuth beta headers while replacing only credentials', async t => {
  const f=await fixture(t,[(req,res)=>{
    assert.equal(req.headers.authorization,'Bearer subscription-token');assert.equal(req.headers['x-api-key'],undefined);
    assert.match(req.headers['anthropic-beta'],/oauth-2025-04-20/);assert.match(req.headers['anthropic-beta'],/other-beta/);
    res.end('{"ok":true}');
  }]);
  f.router.setShared([{...f.accounts[0],id:'claude-sub:test',authType:'oauth',token:'subscription-token',shared:true,managed:true}]);
  const response=await f.send(undefined,{headers:{'anthropic-beta':'other-beta,oauth-2025-04-20'}});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true});
  assert.equal(JSON.stringify(f.router.status()).includes('subscription-token'),false);
});

test('an explicitly emptied subscription pool never falls back to a disabled native credential', async t=>{
 const f=await fixture(t,[]);f.router.requirePool(true);
 assert.ok(f.router.clientEnv()?.ANTHROPIC_AUTH_TOKEN);
 const response=await f.send();assert.equal(response.status,401);assert.match(await response.text(),/账号池/);
});

test('Anthropic proxy base URLs ending in /v1 do not duplicate the version segment',async t=>{
 const f=await fixture(t,[(req,res)=>{assert.equal(req.url,'/v1/messages');res.end('{"ok":true}');}]);
 f.accounts[0].url+='/v1';f.router.save({mode:'manual',selected:'a0',accounts:f.accounts});
 const response=await f.send();assert.equal(response.status,200);await response.text();
});
