const http = require('http');
const crypto = require('crypto');

// HTTP relay over the hub ↔ node RPC link, so engines on a remote node reach the
// panel proxy (accounts, model maps, Inspector capture) without another tunnel.
//   node: listens on 127.0.0.1:<random>, sends each request as `relay.request`;
//   hub:  replays it against its own proxy and streams `relay.head` / `relay.data` /
//         `relay.end` back. `relay.abort` cancels when the engine hangs up.
// Bodies travel base64-encoded; requests are buffered, responses stream.
const HOP = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer']);
const clean = headers => Object.fromEntries(Object.entries(headers || {}).filter(([key]) => !HOP.has(key.toLowerCase())));
const errorBody = message => JSON.stringify({ type: 'error', error: { type: 'api_error', message } });

// Hub side: only ever forwards to `target` (the panel proxy), whatever path the node asks for.
const servedPeers = new WeakMap();
function serveRelay({ peer, target }) {
  const base = new URL(target);
  const previous = servedPeers.get(peer);
  if (previous) { if (previous !== base.href) throw new Error('同一个节点连接不能绑定多个代理目标'); return; }
  servedPeers.set(peer, base.href);
  const active = new Map();
  peer.on('relay.abort', ({ rid }) => { active.get(rid)?.destroy(); active.delete(rid); });
  peer.handle('relay.request', ({ rid, method, path, headers, body }) => {
    if (typeof rid !== 'string' || !/^\/(?!\/)/.test(String(path || ''))) throw Object.assign(new Error('无效的转发请求'), { status: 400 });
    const data = Buffer.from(String(body || ''), 'base64');
    const end = error => { if (active.delete(rid)) peer.notify('relay.end', { rid, ...(error ? { error } : {}) }); };
    const req = http.request({ hostname: base.hostname, port: base.port, method: String(method || 'GET'), path, headers: { ...clean(headers), 'content-length': data.length } }, res => {
      peer.notify('relay.head', { rid, status: res.statusCode, headers: clean(res.headers) });
      res.on('data', chunk => peer.notify('relay.data', { rid, chunk: chunk.toString('base64') }));
      res.on('end', () => end());
      res.on('error', e => end(e.message));
    });
    req.on('error', e => end(`面板代理不可用：${e.message}`));
    active.set(rid, req);
    req.end(data);
    return true;
  });
  peer.onClose(() => { for (const req of active.values()) req.destroy(); active.clear(); });
}

// Node side: lazily opens the local listener; resolves to its base URL.
function createRelayClient(initialPeer, { reconnectable = false } = {}) {
  let peer = initialPeer;
  const pending = new Map(); // rid → response
  let listening = null, server = null;
  const finish = (rid, error) => {
    const res = pending.get(rid);
    if (!res) return;
    pending.delete(rid);
    if (!error) return res.end();
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(errorBody(error));
  };
  const attach = next => {
    peer = next;
    next.on('relay.head', ({ rid, status, headers }) => { if (peer !== next) return; const res = pending.get(rid); if (res && !res.headersSent) res.writeHead(status, headers); });
    next.on('relay.data', ({ rid, chunk }) => { if (peer === next) pending.get(rid)?.write(Buffer.from(chunk, 'base64')); });
    next.on('relay.end', ({ rid, error }) => { if (peer === next) finish(rid, error); });
    next.onClose(() => {
      if (peer !== next) return;
      for (const rid of [...pending.keys()]) finish(rid, 'Hub 连接暂时断开，请稍后重试');
      if (reconnectable) peer = null;
      else { server?.closeAllConnections?.(); server?.close(); }
    });
  };
  attach(initialPeer);

  const handle = (req, res) => {
    const chunks = []; let bytes = 0;
    req.on('data', chunk => { bytes += chunk.length; if (bytes > 32 * 1024 * 1024) { res.writeHead(413); res.end(); req.destroy(); } else chunks.push(chunk); });
    req.on('end', () => {
      if (res.destroyed || res.writableEnded) return;
      if (!peer || peer.closed) { res.writeHead(503, { 'content-type': 'application/json' }); return res.end(errorBody('控制通道正在重连，请稍后重试')); }
      const rid = crypto.randomUUID();
      pending.set(rid, res);
      res.on('close', () => { if (pending.delete(rid)) peer?.notify('relay.abort', { rid }); });
      peer.call('relay.request', { rid, method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('base64') }, { timeout: 30000 })
        .catch(e => finish(rid, `Hub 未接受转发：${e.message}`));
    });
  };
  return {
    attach,
    url() {
      listening ||= new Promise((resolve, reject) => {
        server = http.createServer(handle);
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
        server.unref(); // the hub link keeps the node alive, not the relay
      });
      return listening;
    },
  };
}
module.exports = { serveRelay, createRelayClient };
