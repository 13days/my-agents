const crypto = require('crypto');
const { serveRelay } = require('./relay');

// Hub side of the hub ↔ node protocol (see node/agent.js). A connected node
// becomes a registry node whose engines are proxy adapters with the same
// interface as local ones, so the session manager does not know the difference.
const recoveries = new WeakMap();
const MODEL = /^[\w.\/:\[\]-]{1,100}$/;

// `pin` fixes the id/label for nodes the hub launched itself (saved SSH nodes).
// `routing` lets remote engines use the hub's proxy: { target: proxy URL, engines: { [id]: options => env | null } }.
// A hook with `accounts = false` routes without offering the hub's account picker.
async function attachRemoteNode({ peer, registry, transport = 'ws', pin = null, routing = null, log = console }) {
  const info = { ...await peer.call('hello', {}, { timeout: 15000 }), ...(pin?.id ? { id: pin.id } : {}), ...(pin?.label ? { label: pin.label } : {}) };
  const id = String(info?.id || '').trim();
  if (!/^[\w.-]{1,64}$/.test(id) || id === 'local') throw new Error(`节点名称无效：${id || '(空)'}`);
  if (registry.node(id)) throw new Error(`节点 ${id} 已连接`);

  if (!recoveries.has(registry)) recoveries.set(registry, new Map());
  const saved = recoveries.get(registry).get(id);
  const sessions = saved?.sessions || new Map(); // sid → proxy state
  const connection = saved?.connection || {}; connection.peer = peer;
  if (info.runtimeCapabilities?.sessionRecovery) recoveries.get(registry).set(id, { sessions, connection });
  const host = {
    id, label: info.label || id, platform: info.platform, remote: true,
    homeDir: () => info.home || '~',
    resolveDir: dir => peer.call('host.resolveDir', { dir }),
    createWorktree: info.worktrees ? async (dir, options = {}) => {
      const cancel = () => connection.peer.call('host.cancelWorktree', { operationId: options.operationId }).catch(() => {});
      options.signal?.addEventListener('abort', cancel, { once: true });
      try { return await connection.peer.call('host.createWorktree', { dir, operationId: options.operationId }, { timeout: require('../core/worktrees').WORKTREE_TIMEOUT_MS + 30000 }); }
      finally { options.signal?.removeEventListener('abort', cancel); }
    } : undefined,
    join: (...parts) => parts.join('/').replace(/\/+/g, '/'),
  };
  const node = registry.addNode({ id, label: info.label || id, host, remote: true, info: { build: info.build, platform: info.platform, version: info.version, transport, home: info.home, projects: Array.isArray(info.projects) ? info.projects : [] } });
  node.peer = peer;

  if (routing?.target) serveRelay({ peer, target: routing.target });

  const route = (method, fn) => peer.on(method, params => { const proxy = sessions.get(params.sid); if (proxy) { if (params.seq && params.seq <= (proxy.lastSeq || 0)) return; if (params.seq) proxy.lastSeq = params.seq; if (params.state) Object.assign(proxy.state, params.state); fn(proxy, params); } });
  route('session.event', (proxy, { event, data }) => proxy.options.emit(event, data));
  route('session.idle', proxy => proxy.options.onIdle());
  route('session.ready', (proxy, { id: realId }) => proxy.resolveReady(realId));
  route('session.failed', (proxy, { error }) => proxy.rejectReady(new Error(error)));
  route('session.accepted', (proxy, { turnId }) => { const accept = proxy.accepts.get(turnId); proxy.accepts.delete(turnId); accept?.(); });
  route('session.closed', proxy => proxy.closed());

  for (const engine of info.engines || []) {
    // Engines with a routing hook use the hub's accounts through the relay; others keep the node's own login.
    const routeEnv = routing?.target && routing.engines?.[engine.id];
    registry.register({
      id: engine.id,
      meta: { ...engine.meta },
      capabilities: { ...engine.capabilities, accounts: !!routeEnv && routeEnv.accounts !== false, capture: !!routeEnv },
      detect: () => engine.cli,
      validModel: model => MODEL.test(model),
      owns: sessionId => peer.call('engine.owns', { engine: engine.id, id: sessionId }).catch(() => false),
      async open(options) {
        const existing = options.resume && info.runtimeCapabilities?.sessionRecovery ? await connection.peer.call('session.find', { engine: engine.id, sessionId: options.sessionId }) : null;
        if (existing && (existing.model || '') !== (options.model || '')) throw new Error('执行器保留的任务使用其他模型，请先连接原任务并结束当前执行后再切换模型');
        const sid = existing?.sid || crypto.randomUUID();
        let resolveReady, rejectReady, done = false;
        const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
        ready.catch(() => {});
        const proxy = {
          options, state: { currentId: '', pendingCount: 0, busy: false }, accepts: new Map(), resolveReady, rejectReady,
          closed() { if (done) return; done = true; sessions.delete(sid); rejectReady(new Error('会话已结束')); options.onClosed(); },
        };
        sessions.set(sid, proxy);
        let opened;
        try {
          if (existing) { opened = await connection.peer.call('session.attach', { sid, after: 0 }); if (opened.sessionId) proxy.resolveReady(opened.sessionId); if (opened.state) Object.assign(proxy.state, opened.state); } else {
          const nativeOnly = !!options.resume && !!options.sessionId && await peer.call('engine.nativeSession', { engine: engine.id, id: options.sessionId }, { timeout: 5000 }).catch(() => false);
          const env = routeEnv && !nativeOnly ? await routeEnv(options) : null;
          opened = await peer.call('session.open', { sid, engine: engine.id, sessionId: options.sessionId, resume: options.resume, cwd: options.cwd, model: options.model, nativeOnly, ...(env ? { routeEnv: env } : {}) }, { timeout: 60000 });
          }
        }
        catch (e) { sessions.delete(sid); throw e; }
        const send = (method, params = {}) => connection.peer.call(method, { sid, ...params }).catch(e => { if (!done) options.emit('warning', { warning: `${host.label}：${e.message}` }); });
        return {
          ready, routed: !!opened?.routed, nativeAttached: !!opened?.nativeAttached,
          submit(turnId, input, steer, onAccept) {
            // Optimistic state until the node reports back, so busy checks stay accurate.
            if (proxy.state.currentId) proxy.state.pendingCount++; else proxy.state.currentId = turnId;
            proxy.state.busy = true;
            if (onAccept) proxy.accepts.set(turnId, onAccept);
            send('session.submit', { turnId, input, steer, accept: !!onAccept }).then(state => { if (state) Object.assign(proxy.state, state); });
          },
          stop: () => send('session.stop'),
          close: () => send('session.close'),
          respondPermission: (requestId, behavior) => send('session.permission', { requestId, behavior }),
          get currentId() { return proxy.state.currentId; },
          get pendingCount() { return proxy.state.pendingCount; },
          get busy() { return proxy.state.busy; },
        };
      },
    }, id);
  }

  if (saved) for (const [sid, proxy] of sessions) {
    try { await peer.call('session.attach', { sid, after: proxy.lastSeq || 0 }); }
    catch (error) { proxy.options.emit('warning', { kind: 'recovery_unknown', warning: error.message }); proxy.closed(); }
  }
  peer.onClose(() => {
    if (connection.peer !== peer) return;
    for (const proxy of [...sessions.values()]) { if (info.runtimeCapabilities?.sessionRecovery) proxy.options.emit('warning', { kind: 'node_reconnecting', warning: `节点 ${host.label} 控制连接暂时断开，任务保留在执行器，正在等待重连` }); else { proxy.options.emit('error', { error: `节点 ${host.label} 连接已断开` }); proxy.closed(); } }
    if (registry.node(id) === node) registry.removeNode(id);
    log.warn?.(`节点 ${id} 已断开`);
  });
  return node;
}
module.exports = { attachRemoteNode };
