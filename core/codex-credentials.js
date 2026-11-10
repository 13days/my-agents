const crypto = require('crypto');
const { codexCredentials } = require('../engines/codex/proxy');
const fingerprint = value => crypto.createHash('sha256').update(String(value || '')).digest('hex');
function tokenClaims(auth) { try { return JSON.parse(Buffer.from(auth.tokens.access_token.split('.')[1], 'base64url').toString()); } catch { return {}; } }
function accountId(auth, mode) {
  if (mode === 'api-key') return 'api:' + fingerprint(auth.base_url ? auth.base_url + ':' + auth.OPENAI_API_KEY : auth.OPENAI_API_KEY);
  let subject = tokenClaims(auth).sub || '';
  if (!subject) { try { subject = JSON.parse(Buffer.from(auth.tokens.id_token.split('.')[1], 'base64url')).sub || ''; } catch {} }
  const identity = [auth.tokens?.account_id || '', subject].join(':');
  return 'chatgpt:' + fingerprint(identity === ':' ? auth.tokens?.access_token : identity);
}
function issued(auth) { return Math.max(Date.parse(auth?.last_refresh || '') || 0, (tokenClaims(auth).iat || 0) * 1000); }
function expiresSoon(auth, now = Date.now()) { const exp = tokenClaims(auth).exp; return typeof exp === 'number' && exp * 1000 < now + 5 * 60 * 1000; }
async function renewCodex(auth, { fetchImpl = fetch, now = Date.now } = {}) {
  const tokens = auth?.tokens;
  if (!tokens?.refresh_token) throw new Error('共享 Codex 登录没有刷新凭证，请在任一节点重新登录一次');
  const provenance = tokens.oauth_provenance;
  if (provenance?.issuer && provenance.issuer.replace(/\/$/, '') !== 'https://auth.openai.com') throw new Error('此 Codex 身份源需要由原登录工具刷新');
  let response;
  try {
    response = await fetchImpl('https://auth.openai.com/oauth/token', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(45000),
      body: JSON.stringify({ grant_type: 'refresh_token', client_id: provenance?.client_id || 'app_EMoamEEZ73f0CkXaXp7hrann', refresh_token: tokens.refresh_token }),
    });
  } catch { throw new Error('共享 Codex 登录刷新连接失败；保留原凭证，请稍后重试'); }
  if (!response.ok) throw Object.assign(new Error(`共享 Codex 登录刷新失败（HTTP ${response.status}）；请在任一节点重新登录一次`), { status: response.status });
  let body; try { body = await response.json(); } catch { throw new Error('共享 Codex 登录刷新响应无效'); }
  if (typeof body.access_token !== 'string' || !body.access_token) throw new Error('共享 Codex 登录刷新没有返回有效凭证');
  return { ...auth, last_refresh: new Date(now()).toISOString(), tokens: { ...tokens, access_token: body.access_token, refresh_token: body.refresh_token || tokens.refresh_token, id_token: body.id_token || tokens.id_token } };
}
module.exports = { fingerprint, accountId, issued, expiresSoon, renewCodex, codexCredentials };
