const crypto = require('crypto');
const { createPeer } = require('./rpc');
const { wsTransport } = require('./transports');

function createClusterNetwork({ token, selfId, members = [], WebSocket = require('ws'), log = console, retryMs = 2000, onPeer = () => {} }) {
  const peers = new Map(), handlers = new Map(), timers = new Map();
  const reports = new Map(), initiators = new Map(), sockets = new Set();
  let wss = null, stopped = false;
  const member = id => members.find(item => item.id === id);
  const authorized = req => {
    const value = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const actual = Buffer.from(value), expected = Buffer.from(token || '');
    return !!token && actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  };
  const keepAlive = ws => {
    sockets.add(ws); let alive = true;
    ws.on('pong', () => { alive = true; });
    const timer = setInterval(() => { if (!alive) return ws.terminate(); alive = false; if (ws.readyState === WebSocket.OPEN) ws.ping(); }, 4000); timer.unref?.();
    ws.on('close', () => { clearInterval(timer); sockets.delete(ws); });
  };
  const wire = (id, peer, initiator) => {
    if (stopped) { peer.close(); return; }
    const old = peers.get(id);
    if (old && old !== peer && initiators.get(id) <= initiator) { peer.close(); return; }
    peers.set(id, peer);
    initiators.set(id, initiator);
    if (old && old !== peer) old.close();
    reports.set(id, { connectedAt: Date.now(), error: '' });
    for (const [method, fn] of handlers) peer.handle(method, params => fn(id, params));
    peer.onClose(() => { if (peers.get(id) === peer) peers.delete(id); });
    try { Promise.resolve(onPeer(id, peer)).catch(error => { reports.set(id, { error: error.message }); log.warn?.('集群运行通道：' + error.message); }); }
    catch (error) { reports.set(id, { error: error.message }); }
    return peer;
  };
  function upgrade(req, socket, head) {
    if (new URL(req.url, 'http://x').pathname !== '/api/cluster/connect') return false;
    if (!authorized(req)) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return true; }
    if (!wss) { const { WebSocketServer } = require('ws'); wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 }); }
    wss.handleUpgrade(req, socket, head, ws => {
      keepAlive(ws);
      const peer = createPeer(wsTransport(ws));
      peer.handle('cluster.hello', ({ id }) => { if (!member(id) || id === selfId) throw new Error('未知集群成员'); wire(id, peer, id); return { id: selfId }; });
    });
    return true;
  }
  function connect(item) {
    // Either direction may work through a firewall. If both work, both ends
    // retain the connection initiated by the lexicographically smaller id.
    if (stopped || item.id === selfId || peers.has(item.id) || !item.url) return;
    let ws;
    reports.set(item.id, { ...reports.get(item.id), lastAttemptAt: Date.now(), error: '' });
    try { ws = new WebSocket(new URL('/api/cluster/connect', item.url.replace(/^http/, 'ws')), { handshakeTimeout: 5000, headers: { authorization: `Bearer ${token}` } }); }
    catch (e) { return schedule(item, e); }
    ws.on('open', async () => {
      if (stopped) { ws.close(); return; }
      keepAlive(ws);
      const peer = createPeer(wsTransport(ws));
      try { const hello = await peer.call('cluster.hello', { id: selfId }, { timeout: 5000 }); if (hello.id !== item.id) throw new Error('集群节点身份不匹配'); wire(item.id, peer, selfId); }
      catch (e) { reports.set(item.id, { error: e.message }); peer.close(); }
    });
    ws.on('error', error => { reports.set(item.id, { ...reports.get(item.id), error: error.message.replace(/Bearer\s+\S+/g, 'Bearer [redacted]') }); });
    ws.on('close', () => schedule(item));
  }
  function schedule(item) { if (stopped || timers.has(item.id)) return; const timer = setTimeout(() => { timers.delete(item.id); connect(item); }, retryMs); timer.unref?.(); timers.set(item.id, timer); }
  return {
    upgrade,
    start() { stopped = false; members.forEach(connect); },
    stop() { stopped = true; timers.forEach(clearTimeout); timers.clear(); peers.forEach(peer => peer.close()); peers.clear(); sockets.forEach(ws => ws.close()); wss?.clients.forEach(ws => ws.close()); },
    handle(method, fn) { handlers.set(method, fn); for (const [id, peer] of peers) peer.handle(method, params => fn(id, params)); },
    call(id, method, params = {}, options = {}) { const peer = peers.get(id); return peer ? peer.call(method, params, options) : Promise.reject(new Error(`集群节点离线：${id}`)); },
    async broadcast(method, params = {}, options = {}) { return Promise.allSettled(members.filter(item => item.id !== selfId).map(async item => ({ id: item.id, value: await this.call(item.id, method, params, options) }))); },
    connected: () => [...peers.keys()],
    peer: id => peers.get(id),
    status: () => members.filter(item => item.id !== selfId).map(item => ({ id: item.id, connected: peers.has(item.id), ...reports.get(item.id), ...(peers.has(item.id) ? { error: '' } : {}) })),
  };
}
module.exports = { createClusterNetwork };
