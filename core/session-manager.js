const crypto = require('crypto');
const { createChatJob } = require('./chat-job');
const { imageContent } = require('./chat-input');

const MESSAGE_ID = /^[\w-]{8,100}$/;
const SESSION_ID = /^[a-zA-Z0-9-]{8,100}$/;
const httpError = (status, message) => Object.assign(new Error(message), { status });

// Engine-neutral runtime for panel-started sessions. Channels (web, Feishu, …)
// call these functions directly; engines are reached only through the registry.
//
// Every run publishes the same event vocabulary (see core/events.js) into a
// replayable job so a reconnecting client resumes where it left off.
function createSessionManager({ registry, history, idleMs = 3 * 60 * 1000, retentionMs = 5 * 60 * 1000, readyTimeoutMs = 90000, log = console }) {
  const runs = new Map();
  const aliases = new Map();
  const resolveId = id => aliases.get(id) || id;
  const live = run => run && !run.job.closed;

  const validateInput = input => {
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    const context = typeof input.context === 'string' ? input.context : '';
    if (context.length > 12000) throw httpError(400, '发送上下文过长');
    let images;
    try { images = imageContent(input.images); } catch (e) { throw httpError(400, e.message); }
    if ((!prompt && !images.length) || prompt.length > 20000) throw httpError(400, '请输入不超过 20000 字的内容，或附带图片');
    const messageId = typeof input.messageId === 'string' && MESSAGE_ID.test(input.messageId) ? input.messageId : crypto.randomUUID();
    return { prompt, context, images: input.images || [], messageId };
  };

  function get(id) { return runs.get(resolveId(id)) || null; }
  function busy(id) { const run = get(id); return !!(live(run) && (run.session.currentId || run.session.pendingCount)); }

  // Starts (or resumes) a session and its first turn. Resolves once the engine
  // knows the real session id, which may differ from the requested one.
  async function start(input) {
    const turn = validateInput(input);
    const requested = typeof input.sessionId === 'string' && SESSION_ID.test(input.sessionId) ? resolveId(input.sessionId) : '';
    // An existing session always stays on the engine and node that own it.
    const owner = requested ? await history.ownerOf(requested) : null;
    const engineId = owner?.engine || input.engine || registry.defaultId();
    const nodeId = input.node || owner?.node || 'local';
    const engine = registry.adapter(engineId, nodeId);
    if (!engine) throw httpError(400, `节点 ${nodeId} 上没有引擎：${engineId}`);
    const host = registry.node(nodeId).host;
    const cwd = await host.resolveDir(input.cwd);

    const previous = requested && runs.get(requested);
    if (live(previous)) {
      if (previous.session.currentId || previous.session.pendingCount || previous.session.busy) throw httpError(409, '此会话正在运行，请重新打开会话接续');
      previous.session.close(); // idle connection: replace it with a fresh one
    }
    // Engines that discover their own ids treat unknown ids as new sessions.
    const known = !!requested && await engine.owns(requested);
    const sessionId = engine.capabilities.sessionId === 'discovered' ? (known ? requested : '') : (requested || crypto.randomUUID());
    const model = typeof input.model === 'string' && input.model.trim() && engine.validModel(input.model.trim()) ? input.model.trim() : '';
    const baseHistory = known ? await history.messages(requested) : null;

    const buffered = [];
    let run = null, idleTimer;
    const emit = (event, data) => {
      const payload = { timestamp: new Date().toISOString(), ...data, ...(session?.currentId && !data.messageId ? { messageId: session.currentId } : {}) };
      if (!run) return void buffered.push([event, payload]);
      if (run.job.closed) return;
      run.job.publish(event, payload);
    };
    const armIdle = () => {
      clearTimeout(idleTimer);
      if (!session || session.busy) return;
      idleTimer = setTimeout(() => { if (!session.busy) session.close(); }, idleMs);
      idleTimer.unref?.();
    };
    const onClosed = () => {
      clearTimeout(idleTimer);
      if (run && !run.job.closed) run.job.close();
      const current = run;
      const retention = setTimeout(() => { if (current && runs.get(current.id) === current) runs.delete(current.id); }, retentionMs);
      retention.unref?.();
    };
    let session;
    session = await engine.open({ host, sessionId, resume: known, cwd, model, accountId: input.accountId, emit, onIdle: armIdle, onClosed });
    emit('input', { id: turn.messageId, prompt: turn.prompt, images: turn.images });
    session.submit(turn.messageId, turn, false);

    let realId;
    try {
      realId = await Promise.race([session.ready, new Promise((_, reject) => setTimeout(() => reject(httpError(503, `${engine.meta.label} 启动超时（${Math.round(readyTimeoutMs / 1000)} 秒内未创建会话）`)), readyTimeoutMs).unref?.())]);
    } catch (e) {
      session.stop();
      throw e.status ? e : httpError(503, e.message);
    }
    if (requested && realId !== requested) aliases.set(requested, realId);
    history.touch(realId, { engine: engineId, node: host.id, cwd, prompt: turn.prompt, created: !known });

    const job = createChatJob({ routed: !!session.routed, engine: engineId, node: host.id, cwd, sessionId: realId, jobId: crypto.randomUUID() });
    run = { id: realId, engine: engineId, node: host.id, job, session, baseHistory, baseMessages: baseHistory?.messages || [], stopped: false, requestedId: requested };
    runs.set(realId, run);
    for (const [event, data] of buffered.splice(0)) job.publish(event, data);
    return { sessionId: realId, run };
  }

  // Adds input to a live run; steering interrupts the active turn when supported.
  function send(id, input) {
    const run = get(id);
    if (!live(run)) throw httpError(409, '会话连接已结束，请重新发送');
    const turn = validateInput(input);
    run.session.submit(turn.messageId, turn, input.mode !== 'queue', () => run.job.publish('input', { id: turn.messageId, prompt: turn.prompt, images: turn.images, mode: input.mode }));
    history.touch(run.id, { prompt: turn.prompt });
    return { messageId: turn.messageId };
  }

  function stop(id) {
    const run = get(id);
    if (!live(run)) return false;
    run.stopped = true;
    run.job.publish('stopped', {});
    run.session.stop();
    return true;
  }

  function respondPermission(id, requestId, behavior) {
    const run = get(id);
    if (!live(run)) throw httpError(409, '会话连接已结束');
    run.session.respondPermission(requestId, behavior);
  }

  function pendingPermissions(id) {
    const pending = new Map();
    for (const { event, data } of get(id)?.job.events || []) {
      if (event === 'permission') pending.set(data.id, data);
      if (event === 'permission_resolved') pending.delete(data.id);
    }
    return [...pending.values()];
  }

  function watch(id, listener) {
    const run = get(id);
    if (!run) throw new Error('任务未启动或已结束');
    return run.job.listen(listener);
  }

  // Delivers a warning into the active turn of a session (e.g. upstream errors seen by the proxy).
  function warn(id, warning) {
    const run = get(id);
    if (live(run) && run.session.currentId) run.job.publish('warning', { messageId: run.session.currentId, warning });
  }

  return {
    start, send, stop, respondPermission, pendingPermissions, watch, warn, get, busy, resolveId,
    running: () => [...runs.values()].filter(run => live(run) && (run.session.currentId || run.session.pendingCount)).map(run => run.id),
    shutdown() { for (const run of runs.values()) if (live(run)) { try { run.session.stop(); } catch (e) { log.warn?.(e.message); } } },
  };
}
module.exports = { createSessionManager, httpError };
