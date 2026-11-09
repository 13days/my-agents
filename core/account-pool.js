const { createRelayClient } = require('../node/relay');
const { createAccountVault } = require('./account-vault');
const { fingerprint, accountId, issued, expiresSoon, renewCodex, codexCredentials } = require('./codex-credentials');

function createAccountPool({ accounts, codex, identity, peers, dir, secret, fallbackSecret, coordination = null, relayClient = createRelayClient, renew = renewCodex, now = Date.now }) {
  const vault = createAccountVault({ dir, secret, fallbackSecret, nodeId: identity().id, now });
  const transport = require('./account-transport').createAccountTransport(secret);
  const sources = new Map(), refreshing = new Map();
  let updating = null;
  const catalog = () => ({ claude: accounts.sharedCatalog(), codex: codex.catalog() });
  function observe() {
    vault.observe({ label: identity().label, claude: accounts.exportAccounts(), codex: codex.read() });
  }
  const origins = () => Object.entries(vault.origins()).map(([id, row]) => ({ id, ...row.payload }));
  const loopback = url => { try { const host = new URL(url).hostname; return ['localhost', '[::1]', '[::]', '0.0.0.0'].includes(host) || host.endsWith('.localhost') || /^127\./.test(host) || host.startsWith('[::ffff:127.'); } catch { return true; } };
  function install() {
    for (const source of origins()) vault.importCodex(source.codex, { origin: source.id });
    const seen = new Set(accounts.exportAccounts().filter(a => a.enabled).map(a => fingerprint(a.url + ':' + a.authType + ':' + a.token)));
    const shared = origins().sort((a, b) => a.id.localeCompare(b.id)).filter(source => source.id !== identity().id).flatMap(source => (source.claude || []).map(account => {
      const bridge = loopback(account.url), live = sources.get(source.id);
      return {
        ...account, id: `cluster:${source.id}:${account.id}`, name: `${account.name} · ${source.label || source.id}`,
        sourceNode: source.id, shared: true, replicated: !bridge, requiresBridge: bridge,
        ...(bridge ? { enabled: account.enabled && !!live, url: live?.url || account.url, authType: 'bearer', token: live?.catalog?.claude?.token || '', delegateAccount: account.id, env: {}, unavailableReason: live ? '' : '账号依赖来源机器上的本地桥接服务；请连接该服务或在目标机器部署桥接' } : {}),
      };
    }));
    accounts.setShared(shared.filter(account => { const key = fingerprint(account.url + ':' + account.authType + ':' + account.token); if (seen.has(key)) return false; if (account.enabled) seen.add(key); return true; }));
    const localAuth = codex.read();
    if (localAuth?.tokens?.access_token) { const id = accountId(localAuth, 'chatgpt'), fresh = vault.credential(id, localAuth); if (fresh !== localAuth && vault.matchesPrevious(id, localAuth)) codex.updated?.(localAuth, fresh); }
  }
  function exchange(snapshot) {
    observe(); if (snapshot) vault.merge(snapshot); install();
    return { snapshot: vault.export(), capability: catalog() };
  }
  function exchangeWire({ publicKey, sealed }) {
    const result = exchange(transport.open(sealed, publicKey));
    return { publicKey: transport.publicKey, sealed: transport.seal(result, publicKey) };
  }
  async function refreshWire({ publicKey, ...request }) {
    const result = await refreshAtLeader(request);
    return { publicKey: transport.publicKey, sealed: transport.seal(result, publicKey) };
  }
  async function syncPeer({ id, label, peer }) {
    try {
      const key = await peer.call('accounts.key', {}, { timeout: 3000 });
      const packet = await peer.call('accounts.exchange', { publicKey: transport.publicKey, sealed: transport.seal(vault.export(), key.publicKey) }, { timeout: 5000 });
      const result = transport.open(packet.sealed, packet.publicKey);
      vault.merge(result.snapshot);
      const previous = sources.get(id), relay = previous?.peer === peer ? previous.relay : relayClient(peer);
      sources.set(id, { catalog: result.capability, label: label || id, peer, relay, url: await relay.url() });
      return true;
    } catch { sources.delete(id); return false; }
  }
  async function refresh() {
    if (updating) return updating;
    updating = (async () => {
      observe();
      const connected = peers();
      for (const id of sources.keys()) if (!connected.some(peer => peer.id === id)) sources.delete(id);
      await Promise.all(connected.map(syncPeer)); install();
    })().finally(() => { updating = null; });
    return updating;
  }
  function codexEntries(mode) {
    return Object.values(vault.codexAccounts()).filter(row => !row.deleted && row.enabled && row.mode === mode).map(row => ({ key: row.id, source: row.origin, label: row.name, auth: vault.credential(row.id, row.auth) })).sort((a, b) => a.key.localeCompare(b.key));
  }
  const routing = () => vault.preference('codex-routing') || { mode: 'round-robin', selected: '' };
  function setRouting(input) {
    if (!['manual', 'failover', 'round-robin'].includes(input.mode)) throw new Error('Codex 路由模式无效');
    if (input.selected && !Object.values(vault.codexAccounts()).some(row => row.id === input.selected && !row.deleted && row.enabled)) throw new Error('选中账号不存在或已停用');
    if (input.mode === 'manual' && !input.selected) throw new Error('请选择要固定使用的 Codex 账号');
    vault.preference('codex-routing', { mode: input.mode, selected: input.selected || '' });
  }
  function pinCodex(sessionId, id) {
    if (typeof sessionId !== 'string' || !/^[\w.-]{1,100}$/.test(sessionId)) throw new Error('会话 ID 无效');
    if (id && !Object.values(vault.codexAccounts()).some(row => row.id === id && row.enabled && !row.deleted)) throw new Error('Codex 账号不存在或已停用');
    vault.preference('codex-pin:' + sessionId, id ? { accountId: id, manual: true } : { accountId: '', manual: true, followGlobal: true });
  }
  const routeFor = (entry, mode) => ({ id: entry.key + ':' + fingerprint(entry.auth.tokens?.access_token || entry.auth.OPENAI_API_KEY).slice(0, 16), accountId: entry.key, sourceNode: entry.source, label: entry.label, mode: routing().mode, headers: codexCredentials(entry.auth, mode) });
  function codexRoute(mode, sessionId = '', excluded = [], forced = '') {
    const config = routing(), pin = sessionId && vault.preference('codex-pin:' + sessionId);
    let candidates = codexEntries(mode).map(entry => routeFor(entry, mode)).filter(route => route.headers && !excluded.includes(route.id) && (vault.preference('codex-health:' + route.accountId)?.cooldownUntil || 0) <= now());
    const explicit = pin?.followGlobal ? '' : pin?.manual ? pin.accountId : forced;
    if (explicit) candidates = candidates.filter(route => route.accountId === explicit).map(route => ({ ...route, explicit: true }));
    if (!candidates.length) return null;
    const sticky = pin && candidates.find(route => route.accountId === pin.accountId);
    if (sticky) return sticky;
    const selected = candidates.find(route => route.accountId === config.selected);
    if (config.mode === 'manual') return selected || null;
    if (config.mode === 'failover') return selected || candidates[0];
    let hash = 0; for (const char of sessionId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return candidates[hash % candidates.length];
  }
  function accepted(route, sessionId) {
    const id = route?.accountId; if (!id) return;
    if (sessionId && /^[\w.-]{1,100}$/.test(sessionId)) { const old = vault.preference('codex-pin:' + sessionId); if (!old?.manual && old?.accountId !== id) vault.preference('codex-pin:' + sessionId, { accountId: id, manual: !!route.explicit }); }
    const health = vault.preference('codex-health:' + id); if (health?.cooldownUntil) vault.preference('codex-health:' + id, { cooldownUntil: 0, lastStatus: 200 });
  }
  function rejected(route, status, retryAfter) {
    const id = route?.accountId; if (!id) return;
    const delay = Number(retryAfter), seconds = Number.isFinite(delay) && delay > 0 ? Math.min(delay, 900) : status === 429 ? 60 : status >= 500 ? 15 : 30;
    vault.preference('codex-health:' + id, { lastStatus: status, cooldownUntil: now() + seconds * 1000 });
  }
  function codexStatus() {
    return { ...routing(), routes: Object.fromEntries(Object.entries(vault.preferences()).filter(([key]) => key.startsWith('codex-pin:')).map(([key, row]) => [key.slice(10), row.value?.accountId || ''])), accounts: Object.values(vault.codexAccounts()).filter(row => !row.deleted).map(row => {
      const auth = vault.credential(row.id, row.auth), health = vault.preference('codex-health:' + row.id) || {};
      let expiresAt = ''; try { const exp = JSON.parse(Buffer.from(auth.tokens.access_token.split('.')[1], 'base64url')).exp; if (exp) expiresAt = new Date(exp * 1000).toISOString(); } catch {}
      return { id: row.id, name: row.name, origin: row.origin, enabled: row.enabled, mode: row.mode, available: !!codexCredentials(auth, row.mode), renewable: !!auth.tokens?.refresh_token, expiresAt, lastRefresh: auth.last_refresh || '', ...health };
    }) };
  }
  function importCodex(auth, name) {
    if (!auth || typeof auth !== 'object' || Array.isArray(auth) || Buffer.byteLength(JSON.stringify(auth)) > 100000 || (!auth.tokens?.access_token && !auth.OPENAI_API_KEY)) throw new Error('请选择有效的 Codex auth.json 登录文件');
    if (name !== undefined && (typeof name !== 'string' || name.length > 100)) throw new Error('账号名称最多 100 个字');
    vault.importCodex(auth, { name, explicit: true }); install(); return codexStatus();
  }
  function configureCodex(id, input) {
    vault.configureCodex(id, input); if ((input.deleted || input.enabled === false) && routing().selected === id) setRouting({ mode: 'round-robin', selected: '' }); return codexStatus();
  }
  async function replicateQuorum() {
    const votes = 1 + (await Promise.all(peers().map(syncPeer))).filter(Boolean).length;
    if (coordination && votes < coordination.required()) throw new Error('共享账号更新尚未同步到多数节点，暂不继续刷新登录');
  }
  async function refreshAtLeader({ id, expected = '', force = false }) {
    if (coordination && !coordination.canRefresh()) throw new Error('当前节点没有账号刷新租约');
    if (refreshing.has(id)) return refreshing.get(id);
    const pending = (async () => {
      observe();
      const entry = codexEntries('chatgpt').find(item => item.key === id);
      if (!entry) throw new Error('共享账号不存在');
      const currentHash = fingerprint(entry.auth.tokens.access_token).slice(0, 16);
      if (expected && expected !== currentHash || !force && !expiresSoon(entry.auth, now())) return { snapshot: vault.export() };
      const lease = vault.lease(id);
      if (lease?.until > now() && lease.holder !== identity().id) throw new Error('其他节点正在刷新此共享登录，请稍后重试');
      vault.claim(id, now() + 60000);
      await replicateQuorum();
      if (coordination && !coordination.canRefresh()) throw new Error('账号刷新主节点已切换，请稍后重试');
      try {
        const auth = await renew(entry.auth);
        // Persist the rotated refresh token even if leadership changed during
        // the HTTP exchange. Dropping it would lose the grant entirely.
        vault.rotate(id, auth, entry.auth);
        await codex.updated?.(entry.auth, auth);
        await replicateQuorum();
        return { snapshot: vault.export() };
      } finally { vault.claim(id, 0); await Promise.all(peers().map(syncPeer)); install(); }
    })().finally(() => refreshing.delete(id));
    refreshing.set(id, pending); return pending;
  }
  async function renewEntry(entry, force) {
    const request = { id: entry.key, expected: fingerprint(entry.auth.tokens.access_token).slice(0, 16), force };
    let response;
    if (!coordination || coordination.canRefresh()) response = await refreshAtLeader(request);
    else { const packet = await coordination.refresh({ ...request, publicKey: transport.publicKey }); response = transport.open(packet.sealed, packet.publicKey); }
    vault.merge(response.snapshot); vault.preference('codex-health:' + entry.key, { cooldownUntil: 0, lastStatus: 200 }); install();
  }
  async function resolveCodex(mode, sessionId = '', excluded = [], forced = '') {
    await refresh();
    // An auth rejection may mean revocation before JWT expiry. Refresh once
    // for that token generation; retries never loop indefinitely.
    if (mode === 'chatgpt' && excluded.length) {
      const rejected = codexEntries(mode).find(entry => excluded.includes(routeFor(entry, mode).id) && excluded.filter(id => id.startsWith(entry.key + ':')).length < 2);
      if (rejected?.auth.tokens.refresh_token) { try { await renewEntry(rejected, true); } catch {} }
    }
    let selected = codexRoute(mode, sessionId, excluded, forced);
    if (mode !== 'chatgpt') return selected;
    const entry = selected ? codexEntries(mode).find(item => item.key === selected.accountId) : codexEntries(mode).find(item => (!forced || item.key === forced) && item.auth.tokens.refresh_token && !excluded.some(id => id.startsWith(item.key + ':')));
    if (entry && (!selected || expiresSoon(entry.auth, now()))) {
      try { await renewEntry(entry, false); selected = codexRoute(mode, sessionId, excluded, forced); }
      catch (error) { if (!selected) throw error; }
    }
    return selected;
  }
  function status() {
    const online = new Set([identity().id, ...peers().map(peer => peer.id)]);
    return origins().map(source => ({ id: source.id, label: source.label || source.id, local: source.id === identity().id, online: online.has(source.id), replicated: true,
      claudeAccounts: (source.claude || []).filter(a => a.enabled).length,
      bridgeAccounts: (source.claude || []).filter(a => a.enabled && loopback(a.url)).length,
      codexModes: ['chatgpt', 'api-key'].filter(mode => codexEntries(mode).some(entry => entry.source === source.id && codexCredentials(entry.auth, mode))),
    }));
  }
  for (const source of origins()) vault.importCodex(source.codex, { origin: source.id });
  observe(); install();
  return { catalog, egress: excluded => { const candidate = [...sources].filter(([id, source]) => !excluded.includes(id) && source.catalog?.codex?.token).sort(([a], [b]) => a.localeCompare(b))[0]; return candidate ? { id: candidate[0], url: candidate[1].url, token: candidate[1].catalog.codex.token } : null; }, codexStatus, resetCodex: () => { for (const entry of Object.values(vault.codexAccounts())) vault.preference('codex-health:' + entry.id, { cooldownUntil: 0, lastStatus: 0 }); return codexStatus(); }, setRouting, pinCodex, importCodex, configureCodex, accepted, rejected, exchange, exchangeWire, refreshWire, exchangeKey: () => ({ publicKey: transport.publicKey }), refresh, refreshAtLeader, resolveCodex, codexRoute, status, vault };
}
module.exports = { createAccountPool };
