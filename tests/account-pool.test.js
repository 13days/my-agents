const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { createAccountPool } = require('../core/account-pool');
const { createRouter } = require('../proxy-router');
const { createAccountVault } = require('../core/account-vault');
const { fingerprint, accountId } = require('../core/codex-credentials');
const jwt = (iat, exp) => 'header.' + Buffer.from(JSON.stringify({ iat, exp })).toString('base64url') + '.sig';
const auth = (access = 'access-secret', refresh = 'refresh-secret') => ({ tokens: { account_id: 'same-user', access_token: access, refresh_token: refresh } });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-agents-shared-accounts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const nodes = new Map(); let connected = true;
  function add(id, localAuth = null, extras = {}) {
    const home = path.join(dir, id); fs.mkdirSync(home, { recursive: true });
    const router = createRouter({ dir: home, port: 54321 });
    let value = localAuth;
    const options = { dir: home, secret: 'shared-cluster-secret', identity: () => ({ id, label: id }), accounts: router,
      codex: { read: () => value, catalog: () => ({ modes: [], token: 'proxy-token' }), updated: (_old, fresh) => { value = fresh; } },
      peers: () => connected ? [...nodes].filter(([other]) => other !== id).map(([other, node]) => ({ id: other, peer: { call: async (method, input) => {
        if (method === 'accounts.key') return node.pool.exchangeKey();
        if (method === 'accounts.exchange') return node.pool.exchangeWire(input);
        if (method === 'accounts.refresh') return node.pool.refreshWire(input);
        throw Error('unknown method');
      } } })) : [],
      relayClient: () => ({ url: async () => 'http://127.0.0.1:54322' }), ...extras,
    };
    const node = { pool: createAccountPool(options), router, options, home, setAuth: v => { value = v; } }; nodes.set(id, node); return node;
  }
  return { add, disconnect: () => { connected = false; }, nodes, dir };
}

test('credentials replicate encrypted, survive owner loss and restart, and never appear in management responses', async t => {
  const f = fixture(t), owner = f.add('owner', auth()), worker = f.add('worker');
  owner.router.save({ mode: 'manual', selected: 'api', accounts: [{ id: 'api', name: 'Work', url: 'https://api.example.test', token: 'provider-secret', authType: 'bearer', enabled: true, modelMap: {} }] });
  await worker.pool.refresh();
  assert.equal(worker.router.status().accounts.length, 1);
  assert.equal(worker.router.exportAccounts().length, 0, 'shared credentials do not overwrite native account configuration');
  assert.ok(!JSON.stringify(worker.router.status()).includes('provider-secret'));
  assert.ok(!JSON.stringify(worker.pool.status()).includes('refresh-secret'));
  const bytes = fs.readFileSync(worker.pool.vault.file, 'utf8');
  for (const secret of ['provider-secret', 'access-secret', 'refresh-secret']) assert.ok(!bytes.includes(secret));
  assert.equal(fs.statSync(worker.pool.vault.file).mode & 0o777, 0o600);
  f.disconnect(); await worker.pool.refresh();
  assert.equal(worker.router.status().accounts[0].enabled, true);
  assert.equal(worker.pool.codexRoute('chatgpt').headers.authorization, 'Bearer access-secret');
  const reloaded = createAccountPool(worker.options);
  assert.equal(reloaded.codexRoute('chatgpt').headers.authorization, 'Bearer access-secret');
  assert.equal(worker.router.status().accounts.length, 1);
  assert.equal(reloaded.status().find(row => row.id === 'owner').online, false);
  assert.throws(() => createAccountVault({ dir: worker.home, secret: 'wrong-key', nodeId: 'worker' }), /无法解密/);
});

test('replicas retain concurrent imports and explicit deletion beats stale offline snapshots', async t => {
  const f = fixture(t), a = f.add('a', auth('shared')), b = f.add('b', auth('shared'));
  const account = (id, token) => ({ id, name: id, url: 'https://api.example.test', token, enabled: true, authType: 'bearer', modelMap: {} });
  a.router.save({ mode: 'manual', selected: 'one', accounts: [account('one', 'a-secret')] });
  b.router.save({ mode: 'manual', selected: 'two', accounts: [account('two', 'b-secret')] });
  await a.pool.refresh(); await b.pool.refresh();
  assert.equal(a.router.status().accounts.length, 2); assert.equal(b.router.status().accounts.length, 2);
  assert.equal(a.pool.codexRoute('chatgpt').accountId, b.pool.codexRoute('chatgpt').accountId, 'one ChatGPT account is deduplicated across machines');
  const stale = b.pool.vault.export();
  a.router.save({ mode: 'manual', selected: '', accounts: [] }); await b.pool.refresh();
  assert.equal(b.router.status().accounts.length, 1);
  b.pool.vault.merge(stale); await b.pool.refresh();
  assert.equal(b.router.status().accounts.length, 1, 'deleted account cannot return from an older replica');
  const bad = JSON.parse(JSON.stringify(stale)); bad.body = 'AAAA';
  assert.throws(() => b.pool.exchange(bad), /同步认证失败/);
});

test('one node login is used directly by another proxy after the source panel is disconnected', async t => {
  const upstream = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer api-key-shared-once');
    res.end('{"ok":true}');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const f = fixture(t), a = f.add('a'), b = f.add('b');
  // A public-looking hostname is routed to the local fake upstream by the test
  // router URL after replication; the source panel itself is never contacted.
  const originalRequest = http.request;
  http.request = function(options, ...args) { return originalRequest.call(this, options?.hostname === 'api.example.test' ? { ...options, hostname: '127.0.0.1' } : options, ...args); };
  t.after(() => { http.request = originalRequest; });
  a.router.save({ mode: 'manual', selected: 'api', accounts: [{ id: 'api', name: 'Shared', url: 'http://api.example.test:' + upstream.address().port, token: 'api-key-shared-once', authType: 'bearer', enabled: true, modelMap: {} }] });
  await b.pool.refresh(); f.disconnect(); await b.pool.refresh();
  const server = http.createServer(b.router.handle);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/v1/messages', { method: 'POST', body: '{"model":"test"}' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test('shared OAuth refresh is single-flight and rotated credentials survive a leader change', async t => {
  const f = fixture(t); let count = 0, leader = 'a';
  const old = auth(jwt(1, 2)), fresh = auth(jwt(Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000) + 3600), 'rotated-refresh');
  const a = f.add('a', old, { renew: async () => { count++; await new Promise(r => setTimeout(r, 10)); return fresh; }, coordination: { canRefresh: () => leader === 'a', required: () => 2 } });
  const b = f.add('b', null, { coordination: { canRefresh: () => leader === 'b', required: () => 2, refresh: input => a.pool.refreshWire(input) } });
  await b.pool.refresh();
  const [first, second] = await Promise.all([b.pool.resolveCodex('chatgpt', 'thread'), b.pool.resolveCodex('chatgpt', 'thread')]);
  assert.equal(count, 1); assert.equal(first.headers.authorization, 'Bearer ' + fresh.tokens.access_token); assert.equal(second.id, first.id);
  leader = 'b'; f.disconnect(); await b.pool.refresh();
  const reloaded = createAccountPool(b.options);
  assert.equal(reloaded.codexRoute('chatgpt').headers.authorization, first.headers.authorization);
  assert.equal(reloaded.vault.credential(accountId(old, 'chatgpt'), old).tokens.refresh_token, 'rotated-refresh');
});

test('a refresh lease blocks a second leader from consuming the same refresh token', async t => {
  const f = fixture(t), old = auth(jwt(1, 2)); let calls = 0;
  const a = f.add('a', old), b = f.add('b', null, { renew: async () => { calls++; return old; } });
  await b.pool.refresh();
  const id = accountId(old, 'chatgpt'); a.pool.vault.claim(id, Date.now() + 60000); b.pool.exchange(a.pool.vault.export());
  await assert.rejects(b.pool.refreshAtLeader({ id }), /其他节点正在刷新/); assert.equal(calls, 0);
});

test('OAuth renewal preserves rotated credentials and redacts rejected provider responses', async () => {
  const { renewCodex } = require('../core/codex-credentials');
  const old = auth('old-access', 'old-refresh');
  const fresh = await renewCodex(old, { fetchImpl: async (url, options) => {
    assert.equal(url, 'https://auth.openai.com/oauth/token');
    const input = JSON.parse(options.body); assert.equal(input.grant_type, 'refresh_token'); assert.equal(input.refresh_token, 'old-refresh');
    return { ok: true, json: async () => ({ access_token: 'new-access', refresh_token: 'new-refresh' }) };
  } });
  assert.equal(fresh.tokens.account_id, 'same-user'); assert.equal(fresh.tokens.refresh_token, 'new-refresh');
  assert.equal(old.tokens.refresh_token, 'old-refresh', 'never mutate the caller snapshot in place');
  await assert.rejects(renewCodex(old, { fetchImpl: async () => ({ ok: false, status: 401, json: () => ({ error: 'old-refresh' }) }) }), error => /HTTP 401/.test(error.message) && !error.message.includes('old-refresh'));
});

test('standalone credentials can be re-encrypted when the installation joins a cluster', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-agents-vault-migrate-'));t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const old = createAccountVault({ dir, secret: 'local-install-key', nodeId: 'machine' }); old.observe({ claude: [], codex: auth() });
  const joined = createAccountVault({ dir, secret: 'cluster-key', fallbackSecret: 'local-install-key', nodeId: 'machine' }); joined.observe({ claude: [], codex: auth('new-access') });
  const restarted = createAccountVault({ dir, secret: 'cluster-key', nodeId: 'machine' });
  assert.equal(restarted.origins().machine.payload.codex.tokens.access_token, 'new-access');
});

test('credential RPC payloads need the negotiated private key, not just the cluster bearer', () => {
  const { createAccountTransport } = require('../core/account-transport');
  const a = createAccountTransport('cluster-bearer'), b = createAccountTransport('cluster-bearer'), observer = createAccountTransport('cluster-bearer');
  const packet = a.seal({ refresh_token: 'private-refresh' }, b.publicKey);
  assert.equal(b.open(packet, a.publicKey).refresh_token, 'private-refresh');
  assert.throws(() => observer.open(packet, a.publicKey), /解密失败/);
  assert.throws(() => b.open({ ...packet, body: 'AAAA' }, a.publicKey), /解密失败/);
});

test('local bridge dependencies are marked separately from portable replicated API accounts', async t => {
  const f = fixture(t), a = f.add('a'), b = f.add('b');
  a.router.save({ mode: 'manual', selected: 'bridge', accounts: [{ id: 'bridge', name: 'TRAE', url: 'http://127.0.0.1:8790', token: 'local-bridge', authType: 'bearer', enabled: true, modelMap: {} }] });
  await b.pool.refresh(); assert.equal(b.router.status().accounts[0].requiresBridge, true);
  f.disconnect(); await b.pool.refresh();
  const row = b.router.status().accounts[0]; assert.equal(row.enabled, false); assert.match(row.unavailableReason, /本地桥接服务/);
});

test('sequential subscription logins accumulate in one pool and sync to machines without those logins', async t => {
  const f = fixture(t), one = auth('first-token'), two = { tokens: { account_id: 'second-subscriber', access_token: 'second-token', refresh_token: 'second-refresh' } };
  const a = f.add('a', one), b = f.add('b'); await b.pool.refresh();
  a.setAuth(two); await a.pool.refresh(); await b.pool.refresh();
  assert.equal(a.pool.codexStatus().accounts.length, 2); assert.equal(b.pool.codexStatus().accounts.length, 2);
  const firstId = accountId(one, 'chatgpt'); b.pool.configureCodex(firstId, { name: 'First subscription', enabled: false }); await a.pool.refresh();
  assert.equal(a.pool.codexStatus().accounts.find(row => row.id === firstId).enabled, false);
  b.pool.configureCodex(firstId, { deleted: true }); await a.pool.refresh();
  a.setAuth(one); await a.pool.refresh(); assert.equal(a.pool.codexStatus().accounts.length, 1, 'an old native login cannot resurrect a removed pool account');
  f.disconnect(); const restarted = createAccountPool(b.options); assert.equal(restarted.codexStatus().accounts.length, 1);
});

test('session stickiness survives pool growth, with explicit pins and shared quota cooldowns', async t => {
  const f = fixture(t), a = f.add('a', auth()), b = f.add('b'); await b.pool.refresh();
  const first = a.pool.codexRoute('chatgpt', 'saved-thread'); a.pool.accepted(first, 'saved-thread');
  a.pool.importCodex({ tokens: { account_id: 'another-user', access_token: 'another-token' } }, 'Second');
  const second = a.pool.codexStatus().accounts.find(row => row.id !== first.accountId);
  assert.equal(a.pool.codexRoute('chatgpt', 'saved-thread').accountId, first.accountId);
  a.pool.pinCodex('saved-thread', second.id); assert.equal(a.pool.codexRoute('chatgpt', 'saved-thread', [], first.accountId).accountId, second.id);
  a.pool.pinCodex('saved-thread', ''); a.pool.setRouting({ mode: 'manual', selected: second.id });
  assert.equal(a.pool.codexRoute('chatgpt', 'saved-thread', [], first.accountId).accountId, second.id);
  a.pool.setRouting({ mode: 'round-robin', selected: '' }); a.pool.rejected(first, 429, '120'); await b.pool.refresh();
  assert.equal(b.pool.codexRoute('chatgpt', 'new-thread').accountId, second.id);
  assert.equal(b.pool.codexStatus().accounts.find(row => row.id === first.accountId).lastStatus, 429);
  assert.ok(!JSON.stringify(b.pool.codexStatus()).includes('another-token'));
});

test('an upgrade retains a cached subscription when the native login changed while the panel was stopped', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-agents-codex-retain-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const old = createAccountVault({ dir, secret: 'secret', nodeId: 'machine' }); old.observe({ label: 'machine', claude: [], codex: auth() });
  const router = createRouter({ dir, port: 54321 });
  const pool = createAccountPool({ dir, secret: 'secret', identity: () => ({ id: 'machine', label: 'machine' }), accounts: router, peers: () => [], codex: { read: () => ({ tokens: { account_id: 'next-subscription', access_token: 'next-access' } }), catalog: () => ({ modes: [] }) } });
  assert.equal(pool.codexStatus().accounts.length, 2);
});
