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
    const result = new Map();
    for (const source of origins()) {
      const auth = source.codex;
      if (mode === 'api-key' ? !auth?.OPENAI_API_KEY : !auth?.tokens?.access_token) continue;
      const key = accountId(auth, mode), merged = vault.credential(key, auth), current = result.get(key);
      if (!current || issued(merged) > issued(current.auth)) result.set(key, { key, source: source.id, label: source.label, auth: merged });
    }
    return [...result.values()].sort((a, b) => a.key.localeCompare(b.key));
  }
  const routeFor = (entry, mode) => ({ id: entry.key + ':' + fingerprint(entry.auth.tokens?.access_token || entry.auth.OPENAI_API_KEY).slice(0, 16), accountId: entry.key, sourceNode: entry.source, label: entry.label, headers: codexCredentials(entry.auth, mode) });
  function codexRoute(mode, sessionId = '', excluded = []) {
    const candidates = codexEntries(mode).map(entry => routeFor(entry, mode)).filter(route => route.headers && !excluded.includes(route.id));
    if (!candidates.length) return null;
    let hash = 0; for (const char of sessionId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return candidates[hash % candidates.length];
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
    vault.merge(response.snapshot); install();
  }
  async function resolveCodex(mode, sessionId = '', excluded = []) {
    await refresh();
    // An auth rejection may mean revocation before JWT expiry. Refresh once
    // for that token generation; retries never loop indefinitely.
    if (mode === 'chatgpt' && excluded.length) {
      const rejected = codexEntries(mode).find(entry => excluded.includes(routeFor(entry, mode).id) && excluded.filter(id => id.startsWith(entry.key + ':')).length < 2);
      if (rejected?.auth.tokens.refresh_token) { try { await renewEntry(rejected, true); } catch {} }
    }
    let selected = codexRoute(mode, sessionId, excluded);
    if (mode !== 'chatgpt') return selected;
    const entry = selected ? codexEntries(mode).find(item => item.key === selected.accountId) : codexEntries(mode).find(item => item.auth.tokens.refresh_token && !excluded.some(id => id.startsWith(item.key + ':')));
    if (entry && (!selected || expiresSoon(entry.auth, now()))) {
      try { await renewEntry(entry, false); selected = codexRoute(mode, sessionId, excluded); }
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
  observe(); install();
  return { catalog, exchange, exchangeWire, refreshWire, exchangeKey: () => ({ publicKey: transport.publicKey }), refresh, refreshAtLeader, resolveCodex, codexRoute, status, vault };
}
module.exports = { createAccountPool };
