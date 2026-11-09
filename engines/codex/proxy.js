const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { upstreamNetwork } = require('../../upstream-network');

// Pass-through capture for Codex. Codex keeps its own credentials (ChatGPT
// subscription OAuth or OPENAI_API_KEY); the panel only relays the bytes and
// records request/response bodies. Header values are never persisted.
// Exception: Codex on a remote node has no login of its own. It sends the panel's
// relay token instead, which is swapped here for this machine's Codex credentials,
// so only this machine ever refreshes the (rotating) ChatGPT login.
const ROUTES = [
  { prefix: '/backend-api/codex/', origin: 'https://chatgpt.com', strip: '', mode: 'chatgpt' },
  { prefix: '/codex-openai/v1/', origin: 'https://api.openai.com', strip: '/codex-openai', mode: 'api-key' },
];
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host', 'content-length', 'accept-encoding']);

function routeFor(url) { return ROUTES.find(r => String(url || '').startsWith(r.prefix)) || null; }
function isCodexPath(url) { return !!routeFor(url); }

// Config overrides that point a Codex run at this proxy without touching ~/.codex/config.toml.
function codexProviderConfig(proxyPort, { apiKey = false } = {}) {
  const base = apiKey ? `http://127.0.0.1:${proxyPort}/codex-openai/v1` : `http://127.0.0.1:${proxyPort}/backend-api/codex`;
  // requires_openai_auth makes Codex attach its stored login (ChatGPT token or API key).
  return [`model_providers.panel={name="my-agents",base_url="${base}",wire_api="responses",requires_openai_auth=true}`, 'model_provider="panel"'];
}

// Same, for Codex on a remote node: `base` is the node's relay URL plus the route prefix,
// the relay token comes from MY_AGENTS_CODEX_TOKEN and never Codex's own (absent) login.
const RELAY_TOKEN_ENV = 'MY_AGENTS_CODEX_TOKEN';
function codexRelayConfig(base, { accountId = '' } = {}) {
  return [`model_providers.panel={name="my-agents",base_url="${base}",wire_api="responses",env_key="${RELAY_TOKEN_ENV}",requires_openai_auth=false${accountId ? ',http_headers={"x-my-agents-codex-account"=' + JSON.stringify(accountId) + '}' : ''}}`, 'model_provider="panel"'];
}

// Headers that replace the relay token, from this machine's ~/.codex/auth.json.
function codexCredentials(auth, mode) {
  if (mode === 'api-key') return auth?.OPENAI_API_KEY ? { authorization: `Bearer ${auth.OPENAI_API_KEY}` } : null;
  const tokens = auth?.tokens;
  if (!tokens?.access_token) return null;
  // A login file can outlive its access token. Do not advertise known-expired
  // JWTs as usable pool entries; opaque tokens are validated by the provider.
  try { const claims = JSON.parse(Buffer.from(tokens.access_token.split('.')[1], 'base64url').toString()); if (typeof claims.exp === 'number' && claims.exp * 1000 <= Date.now()) return null; } catch {}
  return { authorization: `Bearer ${tokens.access_token}`, ...(tokens.account_id ? { 'chatgpt-account-id': tokens.account_id } : {}) };
}
const sameSecret = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function textOf(content) {
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? content : []).map(b => typeof b === 'string' ? b : b?.text || (b?.type === 'input_image' ? '[image]' : '')).filter(Boolean).join('\n');
}
function summarizeItem(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.type === 'message' || (!item.type && item.role)) return { role: item.role, parts: [{ kind: 'text', text: textOf(item.content) }] };
  if (item.type === 'function_call' || item.type === 'custom_tool_call') return { role: 'assistant', parts: [{ kind: 'tool_use', name: item.namespace && item.namespace !== 'functions' ? `${item.namespace}.${item.name}` : item.name, input: item.type === 'custom_tool_call' ? String(item.input || '') : String(item.arguments || '') }] };
  if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') return { role: 'user', parts: [{ kind: 'tool_result', text: textOf(item.output) }] };
  if (item.type === 'additional_tools') return null;
  if (item.type === 'reasoning') return { role: 'assistant', parts: [{ kind: 'text', text: '[reasoning]' }] };
  return { role: item.role || 'system', parts: [{ kind: 'text', text: `[${item.type}]` }] };
}
function flattenTools(list) {
  const out = [];
  for (const tool of Array.isArray(list) ? list : []) {
    if (tool?.type === 'namespace' && Array.isArray(tool.tools)) out.push(...flattenTools(tool.tools).map(t => tool.name && tool.name !== 'functions' ? { ...t, name: `${tool.name}.${t.name}` } : t));
    else if (tool) out.push({ name: tool.name || tool.type, description: tool.description || '', input_schema: tool.parameters || tool.format || {} });
  }
  return out;
}
// Normalize OpenAI usage to the Anthropic-shaped fields the Inspector aggregates.
function normalizeUsage(usage) {
  if (!usage) return null;
  const cached = usage.input_tokens_details?.cached_tokens || 0;
  return { input_tokens: Math.max(0, (usage.input_tokens || 0) - cached), output_tokens: usage.output_tokens || 0, cache_read_input_tokens: cached, cache_creation_input_tokens: 0, reasoning_tokens: usage.output_tokens_details?.reasoning_tokens || 0 };
}
function extractResponses(reqText, resText, isStream) {
  // ChatGPT 订阅后端的流式响应不一定带 text/event-stream，按正文判断
  if (!isStream && /^\s*(event|data):/.test(resText.slice(0, 200))) isStream = true;
  const rec = { engine: 'codex', model: '', system: '', tools: [], messagesCount: 0, lastUser: '', messages: [], outText: '', thinking: '', usage: null, respMsgId: '' };
  try {
    const b = JSON.parse(reqText);
    const input = Array.isArray(b.input) ? b.input : [];
    rec.model = b.model || '';
    rec.system = [b.instructions || '', ...input.filter(i => i?.role === 'developer' || i?.role === 'system').map(i => textOf(i.content))].filter(Boolean).join('\n\n');
    rec.tools = flattenTools([...(b.tools || []), ...input.filter(i => i?.type === 'additional_tools').flatMap(i => i.tools || [])]);
    rec.messages = input.filter(i => !(i?.role === 'developer' || i?.role === 'system')).map(summarizeItem).filter(Boolean);
    rec.messagesCount = rec.messages.length;
    const lastUser = input.filter(i => i?.type === 'message' && i.role === 'user').pop();
    if (lastUser) rec.lastUser = textOf(lastUser.content);
  } catch {}
  try {
    let response = null;
    if (isStream) {
      for (const line of resText.split('\n')) {
        if (!line.startsWith('data:')) continue;
        let ev; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
        if (ev.type === 'response.output_text.delta') rec.outText += ev.delta || '';
        if (ev.type === 'response.reasoning_summary_text.delta') rec.thinking += ev.delta || '';
        if (ev.type === 'response.output_item.done' && ev.item && ev.item.type !== 'message' && ev.item.type !== 'reasoning') {
          const name = ev.item.name || ev.item.type;
          rec.outText += `${rec.outText ? '\n' : ''}[${name}]`;
        }
        if ((ev.type === 'response.completed' || ev.type === 'response.failed' || ev.type === 'response.incomplete') && ev.response) { response = ev.response; rec.finished = ev.type; }
        if (ev.type === 'response.created' && ev.response) response = response || ev.response;
      }
    } else response = JSON.parse(resText);
    if (response) {
      rec.usage = normalizeUsage(response.usage);
      rec.respMsgId = response.id || '';
      rec.model = rec.model || response.model || '';
      if (!rec.outText && Array.isArray(response.output)) rec.outText = response.output.filter(o => o.type === 'message').map(o => textOf(o.content)).join('\n');
    }
  } catch {}
  return rec;
}

// `relay`: { token, credentials(mode) → headers | null } for remote-node Codex (see above).
function createCodexProxy({ record = () => {}, reserveCapture = () => ({}), request = { http, https }, relay = null } = {}) {
  const live = new Map();
  async function handle(req, res) {
    const route = routeFor(req.url);
    if (!route || req.headers.origin) {
      res.writeHead(route ? 403 : 404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: route ? '模型代理不接受浏览器跨域请求' : 'not found' }));
    }
    const forcedAccount = String(req.headers['x-my-agents-codex-account'] || '');
    let swap = null, delegatedURL = null, selectedAccount = null;
    const pooled = relay?.token && sameSecret(req.headers.authorization || '', `Bearer ${relay.token}`) && !req.headers['x-my-agents-local-account'];
    if (relay?.token && sameSecret(req.headers.authorization || '', `Bearer ${relay.token}`)) {
      if (!req.headers['x-my-agents-local-account'] && relay.resolve) {
        const selected = await relay.resolve(route.mode, String(req.headers['session-id'] || req.headers['thread-id'] || ''), [], forcedAccount).catch(() => null);
        selectedAccount = selected;
        if (selected?.url) { delegatedURL = selected.url; swap = { authorization: `Bearer ${selected.token}`, 'x-my-agents-local-account': '1' }; }
      }
      if (!delegatedURL) swap = selectedAccount?.headers || (!pooled || !relay.resolve ? relay.credentials(route.mode) : null);
      if (!swap) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: '共享账号池未登录或没有可用凭证，请在任一节点登录一次并同步', type: 'invalid_request_error' } }));
      }
    }
    const info = reserveCapture();
    const sessionId = String(req.headers['session-id'] || req.headers['thread-id'] || '').slice(0, 100);
    Object.assign(info, { sessionId, method: req.method, routing: { mode: 'passthrough', reason: route.mode === 'chatgpt' ? 'codex_subscription' : 'codex_api_key', attempt: 1, requestedModel: '', actualModel: '' } });
    const chunks = [];
    let size = 0, upstream;
    req.on('data', c => { size += c.length; if (size > 32 * 1024 * 1024) { res.writeHead(413); res.end(); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (res.destroyed) return;
      const body = Buffer.concat(chunks), started = Date.now();
      try { const model = JSON.parse(body.toString()).model; if (typeof model === 'string') info.routing.requestedModel = info.routing.actualModel = model; } catch {}
      const turn = req.method === 'POST' && /\/responses(\?|$)/.test(req.url);
      if (turn && sessionId) { const e = live.get(sessionId) || { inflight: 0 }; e.inflight++; e.lastAt = Date.now(); live.set(sessionId, e); res.on('close', () => { e.inflight = Math.max(0, e.inflight - 1); e.lastAt = Date.now(); }); }
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k.toLowerCase())) headers[k] = v;
      delete headers['x-my-agents-local-account'];
      delete headers['x-my-agents-codex-account'];
      if (swap) Object.assign(headers, swap);
      headers['accept-encoding'] = 'identity';
      if (body.length) headers['content-length'] = body.length;
      const excluded = [];
      const send = () => {
      const target = new URL(delegatedURL ? delegatedURL + req.url : route.origin + req.url.slice(route.strip.length));
      let saved = false;
      const save = (code, responseBody, stream, encoding, incomplete) => {
        if (saved) return; saved = true;
        try { record(req.url, code, Date.now() - started, body, responseBody, stream, req.headers, encoding || '', selectedAccount?.accountId || (route.mode === 'chatgpt' ? 'codex-chatgpt' : 'codex-api'), selectedAccount?.label || (route.mode === 'chatgpt' ? 'Codex 订阅' : 'Codex API Key'), { ...info, incomplete: !!incomplete }); } catch {}
      };
      upstream = (target.protocol === 'https:' ? request.https : request.http).request({ ...upstreamNetwork, timeout: 10 * 60 * 1000, protocol: target.protocol, hostname: target.hostname, port: target.port || undefined, path: target.pathname + target.search, method: req.method, headers }, response => {
        if (pooled && selectedAccount && [401, 403, 429, 500, 502, 503, 504].includes(response.statusCode) && relay.resolve) {
          relay.rejected?.(selectedAccount, response.statusCode, response.headers['retry-after']);
          excluded.push(selectedAccount.id);
          const rejected = []; response.on('data', chunk => rejected.push(chunk));
          response.on('end', async () => {
            save(response.statusCode, Buffer.concat(rejected), false, response.headers['content-encoding'], false);
            if (res.destroyed) return;
            const next = await relay.resolve(route.mode, sessionId, excluded, forcedAccount).catch(() => null);
            if (res.destroyed) return;
            if (!next) { res.writeHead(response.statusCode, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: '共享 Codex 账号暂不可用：可用账号已尝试，请检查账号状态、额度或稍后重试' } })); }
            selectedAccount = next; delegatedURL = next.url || null;
            delete headers['x-my-agents-local-account'];
      delete headers['x-my-agents-codex-account'];
            Object.assign(headers, next.url ? { authorization: `Bearer ${next.token}`, 'x-my-agents-local-account': '1' } : next.headers || relay.credentials(route.mode));
            saved = false; send();
          });
          return;
        }
        if (response.statusCode >= 200 && response.statusCode < 300) relay?.accepted?.(selectedAccount, sessionId);
        const captured = [];
        const out = {};
        for (const [k, v] of Object.entries(response.headers)) if (!HOP.has(k.toLowerCase()) || k.toLowerCase() === 'content-length') out[k] = v;
        res.writeHead(response.statusCode, out);
        const stream = String(response.headers['content-type'] || '').includes('event-stream');
        response.on('data', c => { captured.push(c); res.write(c); });
        response.on('end', () => { res.end(); save(response.statusCode, Buffer.concat(captured), stream, response.headers['content-encoding'], false); });
        response.on('close', () => save(response.statusCode, Buffer.concat(captured), stream, response.headers['content-encoding'], !response.complete));
        response.on('error', () => res.destroy());
      });
      upstream.setTimeout(10 * 60 * 1000, () => upstream.destroy(new Error('upstream timeout')));
      upstream.on('error', e => {
        save(502, Buffer.from(JSON.stringify({ error: e.message })), false, '', true);
        if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '上游连接失败或超时' })); } else res.destroy();
      });
      upstream.end(body);
      };
      send();
    });
    res.on('close', () => { if (!res.writableFinished) upstream?.destroy(); });
  }
  const sessions = () => [...live.entries()].map(([id, e]) => ({ id, running: e.inflight > 0, lastAt: e.lastAt, engine: 'codex' }));
  return { handle, sessions };
}
module.exports = { createCodexProxy, codexProviderConfig, codexRelayConfig, codexCredentials, RELAY_TOKEN_ENV, extractResponses, isCodexPath, normalizeUsage };
