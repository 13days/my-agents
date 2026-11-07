const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { createPeer } = require('./rpc');
const { wsTransport, streamTransport } = require('./transports');
const { attachRemoteNode } = require('./remote');

// Remote nodes for the hub. Two ways in:
//   - a node dials /api/nodes/connect over WebSocket with the panel token;
//   - the hub launches `my-agents node --stdio` over SSH for saved SSH nodes.
// Saved SSH nodes live in panel-nodes.json and reconnect with backoff.
const NODE_ID = /^[\w.-]{1,64}$/;
const SSH_TARGET = /^[\w.@:[\]-]{1,200}$/;
const DEFAULT_COMMAND = 'my-agents node --stdio';

function createNodeHub({ registry, token, dir, log = console, spawnImpl = spawn, retryMs = 30000 }) {
  const file = path.join(dir, 'panel-nodes.json');
  let saved = [];
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')).nodes || []; } catch {}
  const links = new Map(); // ssh node id → { child, timer, error, state }
  const persist = () => {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ nodes: saved }, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  let wss = null;

  function authorized(req) {
    const header = String(req.headers.authorization || '');
    const given = header.startsWith('Bearer ') ? header.slice(7) : '';
    return !!token && given.length === token.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
  }

  // HTTP upgrade handler; returns false when the request is not for us.
  function upgrade(req, socket, head) {
    if (new URL(req.url, 'http://x').pathname !== '/api/nodes/connect') return false;
    if (!authorized(req)) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return true; }
    if (!wss) { const { WebSocketServer } = require('ws'); wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 }); }
    wss.handleUpgrade(req, socket, head, ws => {
      const peer = createPeer(wsTransport(ws));
      attachRemoteNode({ peer, registry, transport: 'ws', log })
        .then(node => log.log?.(`节点已连接：${node.id}（WebSocket）`))
        .catch(e => { log.warn?.(`节点连接被拒绝：${e.message}`); peer.close(); });
    });
    return true;
  }

  function connectSSH(config) {
    const link = links.get(config.id) || {};
    links.set(config.id, link);
    clearTimeout(link.timer);
    if (link.child || registry.node(config.id)) return;
    link.state = 'connecting'; link.error = '';
    const child = spawnImpl('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=30', config.ssh, config.command || DEFAULT_COMMAND], { stdio: ['pipe', 'pipe', 'pipe'] });
    link.child = child;
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    const peer = createPeer(streamTransport(child.stdout, child.stdin, { onEnd: () => child.kill() }));
    attachRemoteNode({ peer, registry, transport: 'ssh', pin: { id: config.id, label: config.label }, log })
      .then(() => { link.state = 'connected'; log.log?.(`节点已连接：${config.id}（SSH ${config.ssh}）`); })
      .catch(e => { link.error = e.message; child.kill(); });
    child.on('exit', code => {
      link.child = null;
      link.state = 'disconnected';
      if (!link.error) link.error = (stderr.trim().split('\n').pop() || `ssh 退出（${code}）`).slice(0, 300);
      if (saved.some(item => item.id === config.id && item.enabled !== false)) { link.timer = setTimeout(() => connectSSH(config), retryMs); link.timer.unref?.(); }
    });
    child.on('error', e => { link.error = e.message; });
  }

  function list() {
    const connected = registry.nodes().map(node => ({
      id: node.id, label: node.label, remote: node.remote, connected: true, connectedAt: node.connectedAt, ...node.info,
      engines: [...node.engines.values()].map(engine => { let cli = null; try { cli = engine.detect?.() || null; } catch {} return { id: engine.id, label: engine.meta.label, cli: cli && { path: cli.path, version: cli.version } }; }),
    }));
    const offline = saved.filter(item => !registry.node(item.id)).map(item => ({ id: item.id, label: item.label || item.id, remote: true, connected: false, transport: 'ssh', engines: [] }));
    return [...connected, ...offline].map(node => {
      const config = saved.find(item => item.id === node.id), link = links.get(node.id);
      return { ...node, ...(config ? { ssh: config.ssh, command: config.command || DEFAULT_COMMAND, enabled: config.enabled !== false, state: node.connected ? 'connected' : link?.state || 'disconnected', error: node.connected ? '' : link?.error || '' } : {}) };
    });
  }

  function add({ id, label, ssh, command }) {
    id = String(id || '').trim(); ssh = String(ssh || '').trim();
    if (!NODE_ID.test(id) || id === 'local') throw Object.assign(new Error('节点名称只能包含字母、数字、点、下划线和连字符'), { status: 400 });
    if (!SSH_TARGET.test(ssh) || ssh.startsWith('-')) throw Object.assign(new Error('SSH 目标格式应为 user@host 或 ~/.ssh/config 中的主机名'), { status: 400 });
    if (saved.some(item => item.id === id) || registry.node(id)) throw Object.assign(new Error(`节点 ${id} 已存在`), { status: 409 });
    const config = { id, label: String(label || '').trim().slice(0, 60) || id, ssh, ...(command && String(command).trim() !== DEFAULT_COMMAND ? { command: String(command).trim().slice(0, 300) } : {}), enabled: true };
    saved.push(config); persist(); connectSSH(config);
    return config;
  }

  function remove(id) {
    const index = saved.findIndex(item => item.id === id);
    if (index >= 0) { saved.splice(index, 1); persist(); }
    const link = links.get(id);
    if (link) { clearTimeout(link.timer); link.child?.kill(); links.delete(id); }
    const node = registry.node(id);
    if (node?.remote && node.peer) node.peer.close();
    return index >= 0 || !!link;
  }

  function reconnect(id) {
    const config = saved.find(item => item.id === id);
    if (!config) throw Object.assign(new Error('只有 SSH 节点可以由 Hub 发起重连'), { status: 400 });
    connectSSH(config);
  }

  return {
    upgrade, list, add, remove, reconnect,
    start() { for (const config of saved) if (config.enabled !== false) connectSSH(config); },
    stop() { for (const link of links.values()) { clearTimeout(link.timer); link.child?.kill(); } wss?.clients.forEach(ws => ws.close()); },
  };
}
module.exports = { createNodeHub, DEFAULT_COMMAND };
