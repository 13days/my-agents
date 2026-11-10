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
        if (method === 'accounts.renew') return node.pool.renewWire(id, input);
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

test('Claude subscriptions are discovered on sign-in, remain pooled after another login and replicate without the origin', async t => {
  const f=fixture(t);let native={accountUuid:'claude-user-a',claudeAiOauth:{accessToken:'claude-token-a',refreshToken:'claude-refresh-a',expiresAt:Date.now()+3600000}};
  const a=f.add('a',null,{claude:{read:()=>native}}),b=f.add('b');
  assert.equal(a.pool.claudeStatus().accounts.length,1);
  native={accountUuid:'claude-user-b',claudeAiOauth:{accessToken:'claude-token-b',refreshToken:'claude-refresh-b',expiresAt:Date.now()+3600000}};
  await a.pool.refresh();await b.pool.refresh();
  assert.equal(b.pool.claudeStatus().accounts.length,2);
  f.disconnect();await b.pool.refresh();
  const loaded=createAccountPool(b.options);
  assert.equal(loaded.claudeStatus().accounts.filter(x=>x.available).length,2);
  assert.equal(JSON.stringify(loaded.claudeStatus()).includes('claude-token'),false);
  assert.equal(JSON.stringify(loaded.codexStatus()).includes('claude-user'),false);
});

test('Claude proxy and subscription entries share routing, while explicit removal and disable survive auto discovery', async t => {
  const f=fixture(t),native={accountUuid:'subscriber',claudeAiOauth:{accessToken:'subscription-secret',refreshToken:'refresh-secret',expiresAt:Date.now()+3600000}};
  const a=f.add('a',null,{claude:{read:()=>native}}),b=f.add('b');
  a.router.save({mode:'manual',selected:'proxy-a',accounts:[{id:'proxy-a',name:'Claude proxy',url:'https://example.test',token:'proxy-secret',authType:'bearer',enabled:true}]});
  const subscription=a.pool.claudeStatus().accounts.find(x=>x.managed);
  a.pool.setClaudeRouting({mode:'manual',selected:subscription.id});await b.pool.refresh();
  assert.equal(b.pool.claudeStatus().selected,subscription.id);
  assert.equal(b.pool.claudeStatus().accounts.length,2);
  assert.equal(b.pool.codexStatus().accounts.length,0);
  a.pool.configureClaude(subscription.id,{enabled:false});await a.pool.refresh();await b.pool.refresh();
  assert.equal(b.pool.claudeStatus().accounts.find(x=>x.id===subscription.id).enabled,false);
  a.pool.configureClaude(subscription.id,{deleted:true});await a.pool.refresh();await b.pool.refresh();
  assert.equal(b.pool.claudeStatus().accounts.some(x=>x.id===subscription.id),false);
  a.pool.importClaude(native);await b.pool.refresh();
  assert.equal(b.pool.claudeStatus().accounts.find(x=>x.id===subscription.id).enabled,true);
});

test('Claude refresh uses the leader lease, rotates once and preserves native account identity', async t => {
  const f=fixture(t);let native={accountUuid:'expired-user',claudeAiOauth:{accessToken:'expired-claude',refreshToken:'refresh-old',expiresAt:Date.now()-1000}},count=0;
  const fresh={...native,claudeAiOauth:{accessToken:'fresh-claude',refreshToken:'refresh-new',expiresAt:Date.now()+3600000}};
  const a=f.add('a',null,{claude:{read:()=>native,updated:(_old,value)=>{native=value;}},renewClaude:async()=>{count++;await new Promise(r=>setTimeout(r,10));return fresh;},coordination:{canRefresh:()=>true,required:()=>2}});
  const b=f.add('b',null,{coordination:{canRefresh:()=>false,required:()=>2,refresh:input=>a.pool.refreshWire(input)}});
  await b.pool.refresh();await Promise.all([b.pool.prepareClaude(),b.pool.prepareClaude()]);
  assert.equal(count,1);assert.equal(native.claudeAiOauth.refreshToken,'refresh-new');
  assert.equal(b.pool.claudeStatus().accounts.length,1);assert.equal(b.pool.claudeStatus().accounts[0].available,true);
  assert.equal(b.router.status().accounts[0].authType,'oauth');
  assert.equal(fs.readFileSync(b.pool.vault.file,'utf8').includes('fresh-claude'),false);
});

test('Codex subscriptions and custom Responses proxies are selectable in one independent pool', async t => {
  const f=fixture(t),a=f.add('a',auth());
  a.pool.importCodex({OPENAI_API_KEY:'gateway-secret',base_url:'https://gateway.example.test/v1'},'Codex proxy');
  const proxy=a.pool.codexStatus().accounts.find(x=>x.mode==='api-key');
  a.pool.setRouting({mode:'manual',selected:proxy.id});
  let route=await a.pool.resolveCodex('chatgpt','session');
  assert.equal(route.accountId,proxy.id);assert.equal(route.headers.authorization,'Bearer gateway-secret');assert.equal(route.upstream,'https://gateway.example.test/v1');
  a.pool.configureCodex(proxy.id,{url:'https://new.example.test/v1',token:'replacement-key'});
  route=await a.pool.resolveCodex('chatgpt','session');
  assert.equal(route.accountId,proxy.id);assert.equal(route.headers.authorization,'Bearer replacement-key');assert.equal(route.upstream,'https://new.example.test/v1');
  assert.equal(a.pool.claudeStatus().accounts.length,0);
  assert.equal(JSON.stringify(a.pool.codexStatus()).includes('replacement-key'),false);
  assert.throws(()=>a.pool.importCodex({OPENAI_API_KEY:'key',base_url:'https://user:password@example.test/v1'}),/代理地址/);
});

test('explicit per-session and connection-check accounts override a different global manual selection',async t=>{
 const f=fixture(t),a=f.add('a',auth());a.pool.importCodex({tokens:{account_id:'other',access_token:'other-token',refresh_token:'other-refresh'}});
 const [first,second]=a.pool.codexStatus().accounts;a.pool.setRouting({mode:'manual',selected:second.id});
 a.pool.rejected({accountId:first.id},401);
 assert.equal((await a.pool.resolveCodex('chatgpt','',[],first.id)).accountId,first.id);
 a.pool.pinCodex('conversation',first.id);assert.equal((await a.pool.resolveCodex('chatgpt','conversation')).accountId,first.id);
});

test('new native credentials clear stale authentication failures without removing another subscription',async t=>{
 const f=fixture(t),a=f.add('a',auth());const original=a.pool.codexStatus().accounts[0];
 a.pool.rejected({accountId:original.id},401);a.pool.observeNative('a',{codex:{tokens:{account_id:'same-user',access_token:'fresh-native-access',refresh_token:'fresh-native-refresh'}}});
 const restored=a.pool.codexStatus().accounts.find(x=>x.id===original.id);assert.equal(restored.cooldownUntil,0);assert.equal(restored.lastStatus,0);
 a.pool.observeNative('a',{codex:{tokens:{account_id:'new-user',access_token:'second-native-access',refresh_token:'second-native-refresh'}}});assert.equal(a.pool.codexStatus().accounts.length,2);
});

test('subscription-only routes never use API accounts, including explicit selection and empty subscription pools', async t => {
  const f = fixture(t), node = f.add('mac', auth());
  node.pool.importCodex({ OPENAI_API_KEY: 'api-key-only' }, 'API');
  const api = node.pool.codexStatus().accounts.find(a => a.mode === 'api-key');
  const subscription = node.pool.codexStatus().accounts.find(a => a.mode === 'chatgpt');
  const options = { subscriptionOnly: true };
  assert.equal(node.pool.codexRoute('chatgpt', 'bridge', [], '', options).accountId, subscription.id);
  assert.equal(await node.pool.resolveCodex('chatgpt', 'bridge', [], api.id, options), null);
  node.pool.configureCodex(subscription.id, { enabled: false });
  assert.equal(await node.pool.resolveCodex('chatgpt', 'bridge', [], '', options), null);
});

test('different loopback accounts survive sharing through the same node relay and keep their selected route', async t => {
  const f = fixture(t), owner = f.add('mac'), worker = f.add('sgdev');
  owner.router.save({ mode: 'manual', selected: 'codex-bridge', accounts: [
    { id: 'trae-bridge', name: 'TRAE', url: 'http://127.0.0.1:8790', token: 'trae-secret', authType: 'bearer', enabled: true, modelMap: {} },
    { id: 'codex-bridge', name: 'Codex subscription', url: 'http://localhost:4321/codex-subscription', token: 'bridge-secret', authType: 'bearer', enabled: true, modelMap: { '*': 'gpt-test' } },
  ] });
  await worker.pool.refresh();
  const shared = worker.router.status().accounts;
  assert.equal(shared.length, 2);
  assert.deepEqual(shared.map(a => a.id).sort(), ['cluster:mac:codex-bridge', 'cluster:mac:trae-bridge']);
  assert.equal(shared[0].url, shared[1].url, 'both accounts use the same authenticated RPC relay');
  assert.equal(worker.router.status().selected, 'cluster:mac:codex-bridge');
  assert.equal(shared.find(a => a.id === worker.router.status().selected).enabled, true);
});


test('OAuth rotation uses authenticated peer egress when the elected leader cannot reach authentication', async t => {
  const f = fixture(t), old = auth('backend-expired-access'), fresh = { ...auth('renewed-access', 'rotated-grant'), last_refresh: new Date().toISOString() };
  let remoteCalls = 0, authorized = true;
  const coordinator = { canRefresh: () => true, required: () => 2, term: () => 7 };
  const leader = f.add('leader', old, { coordination: coordinator, renew: async () => { throw Object.assign(new Error('egress blocked'), { status: 403 }); } });
  const worker = f.add('worker', null, { coordination: { canRefresh: () => false, required: () => 2, authorizeRenew: (source, term) => authorized && source === 'leader' && term === 7 }, renew: async value => { remoteCalls++; assert.equal(value.tokens.refresh_token, old.tokens.refresh_token); return fresh; } });
  await leader.pool.refresh();
  const before = leader.pool.codexRoute('chatgpt', 'bridge');
  leader.pool.rejected(before, 401);
  const selected = await leader.pool.resolveCodex('chatgpt', 'bridge', [before.id]);
  assert.equal(remoteCalls, 1); assert.equal(selected.headers.authorization, 'Bearer renewed-access');
  assert.equal(worker.pool.codexRoute('chatgpt').headers.authorization, selected.headers.authorization);
  assert.equal(createAccountPool(worker.options).codexRoute('chatgpt').headers.authorization, selected.headers.authorization, 'egress node persists rotation before returning it');
  assert.ok(!JSON.stringify(leader.pool.codexStatus()).includes('rotated-grant'));
  authorized = false;
  leader.pool.rejected(selected, 401);
  const again = await leader.pool.resolveCodex('chatgpt', 'bridge', [selected.id]);
  assert.equal(remoteCalls, 1, 'unauthorized delegates cannot consume the refresh grant');
});


test('transient upstream errors do not rotate otherwise valid OAuth grants', async t => {
  const f = fixture(t); let renewals = 0;
  const node = f.add('mac', auth(jwt(Math.floor(Date.now()/1000), Math.floor(Date.now()/1000)+7200)), { renew: async value => { renewals++; return value; } });
  const route = node.pool.codexRoute('chatgpt', 'transient');
  node.pool.rejected(route, 502);
  await node.pool.resolveCodex('chatgpt', 'transient', [route.id]);
  assert.equal(renewals, 0);
});
