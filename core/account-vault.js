const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Replicas merge per-source revisions. A missing source stays cached; an
// explicit empty revision removes its accounts. Credentials never go in the
// ordinary cluster snapshot, browser API or logs.
function createAccountVault({ dir, secret, fallbackSecret, nodeId, now = Date.now }) {
  const derive = value => crypto.hkdfSync('sha256', Buffer.from(value), Buffer.from('my-agents/account-pool/v1'), Buffer.from('credentials'), 32);
  const key = derive(secret);
  const file = dir && path.join(dir, 'panel-account-vault.enc');
  let migrated = false;
  let state = { clock: 0, origins: {}, rotations: {}, leases: {}, codexAccounts: {}, claudeAccounts: {}, preferences: {}, observed: '' };
  function seal(value) {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), body: body.toString('base64') };
  }
  function open(box, readKey = key) {
    if (box?.version !== 1 || typeof box.body !== 'string' || box.body.length > 8 * 1024 * 1024) throw new Error('共享账号密文无效');
    const decipher = crypto.createDecipheriv('aes-256-gcm', readKey, Buffer.from(box.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(box.body, 'base64')), decipher.final()]).toString());
  }
  if (file && fs.existsSync(file)) {
    try { state = open(JSON.parse(fs.readFileSync(file, 'utf8'))); }
    catch { try { if (!fallbackSecret) throw new Error(); state = open(JSON.parse(fs.readFileSync(file, 'utf8')), derive(fallbackSecret)); migrated = true; } catch { throw new Error('共享账号库无法解密；请恢复原集群密钥，本次未覆盖凭证'); } }
  }
  function persist() {
    if (!file) return;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temporary = file + '.' + crypto.randomUUID() + '.tmp';
    try { fs.writeFileSync(temporary, JSON.stringify(seal(state)), { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file); }
    finally { fs.rmSync(temporary, { force: true }); }
  }
  if (migrated) persist();
  const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  function observe(payload) {
    const hash = digest(payload);
    if (state.observed === hash && state.origins[nodeId]) return false;
    state.observed = hash;
    state.origins[nodeId] = { revision: ++state.clock, writer: nodeId, payload, at: now() };
    persist(); return true;
  }
  const newer = (incoming, current) => !current || incoming.revision > current.revision || incoming.revision === current.revision && String(incoming.writer) > String(current.writer);
  function merge(box) {
    let remote;
    try { remote = open(box); } catch { throw new Error('共享账号同步认证失败'); }
    if (!remote.origins || !remote.rotations || !Number.isSafeInteger(remote.clock) || remote.clock < 0) throw new Error('共享账号版本无效');
    for (const rows of [remote.origins, remote.rotations, remote.leases || {}, remote.codexAccounts || {}, remote.claudeAccounts || {}, remote.preferences || {}]) {
      if (Object.keys(rows).length > 1000 || Object.values(rows).some(row => !row || !Number.isSafeInteger(row.revision) || row.revision < 0 || row.revision > remote.clock || typeof row.writer !== 'string')) throw new Error('共享账号记录无效');
    }
    let changed = false;
    for (const table of ['origins', 'rotations', 'leases', 'codexAccounts', 'claudeAccounts', 'preferences']) for (const [id, row] of Object.entries(remote[table] || {})) {
      if (['__proto__', 'prototype', 'constructor'].includes(id)) throw new Error('共享账号标识无效');
      if (newer(row, state[table][id])) { state[table][id] = row; changed = true; }
    }
    if (changed) { state.clock = Math.max(state.clock, remote.clock); persist(); }
    return changed;
  }
  state.leases ||= {}; state.codexAccounts ||= {}; state.claudeAccounts ||= {}; state.preferences ||= {};
  function claim(id, until) { state.leases[id] = { holder: nodeId, until, revision: ++state.clock, writer: nodeId }; persist(); }
  function rotate(id, auth, previous) {
    state.rotations[id] = { auth, previousHash: previous?.claudeAiOauth?.refreshToken || previous?.tokens?.refresh_token ? digest(previous.claudeAiOauth?.refreshToken || previous.tokens.refresh_token) : '', revision: ++state.clock, writer: nodeId, at: now() }; persist();
  }
  function importCodex(auth, { name = '', origin = nodeId, explicit = false } = {}) {
    const { accountId } = require('./codex-credentials');
    const result = [];
    for (const mode of ['chatgpt', 'api-key']) {
      if (mode === 'chatgpt' ? !auth?.tokens?.access_token : !auth?.OPENAI_API_KEY) continue;
      const id = accountId(auth, mode), old = state.codexAccounts[id];
      if ((old?.deleted || old?.authOverride) && !explicit) continue;
      if (!explicit && old && (digest(old.auth) === digest(auth) || issued(old.auth) > issued(auth))) { result.push(id); continue; }
      if (explicit) state.rotations[id] = { auth, previousHash: '', revision: ++state.clock, writer: nodeId, at: now() };
      if (old && digest(old.auth)!==digest(auth)) state.preferences['codex-health:'+id]={value:{cooldownUntil:0,lastStatus:0},revision:++state.clock,writer:nodeId};
      state.codexAccounts[id] = { ...old, id, mode, auth, name: name || old?.name || 'Codex ' + id.slice(-6), origin: old?.origin || origin, enabled: explicit ? true : old?.enabled !== false, deleted: false, revision: ++state.clock, writer: nodeId, at: now() };
      result.push(id); persist();
    }
    return result;
  }
  function configureCodex(id, input) {
    const old = state.codexAccounts[id]; if (!old || old.deleted) throw new Error('Codex 账号不存在');
    if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100)) throw new Error('账号名称应为 1 至 100 个字');
    if (input.proxyAuth) { state.rotations[id] = {auth:input.proxyAuth,previousHash:'',revision:++state.clock,writer:nodeId,at:now()}; }
    state.codexAccounts[id] = { ...old, ...(input.proxyAuth ? {auth:input.proxyAuth,authOverride:true} : {}), ...(input.name !== undefined ? { name: input.name.trim() } : {}), ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}), ...(input.deleted === true ? { deleted: true, enabled: false } : {}), revision: ++state.clock, writer: nodeId, at: now() }; persist();
  }
  function importClaude(input, { name = '', origin = nodeId, explicit = false } = {}) {
    const { normalizeClaudeAuth, claudeAccountId } = require('./claude-credentials');
    if (typeof name!=='string' || name.length>100) throw new Error('账号名称最多 100 个字');
    const auth = normalizeClaudeAuth(input);
    const matching = Object.values(state.claudeAccounts).find(row => row.auth?.claudeAiOauth?.accessToken === auth.claudeAiOauth.accessToken || state.rotations[row.id]?.auth?.claudeAiOauth?.accessToken === auth.claudeAiOauth.accessToken);
    const id = matching?.id || claudeAccountId(auth), old = state.claudeAccounts[id];
    if (old?.deleted && !explicit || !explicit && old && (digest(old.auth) === digest(auth) || issued(old.auth) > issued(auth))) return id;
    state.claudeAccounts[id] = { ...old, id, mode:'subscription', auth, origin:old?.origin || origin, name:name || old?.name || auth.emailAddress || 'Claude ' + id.slice(-6), enabled:explicit ? true : old?.enabled !== false, deleted:false, revision:++state.clock, writer:nodeId, at:now() };
    persist(); return id;
  }
  function configureClaude(id, input) {
    const old = state.claudeAccounts[id]; if (!old || old.deleted) throw new Error('Claude 账号不存在');
    if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100)) throw new Error('账号名称应为 1 至 100 个字');
    state.claudeAccounts[id] = { ...old, ...(input.name !== undefined ? {name:input.name.trim()} : {}), ...(typeof input.enabled === 'boolean' ? {enabled:input.enabled} : {}), ...(input.deleted === true ? {deleted:true,enabled:false} : {}), revision:++state.clock, writer:nodeId, at:now() }; persist();
  }
  function preference(id, value) {
    if (value === undefined) return state.preferences[id]?.value;
    state.preferences[id] = { value, revision: ++state.clock, writer: nodeId, at: now() }; persist(); return value;
  }
  const issued = auth => {
    let time = auth?.claudeAiOauth?.expiresAt || Date.parse(auth?.last_refresh || '') || 0;
    try { time = Math.max(time, (JSON.parse(Buffer.from(auth.tokens.access_token.split('.')[1], 'base64url')).iat || 0) * 1000); } catch {}
    return time;
  };
  function credential(id, auth) {
    const rotation = state.rotations[id];
    const grant=auth?.claudeAiOauth?.refreshToken || auth?.tokens?.refresh_token;
    return rotation && (grant && rotation.previousHash===digest(grant) || issued(rotation.auth)>=issued(auth)) ? rotation.auth : auth;
  }
  return { observe, merge, rotate, credential, importClaude, configureClaude, claudeAccounts: () => state.claudeAccounts, importCodex, configureCodex, preference, preferences: () => state.preferences, codexAccounts: () => state.codexAccounts, claim, rotation: id => state.rotations[id], matchesPrevious: (id, auth) => state.rotations[id]?.previousHash === digest(auth?.claudeAiOauth?.refreshToken || auth?.tokens?.refresh_token), lease: id => state.leases[id], export: () => seal({ ...state, observed: '' }), origins: () => state.origins, file };
}
module.exports = { createAccountVault };
