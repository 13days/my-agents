const crypto = require('crypto');
const { createPeer } = require('./rpc');
const { wsTransport } = require('./transports');

function createClusterNetwork({ token, selfId, members = [], WebSocket = require('ws'), log = console, retryMs = 2000 }) {
  const peers = new Map(), handlers = new Map(), timers = new Map();
  let wss = null, stopped = false;
  const member = id => members.find(item => item.id === id);
  const authorized = req => {
    const value = String(req.headers.authorization || '').replace(/^Bearer /, '');
    return !!token && value.length === token.length && crypto.timingSafeEqual(Buffer.from(value), Buffer.from(token));
  };
  const wire = (id, peer) => {
    const old = peers.get(id); if (old && old !== peer) old.close();
    peers.set(id, peer);
    for (const [method, fn] of handlers) peer.handle(method, params => fn(id, params));
    peer.onClose(() => { if (peers.get(id) === peer) peers.delete(id); });
    return peer;
  };
  function upgrade(req, socket, head) {
    if (new URL(req.url, 'http://x').pathname !== '/api/cluster/connect') return false;
    if (!authorized(req)) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return true; }
    if (!wss) { const { WebSocketServer } = require('ws'); wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 }); }
    wss.handleUpgrade(req, socket, head, ws => {
      const peer = createPeer(wsTransport(ws));
      peer.handle('cluster.hello', ({ id }) => { if (!member(id)) throw new Error('未知集群成员'); wire(id, peer); return { id: selfId }; });
    });
    return true;
  }
  function connect(item) {
    // Exactly one side opens each pair; this avoids two simultaneous sockets
    // replacing one another while their hello RPC is still in flight.
    if (stopped || item.id === selfId || selfId > item.id || peers.has(item.id) || !item.url) return;
    let ws;
    try { ws = new WebSocket(new URL('/api/cluster/connect', item.url.replace(/^http/, 'ws')), { headers: { authorization: `Bearer ${token}` } }); }
    catch (e) { return schedule(item, e); }
    ws.on('open', async () => {
      const peer = createPeer(wsTransport(ws));
      try { const hello = await peer.call('cluster.hello', { id: selfId }, { timeout: 5000 }); if (hello.id !== item.id) throw new Error('集群节点身份不匹配'); wire(item.id, peer); }
      catch (e) { peer.close(); }
    });
    ws.on('error', () => {});
    ws.on('close', () => schedule(item));
  }
  function schedule(item) { if (stopped || timers.has(item.id)) return; const timer = setTimeout(() => { timers.delete(item.id); connect(item); }, retryMs); timer.unref?.(); timers.set(item.id, timer); }
  return {
    upgrade,
    start() { stopped = false; members.forEach(connect); },
    stop() { stopped = true; timers.forEach(clearTimeout); timers.clear(); peers.forEach(peer => peer.close()); peers.clear(); wss?.clients.forEach(ws => ws.close()); },
    handle(method, fn) { handlers.set(method, fn); for (const [id, peer] of peers) peer.handle(method, params => fn(id, params)); },
    call(id, method, params = {}, options = {}) { const peer = peers.get(id); return peer ? peer.call(method, params, options) : Promise.reject(new Error(`集群节点离线：${id}`)); },
    async broadcast(method, params = {}, options = {}) { return Promise.allSettled(members.filter(item => item.id !== selfId).map(async item => ({ id: item.id, value: await this.call(item.id, method, params, options) }))); },
    connected: () => [...peers.keys()],
  };
}
module.exports = { createClusterNetwork };
