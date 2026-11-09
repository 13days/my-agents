'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { upstreamNetwork } = require('./upstream-network');
const crypto = require('crypto');
const { modelDefaults } = require('./model-defaults');
const HOP = new Set(['host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length']);
const ROUTED_ENV = new Set(['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL']);
function parseEnvInput(input) {
  let parsed = input;
  if (typeof input === 'string') {
    const raw = input.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```$/, '').trim();
    try { parsed = JSON.parse(raw); }
    catch { try { parsed = JSON.parse('{' + raw.replace(/,\s*$/, '') + '}'); } catch { throw new Error('env JSON 格式无效，请参考示例'); } }
  }
  const source = parsed?.env ?? parsed;
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('env 必须是 JSON 对象');
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key) || !['string', 'number', 'boolean'].includes(typeof value)) throw new Error('环境变量名称无效，值必须是文本、数字或布尔值');
    env[key] = String(value);
  }
  const token = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY;
  if (!token) throw new Error('请在 env 中填写 ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY');
  const modelMap = {};
  for (const [key, family] of [['ANTHROPIC_DEFAULT_OPUS_MODEL', 'opus'], ['ANTHROPIC_DEFAULT_SONNET_MODEL', 'sonnet'], ['ANTHROPIC_DEFAULT_HAIKU_MODEL', 'haiku'], ['ANTHROPIC_MODEL', '*']]) if (env[key]) modelMap[family] = env[key];
  return { env, url: env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com', token, authType: env.ANTHROPIC_AUTH_TOKEN ? 'bearer' : 'api-key', modelMap };
}
function cleanHeaders(headers) {
  const skip = new Set([...HOP, ...String(headers.connection || '').toLowerCase().split(',').map(s => s.trim())]);
  return Object.fromEntries(Object.entries(headers).filter(([k]) => !skip.has(k.toLowerCase())));
}
function atomicJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
// Claude Code puts the session id in metadata.user_id ("…_session_<uuid>" or a JSON string with session_id).
function sessionIdOf(parsed) {
  const uid = parsed?.metadata?.user_id;
  const m = typeof uid === 'string' && uid.match(/session(?:_id)?["':\s_]*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return m ? m[1].toLowerCase() : '';
}
const SESSION_ROUTES_MAX = 500, LIVE_TTL = 30 * 60 * 1000;
function createRouter({ dir, claudeDir = dir, port, record = () => {}, reserveCapture = () => ({}) }) {
  const file = path.join(dir, 'panel-proxy.json');
  let config = { mode: 'manual', selected: '', accounts: [], localToken: crypto.randomBytes(32).toString('hex') };
  if (fs.existsSync(file)) config = { ...config, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  if (!config.sessionRoutes || typeof config.sessionRoutes !== 'object' || Array.isArray(config.sessionRoutes)) config.sessionRoutes = {};
  let shared = [];
  const accountsOf = () => [...config.accounts, ...shared];
  const health = new Map();
  const live = new Map(); // sessionId -> { accountId, accountName, inflight, lastAt, lastStatus, model, pinned }
  const modelCache = new Map();
  let cursor = 0, lastUsed = '';
  const localURL = `http://127.0.0.1:${port}`;
  function connectionStatus() {
    try {
      const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
      const env = settings.env || {};
      const base = (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
      const connected = base === localURL && env.ANTHROPIC_AUTH_TOKEN === config.localToken;
      return { connected, canImport: base !== localURL && !!(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY), currentHost: new URL(base).host };
    } catch { return { connected: false, canImport: false, currentHost: '' }; }
  }
  function status() {
    return { mode: config.mode, selected: config.selected, lastUsed, proxyURL: localURL, connection: connectionStatus(),
      accounts: accountsOf().map(({ token, env, delegateAccount, ...a }) => ({ ...a, envKeys: Object.keys(env || {}), clientEnvKeys: Object.keys(env || {}).filter(k => !ROUTED_ENV.has(k)), hasToken: !!token, ...(health.get(a.id) || {}) })) };
  }
  function save(input) {
    if (!['manual', 'failover', 'round-robin'].includes(input.mode) || !Array.isArray(input.accounts)) throw new Error('请选择有效路由模式和账号列表');
    const ids = new Set();
    const accounts = input.accounts.filter(source => !shared.some(a => a.id === source.id)).map(source => {
      const parsed = source.env === undefined ? null : parseEnvInput(source.env);
      const a = parsed ? { ...parsed, ...source, env: parsed.env } : source;
      const id = a.id || crypto.randomUUID();
      if (typeof id !== 'string' || ids.has(id)) throw new Error('账号 ID 重复或无效');
      ids.add(id);
      if (typeof a.name !== 'string' || !a.name.trim() || a.name.length > 100) throw new Error('请填写账号名称（最多 100 字）');
      let url;
      try { url = new URL(a.url); } catch { throw new Error('上游地址无效'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('上游地址仅支持无凭证、无查询参数的 HTTP(S) URL');
      if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && Number(url.port || (url.protocol === 'https:' ? 443 : 80)) === Number(port)) throw new Error('上游不能指向代理自身');
      const old = config.accounts.find(x => x.id === id);
      const token = a.token === undefined || a.token === '' ? old?.token || '' : a.token;
      if (typeof token !== 'string' || /[\r\n]/.test(token)) throw new Error('Token 无效');
      const authType = a.authType || 'bearer';
      if (!['bearer', 'api-key', 'passthrough'].includes(authType)) throw new Error('认证方式无效');
      if (authType !== 'passthrough' && !token) throw new Error('请填写账号 Token');
      const modelMap = a.modelMap || {};
      if (typeof modelMap !== 'object' || Array.isArray(modelMap) || Object.entries(modelMap).some(([k, v]) => !k || typeof v !== 'string' || !v.trim())) throw new Error('模型映射必须是字符串 JSON 对象');
      const env = { ...(a.env === undefined ? old?.env || {} : a.env) };
      if (Object.keys(env).length) {
        env.ANTHROPIC_BASE_URL = url.href.replace(/\/$/, '');
        if (authType === 'bearer') { env.ANTHROPIC_AUTH_TOKEN = token; if (Object.hasOwn(env, 'ANTHROPIC_API_KEY')) env.ANTHROPIC_API_KEY = ''; }
        if (authType === 'api-key') { env.ANTHROPIC_API_KEY = token; if (Object.hasOwn(env, 'ANTHROPIC_AUTH_TOKEN')) env.ANTHROPIC_AUTH_TOKEN = ''; }
        for (const [key, family] of [['ANTHROPIC_DEFAULT_OPUS_MODEL', 'opus'], ['ANTHROPIC_DEFAULT_SONNET_MODEL', 'sonnet'], ['ANTHROPIC_DEFAULT_HAIKU_MODEL', 'haiku'], ['ANTHROPIC_MODEL', '*']]) {
          if (modelMap[family]) env[key] = modelMap[family]; else delete env[key];
        }
      }
      return { id, name: a.name.trim(), url: url.href.replace(/\/$/, ''), token, authType, enabled: a.enabled !== false, modelMap, env };
    });
    const selected = input.selected || '';
    if (selected && ![...accounts, ...shared].some(a => a.id === selected && a.enabled)) throw new Error('选中账号不存在或已禁用');
    if (input.mode === 'manual' && accounts.some(a => a.enabled) && !selected) throw new Error('手动模式请选择一个启用账号');
    const next = { ...config, mode: input.mode, selected, accounts };
    const settingsChange = connectionStatus().connected ? prepareClientEnv(next) : null;
    atomicJSON(file, next);
    for (const a of accounts) {
      const old = config.accounts.find(x => x.id === a.id);
      if (!old || old.url !== a.url || old.token !== a.token || old.authType !== a.authType) health.delete(a.id);
    }
    config = next;
    if (settingsChange?.changed) {
      try { atomicJSON(path.join(claudeDir, 'settings.json'), settingsChange.settings); }
      catch (e) { throw new Error('账号已保存，但 Claude 环境变量写入失败：' + e.code); }
    }
    cursor = 0;
    for (const id of health.keys()) if (!accounts.some(a => a.id === id)) health.delete(id);
    return { ...status(), restartRequired: !!settingsChange?.changed };
  }
  function prepareClientEnv(next, original) {
    const settings = original || JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
    const env = { ...(settings.env || {}) };
    const before = JSON.stringify(env);
    const account = next.accounts.find(a => a.id === next.selected && a.enabled) || next.accounts.find(a => a.enabled);
    const desired = Object.fromEntries(Object.entries(account?.env || {}).filter(([k]) => !ROUTED_ENV.has(k)));
    const baseline = { ...(next.envBaseline || {}) };
    for (const key of next.managedEnvKeys || []) {
      if (!Object.hasOwn(desired, key)) {
        if (baseline[key]?.exists) env[key] = baseline[key].value;
        else delete env[key];
      }
    }
    for (const [key, value] of Object.entries(desired)) {
      if (!Object.hasOwn(baseline, key)) baseline[key] = { exists: Object.hasOwn(env, key), value: env[key] };
      env[key] = value;
    }
    next.envBaseline = baseline;
    next.managedEnvKeys = Object.keys(desired);
    return { settings: { ...settings, env }, changed: before !== JSON.stringify(env) };
  }
  function importSettings() {
    const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
    const env = settings.env || {};
    const url = env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
    const token = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY;
    if (!url || !token || url.replace(/\/$/, '') === localURL) throw new Error('settings.json 中没有可导入的上游 env');
    const existing = config.accounts.find(a => a.url === url.replace(/\/$/, '') && a.token === token);
    if (existing) return save({ ...config, selected: config.selected || existing.id, accounts: config.accounts.map(({ env: stored, ...a }) => a.id === existing.id ? { ...a, ...parseEnvInput(env), enabled: true } : a) });
    const id = crypto.randomUUID();
    const modelMap = {};
    for (const [key, family] of [['ANTHROPIC_DEFAULT_OPUS_MODEL', 'opus'], ['ANTHROPIC_DEFAULT_SONNET_MODEL', 'sonnet'], ['ANTHROPIC_DEFAULT_HAIKU_MODEL', 'haiku'], ['ANTHROPIC_MODEL', '*']]) {
      if (env[key]) modelMap[family] = env[key];
    }
    return save({ ...config, selected: config.selected || id, accounts: [...config.accounts.map(({ env: stored, ...a }) => a), { id, name: new URL(url).hostname + ' · ' + (config.accounts.length + 1), url, token, authType: env.ANTHROPIC_AUTH_TOKEN ? 'bearer' : 'api-key', modelMap, env }] });
  }
  function setup() {
    const settingsFile = path.join(claudeDir, 'settings.json');
    const settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {};
    // Preserve the old upstream before replacing credentials.
    if (connectionStatus().canImport) importSettings();
    if (!accountsOf().some(a => a.enabled && a.authType !== 'passthrough')) throw new Error('未检测到可用的 API 账号，请先添加服务地址和 Token，再一键配置');
    if (connectionStatus().connected) return { ok: true, backup: null, proxyURL: localURL, alreadyConfigured: true };
    const applied = prepareClientEnv(config, settings);
    const env = applied.settings.env;
    atomicJSON(file, config);
    const backup = settingsFile + '.proxy-backup-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');
    if (fs.existsSync(settingsFile)) {
      fs.copyFileSync(settingsFile, backup, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(backup, 0o600);
    }
    env.ANTHROPIC_BASE_URL = localURL;
    env.ANTHROPIC_AUTH_TOKEN = config.localToken;
    delete env.ANTHROPIC_API_KEY;
    atomicJSON(settingsFile, { ...settings, env });
    return { ok: true, backup: fs.existsSync(backup) ? backup : null, proxyURL: localURL };
  }
  function handle(req, res) {
    if (req.headers.origin) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '模型代理不接受浏览器跨域请求' }));
      return;
    }
    const requestInfo = reserveCapture();
    let activeRequest, cancelCapture;
    const cancel = () => { cancelCapture?.(); activeRequest?.destroy(); };
    res.on('close', cancel);
    const chunks = [];
    let size = 0;
    req.on('error', cancel);
    req.on('data', c => {
      size += c.length;
      if (size > 32 * 1024 * 1024) { res.writeHead(413); res.end(); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      if (res.destroyed) return;
      const body = Buffer.concat(chunks), started = Date.now();
      const snapshot = { ...config, mode: config.mode === 'manual' && !config.selected && shared.length ? 'failover' : config.mode, accounts: accountsOf() };
      const isOAuth = /^\/(?:v1|api)\/oauth\//.test(req.url);
      const enabled = snapshot.accounts.filter(a => a.enabled);
      let sessionId = '', model = '';
      try { const parsed = JSON.parse(body.toString()); sessionId = sessionIdOf(parsed); model = typeof parsed.model === 'string' ? parsed.model : ''; } catch {}
      requestInfo.sessionId = sessionId;
      requestInfo.method = req.method;
      const delegated = req.headers['x-my-agents-account'];
      const trusted = req.headers.authorization === 'Bearer ' + config.localToken || req.headers['x-api-key'] === config.localToken;
      if (delegated && (!trusted || !config.accounts.some(a => a.id === delegated && a.enabled))) { res.writeHead(403); return res.end(JSON.stringify({ error: '共享账号不可用或转发凭证无效' })); }
      const pinned = !isOAuth ? (delegated ? config.accounts.find(a => a.id === delegated) : sessionId && enabled.find(a => a.id === snapshot.sessionRoutes?.[sessionId])) : null;
      // With no configured accounts, retain the original Inspector passthrough.
      let candidates = pinned ? [pinned] : !snapshot.accounts.length || isOAuth ? [{ id: '', name: 'Anthropic', url: isOAuth && req.url.startsWith('/v1/oauth/') ? 'https://platform.claude.com' : 'https://api.anthropic.com', authType: 'passthrough', modelMap: {} }]
        : snapshot.mode === 'manual' ? (snapshot.selected ? enabled.filter(a => a.id === snapshot.selected) : enabled)
        : enabled.filter(a => (health.get(a.id)?.cooldownUntil || 0) <= Date.now());
      if (snapshot.mode === 'round-robin' && candidates.length && !isOAuth && !pinned) {
        const offset = cursor++ % candidates.length;
        candidates = candidates.slice(offset).concat(candidates.slice(0, offset));
      }
      // Only real turns (not count_tokens) mark a session as running.
      if (sessionId && /\/messages(\?|$)/.test(req.url)) {
        const entry = live.get(sessionId) || { inflight: 0 };
        entry.inflight++; entry.lastAt = Date.now(); entry.model = model || entry.model; entry.pinned = !!pinned;
        live.set(sessionId, entry);
        let done = false;
        res.on('close', () => { if (!done) { done = true; entry.inflight = Math.max(0, entry.inflight - 1); entry.lastAt = Date.now(); } });
      }
      let lastAttemptCaptured = false;
      const fail = (code, message) => {
        if (res.headersSent) return res.destroy();
        res.writeHead(code, { 'Content-Type': 'application/json' });
        const errorBody = Buffer.from(JSON.stringify({ type: 'error', error: { type: 'api_error', message } }));
        if (!lastAttemptCaptured) { lastAttemptCaptured = true; try { record(req.url, code, Date.now() - started, body, errorBody, false, req.headers, '', '', '', { ...requestInfo, routing: { mode: snapshot.mode, reason: 'local_error', attempt: 0, requestedModel: model } }); } catch {} }
        res.end(errorBody);
      };
      // Never send the local proxy credential to an OAuth service.
      if (isOAuth && (req.headers.authorization === 'Bearer ' + snapshot.localToken || req.headers['x-api-key'] === snapshot.localToken)) return fail(400, '本地代理凭证不能用于 OAuth，请使用 API Token 模式');
      let index = 0;
      function attempt() {
        if (res.destroyed) return;
        lastAttemptCaptured = false;
        const account = candidates[index++];
        if (!account) return fail(503, '没有可用账号：请检查启用状态、手动选择或冷却时间');
        const entry = sessionId && live.get(sessionId);
        if (entry) Object.assign(entry, { accountId: account.id, accountName: account.name });
        const target = new URL(account.url);
        const attemptInfo = { ...(index === 1 ? requestInfo : reserveCapture()), requestOrder: requestInfo.id, sessionId, method: req.method,
          routing: { mode: snapshot.mode, reason: pinned ? 'session_pin' : !snapshot.accounts.length || isOAuth ? 'passthrough' : snapshot.mode === 'manual' ? 'manual' : index > 1 ? 'failover' : snapshot.mode, attempt: index, requestedModel: model, actualModel: model } };
        const saveAttempt = (code, responseBody, stream = false, encoding = '', incomplete = false) => {
          if (lastAttemptCaptured) return; lastAttemptCaptured = true;
          try { record(req.url, code, Date.now() - started, data, responseBody, stream, req.headers, encoding, account.id, account.name, { ...attemptInfo, incomplete }); } catch {}
        };
        cancelCapture = () => saveAttempt(499, Buffer.from('{"error":"client disconnected before response"}'), false, '', true);
        let data = body;
        try {
          const parsed = JSON.parse(body.toString());
          if (typeof parsed.model === 'string') {
            const map = account.modelMap;
            const key = Object.keys(map).find(k => k !== '*' && parsed.model.toLowerCase().includes(k.toLowerCase()));
            const mapped = map[parsed.model] || map[key] || map['*'];
            if (mapped) { parsed.model = mapped; attemptInfo.routing.actualModel = mapped; data = Buffer.from(JSON.stringify(parsed)); }
          }
        } catch {}
        const headers = cleanHeaders(req.headers);
        delete headers['x-my-agents-account'];
        if (account.delegateAccount) headers['x-my-agents-account'] = account.delegateAccount;
        delete headers['accept-encoding'];
        headers['accept-encoding'] = 'identity';
        headers['content-length'] = data.length;
        if (account.authType !== 'passthrough') {
          delete headers.authorization;
          delete headers['x-api-key'];
          if (account.authType === 'api-key') headers['x-api-key'] = account.token;
          else headers.authorization = 'Bearer ' + account.token;
          if (headers['anthropic-beta']) {
            headers['anthropic-beta'] = headers['anthropic-beta'].split(',').filter(b => !b.trim().startsWith('oauth-')).join(',');
            if (!headers['anthropic-beta']) delete headers['anthropic-beta'];
          }
        } else if (headers.authorization === 'Bearer ' + snapshot.localToken || headers['x-api-key'] === snapshot.localToken) {
          return fail(401, '透传账号需要客户端的真实凭证，不能使用本地代理 Token');
        }
        const requestPath = target.pathname.replace(/\/$/, '') + (req.url.startsWith('/') ? req.url : '/' + req.url);
        let moved = false;
        const cool = status => {
          const seconds = status === 429 || status === 402 ? 60 : status === 401 || status === 403 ? 300 : 15;
          health.set(account.id, { ...health.get(account.id), lastStatus: status, cooldownUntil: Date.now() + seconds * 1000 });
        };
        const upstream = (target.protocol === 'https:' ? https : http).request({ ...upstreamNetwork, timeout: 120000, protocol: target.protocol, hostname: target.hostname, port: target.port || undefined, path: requestPath, method: req.method, headers }, response => {
          if (res.destroyed) { response.destroy(); return; }
          const code = response.statusCode;
          const retry = [401, 402, 403, 429, 500, 502, 503, 504, 529].includes(code);
          if (retry) {
            cool(code);
            const retryAfter = response.headers['retry-after'];
            const delay = /^\d+(\.\d+)?$/.test(retryAfter || '') ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
            if (delay > 0) health.get(account.id).cooldownUntil = Date.now() + Math.min(delay, 86400000);
          }
          const shouldRetry = retry && index < candidates.length && snapshot.mode !== 'manual' && !isOAuth && !pinned;
          const captured = [];
          let finished = false;
          const saveResponse = incomplete => { if (finished) return; finished = true; saveAttempt(code, Buffer.concat(captured), String(response.headers['content-type']).includes('event-stream'), response.headers['content-encoding'], incomplete); };
          cancelCapture = () => saveResponse(true);
          response.on('data', c => captured.push(c));
          response.on('end', () => { saveResponse(false); if (shouldRetry && !res.destroyed) { moved = true; attempt(); } });
          response.on('close', () => saveResponse(!response.complete));
          response.on('error', () => { saveResponse(true); res.destroy(); });
          if (shouldRetry) { response.resume(); return; }
          if (!retry) health.set(account.id, { lastStatus: code, cooldownUntil: 0, lastUsedAt: Date.now() });
          lastUsed = account.id;
          if (sessionId) {
            const entry = live.get(sessionId);
            if (entry) Object.assign(entry, { accountId: account.id, accountName: account.name, lastStatus: code, lastAt: Date.now() });
          }
          res.writeHead(code, cleanHeaders(response.headers));
          response.pipe(res);
        });
        activeRequest = upstream;
        upstream.setTimeout(120000, () => upstream.destroy(new Error('upstream timeout')));
        upstream.on('error', () => {
          if (moved || res.destroyed) return;
          saveAttempt(502, Buffer.from(JSON.stringify({ error: '上游连接失败或超时' })));
          cool(502);
          if (!res.headersSent && index < candidates.length && snapshot.mode !== 'manual' && !isOAuth && !pinned) { moved = true; attempt(); }
          else fail(502, '上游连接失败或超时');
        });
        upstream.end(data);
      }
      attempt();
    });
  }
  function clientEnv() {
    if (!accountsOf().some(a => a.enabled && a.authType !== 'passthrough')) return null;
    return { ANTHROPIC_BASE_URL: localURL, ANTHROPIC_AUTH_TOKEN: config.localToken, ANTHROPIC_API_KEY: '' };
  }
  async function modelEnvForSession(sessionId) {
    const pinned = config.sessionRoutes[sessionId];
    const account = accountsOf().find(a => a.enabled && a.id === (pinned || config.selected)) || accountsOf().find(a => a.enabled);
    if (!account || account.authType === 'passthrough' || account.modelMap['*']) return {};
    const explicit = { ...(process.env || {}), ...(account.env || {}) };
    for (const family of ['OPUS', 'SONNET', 'HAIKU']) if (account.modelMap[family.toLowerCase()]) explicit[`ANTHROPIC_DEFAULT_${family}_MODEL`] = account.modelMap[family.toLowerCase()];
    return modelDefaults((await discoverModels(account, sessionId, !!pinned)).map(model => model.id), explicit);
  }
  async function discoverModels(account, sessionId = '', pinned = false) {
    const cacheKey = account.id + account.url + account.token;
    let entry = modelCache.get(cacheKey);
    if (!entry || Date.now() - entry.at > 5 * 60 * 1000) {
      const request = (async () => {
        try {
          const url = account.url.replace(/\/$/, '') + (new URL(account.url).pathname.endsWith('/v1') ? '/models' : '/v1/models');
          const headers = { 'anthropic-version': '2023-06-01', ...(account.delegateAccount ? { 'x-my-agents-account': account.delegateAccount } : {}) };
          if (account.authType === 'api-key') headers['x-api-key'] = account.token; else headers.authorization = `Bearer ${account.token}`;
          const startedAt = Date.now(), info = { ...reserveCapture(), sessionId, method: 'GET', routing: { mode: config.mode, reason: pinned ? 'session_pin' : 'model_discovery', attempt: 1, requestedModel: '', actualModel: '' } };
          let response, text;
          try { response = await fetch(url, { headers, signal: AbortSignal.timeout(3000) }); text = await response.text(); }
          catch { try { record(new URL(url).pathname, 502, Date.now() - startedAt, Buffer.alloc(0), Buffer.from('{"error":"model discovery failed"}'), false, {}, '', account.id, account.name, info); } catch {} return []; }
          try { record(new URL(url).pathname, response.status, Date.now() - startedAt, Buffer.alloc(0), Buffer.from(text), false, {}, '', account.id, account.name, info); } catch {}
          if (!response.ok) return [];
          const body = JSON.parse(text); return (Array.isArray(body.data) ? body.data : []).filter(model => model && typeof model.id === 'string' && model.id.trim()).map(model => ({ id: model.id, name: typeof (model.display_name || model.name) === 'string' ? (model.display_name || model.name) : model.id }));
        } catch { return []; }
      })();
      entry = { at: Date.now(), request }; modelCache.set(cacheKey, entry);
    }
    return entry.request;
  }
  async function models({ accountId = '', sessionId = '', refresh = false } = {}) {
    const pinned = config.sessionRoutes[String(sessionId).toLowerCase()];
    const account = accountId ? accountsOf().find(a => a.enabled && a.id === accountId) : accountsOf().find(a => a.enabled && a.id === (pinned || config.selected)) || accountsOf().find(a => a.enabled);
    if (accountId && !account) throw new Error('账号不存在或已禁用');
    if (!account || account.authType === 'passthrough') return { models: [], accountName: account?.name || '', forcedModel: '' };
    if (refresh) modelCache.delete(account.id + account.url + account.token);
    return { models: await discoverModels(account, sessionId, !!pinned), accountName: account.name, forcedModel: account.modelMap['*'] || '' };
  }

  // Live view of sessions that recently went through the proxy, plus per-session account pins.
  function sessions() {
    const now = Date.now();
    for (const [id, e] of live) if (!e.inflight && now - e.lastAt > LIVE_TTL) live.delete(id);
    const items = [...live].map(([id, e]) => ({ id, ...e, running: e.inflight > 0, routeAccountId: config.sessionRoutes[id] || '' }));
    return { items, routes: { ...config.sessionRoutes }, accounts: accountsOf().map(a => ({ id: a.id, name: a.name, enabled: a.enabled })), mode: config.mode, selected: config.selected };
  }
  function setSessionRoute(sessionId, accountId) {
    if (typeof sessionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) throw new Error('会话 ID 无效');
    const id = sessionId.toLowerCase();
    const routes = { ...config.sessionRoutes };
    if (!accountId) delete routes[id];
    else {
      if (!accountsOf().some(a => a.id === accountId && a.enabled)) throw new Error('账号不存在或已禁用');
      delete routes[id]; routes[id] = accountId;
      const keys = Object.keys(routes);
      for (const k of keys.slice(0, Math.max(0, keys.length - SESSION_ROUTES_MAX))) delete routes[k];
    }
    const next = { ...config, sessionRoutes: routes };
    atomicJSON(file, next);
    config = next;
    return sessions();
  }
  // Switch mode / selected account without touching stored credentials (used by Feishu /route).
  function route({ mode = config.mode, selected = config.selected } = {}) {
    if (!accountsOf().some(a => a.id === selected && a.enabled)) selected = '';
    return save({ mode, selected, accounts: accountsOf().map(({ token, env, delegateAccount, ...a }) => a) });
  }
  return { sharedCatalog: () => ({ token: config.localToken, accounts: config.accounts.filter(a => a.enabled && a.authType !== 'passthrough').map(({ id, name, modelMap }) => ({ id, name, modelMap })) }), setShared: accounts => { shared = accounts; }, status, save, route, importSettings, setup, handle, clientEnv, modelEnvForSession, models, sessions, setSessionRoute, reset: () => { health.clear(); return status(); } };
}
module.exports = { createRouter, parseEnvInput };
