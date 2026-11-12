const { cooldownSeconds } = require('./route-policy');
const { createRelayClient } = require('../node/relay');
const { createAccountVault } = require('./account-vault');
const claudeCredentials = require('./claude-credentials');
const { fingerprint, accountId, issued, expiresSoon, renewCodex, codexCredentials } = require('./codex-credentials');

function createAccountPool({ accounts, codex, claude = { read: () => null }, renewClaude = claudeCredentials.renewClaude, identity, peers, dir, secret, fallbackSecret, coordination = null, relayClient = createRelayClient, renew = renewCodex, now = Date.now }) {
  const vault = createAccountVault({ dir, secret, fallbackSecret, nodeId: identity().id, now });
  const transport = require('./account-transport').createAccountTransport(secret);
  const sources = new Map(), refreshing = new Map();
  let updating = null;
  const catalog = () => ({ claude: accounts.sharedCatalog(), codex: codex.catalog() });
  function observe() {
    vault.observe({ label: identity().label, claude: accounts.exportAccounts(), codex: codex.read() });
    for(const auth of claude.readAll?.() || [claude.read()])if(auth)vault.importClaude(auth);
    for(const auth of codex.readAll?.() || [])if(auth)vault.importCodex(auth);
  }
  const origins = () => Object.entries(vault.origins()).map(([id, row]) => ({ id, ...row.payload }));
  const loopback = url => { try { const host = new URL(url).hostname; return ['localhost', '[::1]', '[::]', '0.0.0.0'].includes(host) || host.endsWith('.localhost') || /^127\./.test(host) || host.startsWith('[::ffff:127.'); } catch { return true; } };
  function install() {
    accounts.requirePool?.(Object.keys(vault.claudeAccounts()).length>0);
    for (const source of origins()) vault.importCodex(source.codex, { origin: source.id });
    const seen = new Set(accounts.exportAccounts().filter(a => a.enabled).map(a => fingerprint(JSON.stringify([a.url, a.authType, a.token, a.delegateAccount || '']))));
    const shared = origins().sort((a, b) => a.id.localeCompare(b.id)).filter(source => source.id !== identity().id).flatMap(source => (source.claude || []).map(account => {
      const bridge = loopback(account.url), live = sources.get(source.id);
      return {
        ...account, id: `cluster:${source.id}:${account.id}`, name: `${account.name} · ${source.label || source.id}`,
        sourceNode: source.id, shared: true, replicated: !bridge, requiresBridge: bridge,
        ...(bridge ? { enabled: account.enabled && !!live, url: live?.url || account.url, authType: 'bearer', token: live?.catalog?.claude?.token || '', delegateAccount: account.id, env: {}, unavailableReason: live ? '' : '账号依赖来源机器上的本地桥接服务；请连接该服务或在目标机器部署桥接' } : {}),
      };
    }));
    accounts.setShared([...claudeEntries().map(entry => ({ id:entry.key, name:entry.label, url:'https://api.anthropic.com', token:entry.auth.claudeAiOauth.accessToken, authType:'oauth', modelMap:{}, env:{}, enabled:claudeCredentials.available(entry.auth,now()), managed:true, shared:true, mode:'subscription', sourceNode:entry.source, replicated:true })), ...shared.filter(account => { const key = fingerprint(JSON.stringify([account.url, account.authType, account.token, account.delegateAccount || ''])); if (seen.has(key)) return false; if (account.enabled) seen.add(key); return true; })]);
    const claudeRouting = vault.preference('claude-routing');
    if (claudeRouting) accounts.applyPoolRouting?.({...claudeRouting,selected:claudeRouting.selected?.startsWith('cluster:'+identity().id+':') ? claudeRouting.selected.slice(('cluster:'+identity().id+':').length) : claudeRouting.selected});
    for (const localClaude of claude.readAll?.() || [claude.read()]) {
      if (localClaude) { const id = claudeCredentials.claudeAccountId(localClaude), fresh = vault.credential(id,localClaude); if (fresh !== localClaude && vault.matchesPrevious(id,localClaude)) claude.updated?.(localClaude,fresh); }
    }
    for (const localAuth of codex.readAll?.() || [codex.read()]) {
      if (localAuth?.tokens?.access_token) { const id = accountId(localAuth, 'chatgpt'), fresh = vault.credential(id, localAuth); if (fresh !== localAuth && vault.matchesPrevious(id, localAuth)) codex.updated?.(localAuth, fresh); }
    }
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
  function claudeEntries() {
    return Object.values(vault.claudeAccounts()).filter(row => !row.deleted && row.enabled).map(row => ({ key:row.id, source:row.origin, label:row.name, auth:vault.credential(row.id,row.auth) }));
  }
  function setClaudeRouting(input) {
    if (!['manual','failover','round-robin'].includes(input.mode)) throw new Error('Claude 路由模式无效');
    const selected=input.selected || '', account=claudeStatus().accounts.find(row=>row.id===selected);
    if (selected && (!account || !account.enabled) || input.mode==='manual' && !selected) throw new Error('请选择启用的 Claude 账号');
    vault.preference('claude-routing',{mode:input.mode,selected:account && !account.managed && !account.shared ? 'cluster:'+identity().id+':'+selected : selected});
    install();
  }
  function claudeStatus() {
    const status=accounts.status();
    return { ...status, mode:status.mode==='manual'&&!status.selected&&status.accounts.length ? 'failover' : status.mode, accounts: [...accounts.status().accounts.filter(row => !row.managed), ...Object.values(vault.claudeAccounts()).filter(row => !row.deleted).map(row => {
      const auth = vault.credential(row.id,row.auth);
      return { id:row.id, name:row.name, origin:row.origin, enabled:row.enabled, mode:'subscription', managed:true, available:claudeCredentials.available(auth,now()), renewable:!!auth.claudeAiOauth.refreshToken, expiresAt:auth.claudeAiOauth.expiresAt ? new Date(auth.claudeAiOauth.expiresAt).toISOString() : '' };
    })] };
  }
  function importClaude(auth, name) { vault.importClaude(auth || claude.read(), { name, explicit:true }); install(); return claudeStatus(); }
  function configureClaude(id, input) { vault.configureClaude(id,{name:input.name,enabled:input.enabled,deleted:input.deleted}); install(); return claudeStatus(); }
  async function prepareClaude() {
    observe(); install();
    await Promise.all(claudeEntries().filter(entry => claudeCredentials.expiresSoon(entry.auth,now()) && entry.auth.claudeAiOauth.refreshToken).map(entry => renewEntry(entry,false).catch(() => {})));
    install();
  }
  function codexEntries(mode, mixed = false) {
    return Object.values(vault.codexAccounts()).filter(row => !row.deleted && row.enabled && (mixed || row.mode === mode)).map(row => ({ key: row.id, source: row.origin, label: row.name, mode:row.mode, auth: vault.credential(row.id, row.auth) })).sort((a, b) => a.key.localeCompare(b.key));
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
  const routeFor = (entry, mode) => ({ id: entry.key + ':' + fingerprint(entry.auth.tokens?.access_token || entry.auth.OPENAI_API_KEY).slice(0, 16), accountId: entry.key, sourceNode: entry.source, label: entry.label, mode: routing().mode, authMode:entry.mode, upstream:entry.mode === 'api-key' ? entry.auth.base_url || 'https://api.openai.com/v1' : 'https://chatgpt.com/backend-api/codex', headers: codexCredentials(entry.auth, entry.mode || mode) });
  function codexRoute(mode, sessionId = '', excluded = [], forced = '', { subscriptionOnly = false } = {}) {
    const config = routing(), pin = sessionId && vault.preference('codex-pin:' + sessionId);
    const explicit = pin?.followGlobal ? '' : pin?.manual ? pin.accountId : forced;
    let candidates = codexEntries(mode, !subscriptionOnly).map(entry => routeFor(entry, mode)).filter(route => route.headers && !excluded.includes(route.id) && (explicit || config.mode === 'manual' || (vault.preference('codex-health:' + route.accountId)?.cooldownUntil || 0) <= now()));
    if (explicit) candidates = candidates.filter(route => route.accountId === explicit).map(route => ({ ...route, explicit: true }));
    if (!candidates.length) return null;
    if (explicit) return candidates[0];
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
    const seconds = cooldownSeconds(status, retryAfter, now());
    vault.preference('codex-health:' + id, { lastStatus: status, cooldownUntil: now() + seconds * 1000 });
  }
  function codexStatus() {
    return { ...routing(), routes: Object.fromEntries(Object.entries(vault.preferences()).filter(([key]) => key.startsWith('codex-pin:')).map(([key, row]) => [key.slice(10), row.value?.accountId || ''])), accounts: Object.values(vault.codexAccounts()).filter(row => !row.deleted).map(row => {
      const auth = vault.credential(row.id, row.auth), health = vault.preference('codex-health:' + row.id) || {};
      let expiresAt = ''; try { const exp = JSON.parse(Buffer.from(auth.tokens.access_token.split('.')[1], 'base64url')).exp; if (exp) expiresAt = new Date(exp * 1000).toISOString(); } catch {}
      return { id: row.id, name: row.name, origin: row.origin, enabled: row.enabled, mode: row.mode, url:auth.base_url || (row.mode === 'api-key' ? 'https://api.openai.com/v1' : ''), available: !!codexCredentials(auth, row.mode), renewable: !!auth.tokens?.refresh_token, expiresAt, lastRefresh: auth.last_refresh || '', ...health };
    }) };
  }
  function importCodex(auth, name) {
    if (!auth || typeof auth !== 'object' || Array.isArray(auth) || Buffer.byteLength(JSON.stringify(auth)) > 100000 || (!auth.tokens?.access_token && !auth.OPENAI_API_KEY)) throw new Error('请选择有效的 Codex auth.json 登录文件');
    if (name !== undefined && (typeof name !== 'string' || name.length > 100)) throw new Error('账号名称最多 100 个字');
    if (auth.base_url) {
      let target; try { target = new URL(auth.base_url); } catch { throw new Error('代理地址无效'); }
      if (!['http:','https:'].includes(target.protocol) || target.username || target.password || target.search || target.hash) throw new Error('代理地址应为无凭证、无查询参数的 HTTP(S) 地址');
      auth = { ...auth, base_url:target.href.replace(/\/$/,'') };
    }
    if (auth.OPENAI_API_KEY && (typeof auth.OPENAI_API_KEY !== 'string' || /[\r\n]/.test(auth.OPENAI_API_KEY))) throw new Error('代理 Token 无效');
    vault.importCodex(auth, { name, explicit: true }); install(); return codexStatus();
  }
  function configureCodex(id, input) {
    const patch = {name:input.name,enabled:input.enabled,deleted:input.deleted};
    if (input.url !== undefined || input.token !== undefined) {
      const row=vault.codexAccounts()[id]; if (!row || row.mode!=='api-key') throw new Error('只有代理 / API 账号可以修改地址与 Token');
      const token=input.token || row.auth.OPENAI_API_KEY;
      let url;try{url=new URL(input.url || row.auth.base_url || 'https://api.openai.com/v1');}catch{throw new Error('代理地址无效');}
      if (!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||typeof token!=='string'||!token||/[\r\n]/.test(token))throw new Error('代理地址或 Token 无效');
      patch.proxyAuth={...row.auth,OPENAI_API_KEY:token,base_url:url.href.replace(/\/$/,'')};
    }
    vault.configureCodex(id, patch); if ((input.deleted || input.enabled === false) && routing().selected === id) setRouting({ mode: 'round-robin', selected: '' }); return codexStatus();
  }
  async function replicateQuorum() {
    const votes = 1 + (await Promise.all(peers().map(syncPeer))).filter(Boolean).length;
    if (coordination && votes < coordination.required()) throw new Error('共享账号更新尚未同步到多数节点，暂不继续刷新登录');
  }
  // The elected coordinator owns rotation, but may need another full node's egress.
  async function renewWire(source, { publicKey, sealed }) {
    const request = transport.open(sealed, publicKey);
    if (!coordination?.authorizeRenew?.(source, request.term)) throw new Error('只有当前主节点可以委托账号刷新');
    const lease = vault.lease(request.id);
    if (!lease || lease.holder !== source || lease.until <= now()) throw new Error('账号刷新委托租约无效');
    const pending = refreshing.get(request.id) || (async () => {
      const entry = codexEntries('chatgpt').find(item => item.key === request.id);
      if (!entry) throw new Error('共享账号不存在');
      if (fingerprint(entry.auth.tokens.access_token).slice(0, 16) !== request.expected) return { snapshot: vault.export() };
      const fresh = await renew(entry.auth);
      // Save on the egress node before replying: a lost reply must not lose a rotated grant.
      vault.rotate(entry.key, fresh, entry.auth); await codex.updated?.(entry.auth, fresh); install();
      return { snapshot: vault.export() };
    })().finally(() => refreshing.delete(request.id));
    refreshing.set(request.id, pending);
    return { publicKey: transport.publicKey, sealed: transport.seal(await pending, publicKey) };
  }
  async function renewWithEgress(entry) {
    let failure;
    try { return await renew(entry.auth); } catch (error) { failure = error; }
    if (!coordination || failure.status === 400 || failure.status === 401) throw failure;
    const connected = peers().slice().sort((a, b) => Number(b.id === entry.source) - Number(a.id === entry.source));
    for (const { id, peer } of connected) {
      if (!coordination.canRefresh()) throw new Error('账号刷新主节点已切换，请稍后重试');
      try {
        const key = await peer.call('accounts.key', {}, { timeout: 3000 });
        const input = { id: entry.key, expected: fingerprint(entry.auth.tokens.access_token).slice(0, 16), term: coordination.term() };
        const result = await peer.call('accounts.renew', { publicKey: transport.publicKey, sealed: transport.seal(input, key.publicKey) }, { timeout: 20000 });
        vault.merge(transport.open(result.sealed, result.publicKey).snapshot);
        const fresh = vault.credential(entry.key, entry.auth);
        if (fresh.tokens.access_token === entry.auth.tokens.access_token) throw new Error('出网节点未返回更新后的登录');
        return fresh;
      } catch (error) { failure = error; }
    }
    throw failure;
  }
  async function refreshAtLeader({ id, expected = '', force = false }) {
    if (coordination && !coordination.canRefresh()) throw new Error('当前节点没有账号刷新租约');
    if (refreshing.has(id)) return refreshing.get(id);
    const pending = (async () => {
      observe();
      const isClaude = id.startsWith('claude-sub:');
      const entry = (isClaude ? claudeEntries() : codexEntries('chatgpt')).find(item => item.key === id);
      if (!entry) throw new Error('共享账号不存在');
      const currentHash = fingerprint(isClaude ? entry.auth.claudeAiOauth.accessToken : entry.auth.tokens.access_token).slice(0, 16);
      if (expected && expected !== currentHash || !force && !(isClaude ? claudeCredentials.expiresSoon(entry.auth, now()) : expiresSoon(entry.auth, now()))) return { snapshot: vault.export() };
      const lease = vault.lease(id);
      if (lease?.until > now() && lease.holder !== identity().id) throw new Error('其他节点正在刷新此共享登录，请稍后重试');
      vault.claim(id, now() + 60000);
      await replicateQuorum();
      if (coordination && !coordination.canRefresh()) throw new Error('账号刷新主节点已切换，请稍后重试');
      try {
        const auth = await (isClaude ? renewClaude(entry.auth) : renewWithEgress(entry));
        // Persist the rotated refresh token even if leadership changed during
        // the HTTP exchange. Dropping it would lose the grant entirely.
        vault.rotate(id, auth, entry.auth);
        if (isClaude) await claude.updated?.(entry.auth, auth); else await codex.updated?.(entry.auth, auth);
        await replicateQuorum();
        return { snapshot: vault.export() };
      } finally { vault.claim(id, 0); await Promise.all(peers().map(syncPeer)); install(); }
    })().finally(() => refreshing.delete(id));
    refreshing.set(id, pending); return pending;
  }
  async function renewEntry(entry, force) {
    const request = { id: entry.key, expected: fingerprint(entry.auth.claudeAiOauth?.accessToken || entry.auth.tokens?.access_token).slice(0, 16), force };
    let response;
    if (!coordination || coordination.canRefresh()) response = await refreshAtLeader(request);
    else { const packet = await coordination.refresh({ ...request, publicKey: transport.publicKey }); response = transport.open(packet.sealed, packet.publicKey); }
    vault.merge(response.snapshot); vault.preference('codex-health:' + entry.key, { cooldownUntil: 0, lastStatus: 200 }); install();
  }
  async function resolveCodex(mode, sessionId = '', excluded = [], forced = '', options = {}) {
    await refresh();
    // An auth rejection may mean revocation before JWT expiry. Refresh once
    // for that token generation; retries never loop indefinitely.
    if (mode === 'chatgpt' && excluded.length) {
      const rejected = codexEntries(mode).find(entry => [401, 403].includes(vault.preference('codex-health:' + entry.key)?.lastStatus) && excluded.includes(routeFor(entry, mode).id) && excluded.filter(id => id.startsWith(entry.key + ':')).length < 2);
      if (rejected?.auth.tokens.refresh_token) { try { await renewEntry(rejected, true); } catch {} }
    }
    let selected = codexRoute(mode, sessionId, excluded, forced, options);
    if (selected && selected.authMode !== 'chatgpt') return selected;
    const entry = selected ? codexEntries('chatgpt').find(item => item.key === selected.accountId) : codexEntries('chatgpt').find(item => (!forced || item.key === forced) && item.auth.tokens.refresh_token && !excluded.some(id => id.startsWith(item.key + ':')));
    if (entry && (!selected || expiresSoon(entry.auth, now()))) {
      try { await renewEntry(entry, false); selected = codexRoute(mode, sessionId, excluded, forced, options); }
      catch (error) { if (!selected) throw error; }
    }
    return selected;
  }
  function status() {
    const online = new Set([identity().id, ...peers().map(peer => peer.id)]);
    return origins().map(source => ({ id: source.id, label: source.label || source.id, local: source.id === identity().id, online: online.has(source.id), replicated: true,
      claudeAccounts: (source.claude || []).filter(a => a.enabled).length + Object.values(vault.claudeAccounts()).filter(a=>!a.deleted&&a.enabled&&a.origin===source.id).length,
      bridgeAccounts: (source.claude || []).filter(a => a.enabled && loopback(a.url)).length,
      codexModes: ['chatgpt', 'api-key'].filter(mode => codexEntries(mode).some(entry => entry.source === source.id && codexCredentials(entry.auth, mode))),
    }));
  }
  for (const source of origins()) vault.importCodex(source.codex, { origin: source.id });
  observe(); install();
  accounts.setPreparation?.(prepareClaude);
  accounts.setRoutingObserver?.(input => { if (input.selected || input.mode!=='manual') setClaudeRouting(input); });
  return { setClaudeRouting, observeNative: (source, input) => { for(const auth of (Array.isArray(input.claude)?input.claude:[input.claude]))if(auth)vault.importClaude(auth,{origin:source}); for(const auth of (Array.isArray(input.codex)?input.codex:[input.codex]))if(auth)vault.importCodex(auth,{origin:source}); install(); }, claudeStatus, importClaude, configureClaude, prepareClaude, catalog, egress: excluded => { const candidate = [...sources].filter(([id, source]) => !excluded.includes(id) && source.catalog?.codex?.token).sort(([a], [b]) => a.localeCompare(b))[0]; return candidate ? { id: candidate[0], url: candidate[1].url, token: candidate[1].catalog.codex.token } : null; }, codexStatus, resetCodex: () => { for (const entry of Object.values(vault.codexAccounts())) vault.preference('codex-health:' + entry.id, { cooldownUntil: 0, lastStatus: 0 }); return codexStatus(); }, setRouting, pinCodex, importCodex, configureCodex, accepted, rejected, exchange, exchangeWire, refreshWire, renewWire, exchangeKey: () => ({ publicKey: transport.publicKey }), refresh, refreshAtLeader, resolveCodex, codexRoute, status, vault };
}
module.exports = { createAccountPool };
