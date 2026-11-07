const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const isLoopback = host => LOOPBACK.has(String(host || '').replace(/^\[|\]$/g, ''));

// One guard for every /api request.
// - Host must be an expected name (blocks DNS rebinding).
// - A browser Origin, when present, must be the panel itself (blocks CSRF).
// - Off-loopback binds additionally require the install token (cookie or Bearer).
function createAuth({ port, bindHost = '127.0.0.1', dir, publicHosts = [] }) {
  const tokenFile = path.join(dir, 'panel-token');
  let token;
  try { token = fs.readFileSync(tokenFile, 'utf8').trim(); } catch {}
  if (!/^[a-f0-9]{48}$/.test(token || '')) {
    token = crypto.randomBytes(24).toString('hex');
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(tokenFile, token, { mode: 0o600 }); } catch {}
  }
  const requireToken = !isLoopback(bindHost);
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, ...publicHosts]);
  const matches = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const cookieToken = req => (String(req.headers.cookie || '').match(/(?:^|;\s*)my_agents_token=([a-f0-9]+)/) || [])[1] || '';
  const bearer = req => (String(req.headers.authorization || '').match(/^Bearer\s+(\S+)$/i) || [])[1] || '';
  const hasToken = req => [cookieToken(req), bearer(req)].some(value => value && matches(value, token));

  return {
    token,
    requireToken,
    // Returns an error string, or '' when the request may proceed.
    check(req) {
      if (!hosts.has(String(req.headers.host || '')) && !requireToken) return '仅允许通过本机地址访问面板';
      const origin = req.headers.origin;
      if (origin && origin !== 'null') {
        let originHost = '';
        try { originHost = new URL(origin).host; } catch {}
        if (!hosts.has(originHost) && originHost !== req.headers.host) return '拒绝跨站请求';
      }
      if (req.headers['sec-fetch-site'] === 'cross-site') return '拒绝跨站请求';
      if (requireToken && !hasToken(req)) return '需要访问令牌';
      return '';
    },
    // Opening /?token=… once stores the token as an HttpOnly cookie for remote binds.
    login(req, res, url) {
      const supplied = url.searchParams.get('token');
      if (!supplied || !matches(supplied, token)) return false;
      res.setHeader('Set-Cookie', `my_agents_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`);
      return true;
    },
    pageAllowed(req) { return !requireToken || hasToken(req); },
  };
}

module.exports = { createAuth, isLoopback };
