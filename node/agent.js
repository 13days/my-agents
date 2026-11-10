const os = require('os');
const { createRelayClient } = require('./relay');
const VERSION = require('../package.json').version;

// Node side of the hub ↔ node protocol: serves this machine's engine adapters
// over an RPC peer. The hub owns sessions, history and channels; the node only
// runs CLIs and streams their events back.
//
// Calls (hub → node): hello, engine.owns, host.resolveDir, session.open,
// session.submit, session.stop, session.close, session.permission.
// `session.open` may carry `routeEnv` pointing the engine at the hub's proxy; its base
// URL (ANTHROPIC_BASE_URL, or the MY_AGENTS_CODEX_BASE path) is put on this node's relay (node/relay.js) back over the same link.
// Notifications (node → hub): session.event, session.idle, session.ready,
// session.failed, session.accepted, session.closed. Each carries the session
// state so the hub can answer currentId / busy synchronously.
function serveNode({ peer, host, engines, id = os.hostname(), label = id, beforeOpen = () => {}, history = null, nativeLogins = null }) {
  const byId = new Map(engines.map(engine => [engine.id, engine]));
  const sessions = new Map();
  const engineOf = name => { const engine = byId.get(name); if (!engine) throw Object.assign(new Error(`节点上没有引擎：${name}`), { status: 400 }); return engine; };
  const sessionOf = sid => { const session = sessions.get(sid); if (!session) throw Object.assign(new Error('节点上的会话已结束'), { status: 409 }); return session; };
  const relay = createRelayClient(peer);
  const state = session => ({ currentId: session?.currentId || '', pendingCount: session?.pendingCount || 0, busy: !!session?.busy });

  peer.handle('hello', () => ({
    nativeAccounts:!!nativeLogins, id, label, platform: host.platform, version: VERSION, home: host.homeDir(), worktrees: typeof host.createWorktree === 'function',
    engines: engines.map(engine => {
      let cli = null;
      try { const info = engine.detect?.(); if (info) cli = { path: info.path, version: info.version }; } catch {}
      return { id: engine.id, meta: engine.meta, capabilities: engine.capabilities, cli };
    }),
    projects: typeof host.projects === 'function' ? host.projects() : [],
  }));
  if (nativeLogins) {
    const transport=require('../core/account-transport').createAccountTransport('my-agents/runtime-native-accounts/v1');
    peer.handle('accounts.native', ({publicKey}) => ({publicKey:transport.publicKey,sealed:transport.seal(nativeLogins(),publicKey)}));
  }
  peer.handle('engine.owns', async ({ engine, id: sessionId }) => !!await engineOf(engine).owns(sessionId));
  if (history) {
    peer.handle('history.messages', ({ id }) => history.messages(id));
    peer.handle('history.list', () => history.list());
    peer.handle('history.previews', async ({ items }) => history.previews ? history.previews(items) : Promise.all(items.map(async item => require('../core/session-previews').sessionPreview(await history.messages(item.id), item))));
    peer.handle('history.userPage', async ({ item, page }) => history.userPage ? history.userPage({ item, page }) : require('../core/session-previews').userMessagePage(await history.messages(item.id), page, item));
  }
  peer.handle('host.resolveDir', ({ dir }) => host.resolveDir(dir));
  peer.handle('host.createWorktree', async ({ dir }) => host.createWorktree(await host.resolveDir(dir)));

  peer.handle('session.open', async ({ sid, engine: name, sessionId, resume, cwd, model, routeEnv }) => {
    await beforeOpen(sessionId);
    const engine = engineOf(name);
    const codexPath = String(routeEnv?.MY_AGENTS_CODEX_BASE || '');
    if (routeEnv?.ANTHROPIC_BASE_URL || /^\/(?!\/)/.test(codexPath)) {
      // The relay is on loopback; a corporate HTTP(S)_PROXY in the shell must not swallow it.
      const noProxy = [...new Set([...String(process.env.NO_PROXY || process.env.no_proxy || '').split(','), '127.0.0.1', 'localhost'].map(s => s.trim()).filter(Boolean))].join(',');
      const url = await relay.url();
      routeEnv = { ...routeEnv, NO_PROXY: noProxy, no_proxy: noProxy };
      if (routeEnv.ANTHROPIC_BASE_URL) routeEnv.ANTHROPIC_BASE_URL = url;
      if (codexPath) routeEnv.MY_AGENTS_CODEX_BASE = url + codexPath;
    } else routeEnv = null;
    let session = null;
    const notify = (method, extra = {}) => peer.notify(method, { sid, ...extra, state: state(session) });
    session = await engine.open({
      host, sessionId, resume, cwd: host.resolveDir(cwd), model: model && engine.validModel(model) ? model : '', routeEnv: routeEnv || null,
      emit: (event, data) => notify('session.event', { event, data }),
      onIdle: () => notify('session.idle'),
      onClosed: () => { sessions.delete(sid); notify('session.closed'); },
    });
    sessions.set(sid, session);
    Promise.resolve(session.ready).then(realId => notify('session.ready', { id: realId }), e => notify('session.failed', { error: e?.message || String(e) }));
    return { routed: !!session.routed };
  });
  peer.handle('session.submit', ({ sid, turnId, input, steer, accept }) => {
    const session = sessionOf(sid);
    session.submit(turnId, input, !!steer, accept ? () => peer.notify('session.accepted', { sid, turnId, state: state(session) }) : undefined);
    return state(session);
  });
  peer.handle('session.stop', ({ sid }) => { sessions.get(sid)?.stop(); return true; });
  peer.handle('session.close', ({ sid }) => { sessions.get(sid)?.close(); return true; });
  peer.handle('session.permission', ({ sid, requestId, behavior }) => { sessionOf(sid).respondPermission(requestId, behavior); return true; });

  // A lost hub cannot receive events any more: stop everything this node started.
  peer.onClose(() => { for (const session of sessions.values()) { try { session.stop(); } catch {} } sessions.clear(); });
  return { sessions };
}
module.exports = { serveNode };
