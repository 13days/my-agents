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
function createSessionManager({ registry, history, idleMs = 3 * 60 * 1000, retentionMs = 5 * 60 * 1000, readyTimeoutMs = 90000, ensureNode = async () => {}, resolveLocation = null, resolveModel = null, runStore = null, log = console }) {
  const runs = new Map();
  const aliases = new Map(), preparations = new Map();
  runStore?.recover();
  for (const row of runStore?.list() || []) if (row.requestedId && row.sessionId && !aliases.has(row.requestedId)) aliases.set(row.requestedId, row.sessionId);
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

  function get(id) {
    const current = runs.get(resolveId(id)); if (current) return current;
    const saved = runStore?.find(resolveId(id)); if (!saved?.sessionId) return null;
    const job = createChatJob(saved.jobMeta || { sessionId: saved.sessionId, jobId: saved.id, conversationId: saved.conversationId }, { journal: runStore.journal(saved.id), recovered: true });
    const run = { id: saved.sessionId, engine: saved.engine, node: saved.node, job, recovered: true };
    runs.set(run.id, run); return run;
  }
  function busy(id) { const run = get(id); return !!(live(run) && (run.session.currentId || run.session.pendingCount)); }

  // Starts (or resumes) a session and its first turn. Resolves once the engine
  // knows the real session id, which may differ from the requested one.
  async function start(input) {
    const turn = validateInput(input);
    const conversationId = runStore?.find(input.sessionId)?.conversationId || (typeof input.sessionId === 'string' && SESSION_ID.test(input.sessionId) ? input.sessionId : crypto.randomUUID());
    const record = runStore?.begin({ conversationId, requestedId: input.sessionId || '', engine: input.engine || registry.defaultId(), node: input.node || 'local' }, turn);
    const preparingId = record?.id || crypto.randomUUID();
    const preparation = { id: preparingId, conversationId, state: 'preparing', messageId: turn.messageId, controller: new AbortController() };
    preparations.set(preparingId, preparation);
    try { return await startActual(input, turn, record, preparation); }
    catch (error) { if (record) runStore.update(record.id, { state: preparation.controller.signal.aborted ? 'cancelled' : 'failed', error: error.message }); throw error; }
    finally { preparations.delete(preparingId); }
  }
  async function startActual(input, turn, record, preparation) {
    const requested = typeof input.sessionId === 'string' && SESSION_ID.test(input.sessionId) ? resolveId(input.sessionId) : '';
    // Keep ownership unless an explicit switch or an offline handoff selects a new execution.
    const owner = requested ? await history.ownerOf(requested) : null;
    const engineId = input.switchMachine === true ? input.engine || owner?.engine || registry.defaultId() : owner?.engine || input.engine || registry.defaultId();
    const location = resolveLocation ? await resolveLocation(input, owner) : null;
    const nodeId = location?.node || owner?.node || input.node || 'local';
    await ensureNode(nodeId);
    const engine = registry.adapter(engineId, nodeId);
    if (!engine) throw httpError(400, `节点 ${nodeId} 上没有引擎：${engineId}`);
    const host = registry.node(nodeId).host;
    const cancelled = () => { if (preparation.controller.signal.aborted) throw httpError(409, '任务准备已取消，未开始执行'); };
    cancelled();
    let cwd;
    try { cwd = await host.resolveDir(location?.cwd || owner?.project || input.cwd); }
    catch (error) { throw httpError(error.status || 400, `执行机器「${registry.node(nodeId).label || nodeId}」无法使用目录 ${location?.cwd || owner?.project || input.cwd || '(默认)'}：${error.message}。请在「机器与引擎 → 项目与目录」检查映射`); }

    const previous = requested && runs.get(requested);
    if (live(previous) && !location?.handoff) {
      if (previous.session.currentId || previous.session.pendingCount || previous.session.busy) throw httpError(409, '此会话正在运行，请重新打开会话接续');
      previous.session.close(); // idle connection: replace it with a fresh one
    }
    // Engines that discover their own ids treat unknown ids as new sessions.
    const known = !location?.handoff && !!requested && await engine.owns(requested);
    // A resumed session keeps its original directory; only fresh tasks isolate.
    let worktree = location?.handoff && (location.handoff.from !== location.handoff.to || location.cwd !== owner?.project) ? null : owner?.worktree || null;
    if (!known && (!owner || location?.handoff) && !worktree && input.worktree === true) {
      if (!host.createWorktree) throw httpError(400, '此节点不支持独立工作区，请更新节点 my-agents');
      if (record) runStore.update(record.id, { state: 'preparing_workspace', cwd, node: nodeId, engine: engineId });
      worktree = await host.createWorktree(cwd, { signal: preparation.controller.signal, operationId: preparation.id });
      cancelled();
      if (worktree) cwd = worktree.cwd;
    }
    const sessionId = engine.capabilities.sessionId === 'discovered' ? (known ? requested : '') : (location?.handoff ? crypto.randomUUID() : requested || crypto.randomUUID());
    let model = typeof input.model === 'string' && input.model.trim() && engine.validModel(input.model.trim()) ? input.model.trim() : '';
    if (!model && resolveModel) model = await resolveModel({ engine: engineId, sessionId: requested, accountId: input.accountId || '', node: nodeId }) || '';
    const baseHistory = known || location?.handoff ? await history.messages(requested) : null;
    if (location?.handoff) {
      const checkpoint = (baseHistory?.messages || []).slice(-12).map(item => `${item.role}: ${String(item.text || '').slice(0,1500)}`).join('\n').slice(-7500);
      location.handoff.context = checkpoint ? 'checkpoint' : 'unavailable';
      turn.context = (`执行位置已从 ${location.handoff.from} 切换到 ${location.handoff.to}。这是新的原生 Agent 会话。以下仅为可获取的对话检查点，不代表文件或工具状态已同步。上一任务的执行结果可能未知，先检查项目现状，不要直接重放之前的命令。\n${checkpoint || '没有可恢复的历史摘要，请明确说明缺少上下文。'}\n\n` + turn.context).slice(0,12000);
    }

    const buffered = [];
    let run = null, idleTimer;
    const emit = (event, data) => {
      const payload = { timestamp: new Date().toISOString(), ...data, ...(session?.currentId && !data.messageId ? { messageId: session.currentId } : {}) };
      if (!run) return void buffered.push([event, payload]);
      if (run.job.closed) return;
      run.job.publish(event, payload);
      try { history.record?.(run.id, event, payload); } catch (error) { log.warn?.(error.message); }
    };
    const armIdle = () => {
      clearTimeout(idleTimer);
      if (!session || session.busy) return;
      idleTimer = setTimeout(() => { if (!session.busy) session.close(); }, idleMs);
      idleTimer.unref?.();
    };
    const onClosed = () => {
      clearTimeout(idleTimer);
      if (run && !run.job.closed) { history.record?.(run.id,'end',{}); run.job.close(); }
      const current = run;
      const retention = setTimeout(() => { if (current && runs.get(current.id) === current) runs.delete(current.id); }, retentionMs);
      retention.unref?.();
    };
    let session;
    cancelled();
    session = await engine.open({ host, sessionId, resume: known, cwd, model, accountId: input.accountId, emit, onIdle: armIdle, onClosed });
    if (preparation.controller.signal.aborted) { session.close(); cancelled(); }
    const cancelLaunch = () => session.stop(); preparation.controller.signal.addEventListener('abort', cancelLaunch, { once: true });
    emit('input', { id: turn.messageId, prompt: turn.prompt, images: turn.images });
    session.submit(turn.messageId, turn, false);

    let realId;
    try {
      realId = await Promise.race([session.ready, new Promise((_, reject) => setTimeout(() => reject(httpError(503, `${engine.meta.label} 启动超时（${Math.round(readyTimeoutMs / 1000)} 秒内未创建会话）`)), readyTimeoutMs).unref?.())]);
    } catch (e) {
      session.stop();
      throw e.status ? e : httpError(503, e.message);
    }
    preparation.controller.signal.removeEventListener('abort', cancelLaunch);
    cancelled();
    if (requested && realId !== requested) aliases.set(requested, realId);
    history.touch(realId, { engine: engineId, node: host.id, ...(location?.machineId ? { machineId: location.machineId } : {}), cwd, worktree, workspaceId: location?.workspaceId, handoff: location?.handoff, prompt: turn.prompt, created: !known });

    const jobMeta = { conversationId: record?.conversationId || realId, routed: !!session.routed, engine: engineId, node: host.id, machineId: location?.machineId, workspaceId: location?.workspaceId, handoff: location?.handoff, cwd, worktree, model, sessionId: realId, jobId: record?.id || crypto.randomUUID() };
    if (record) runStore.update(record.id, { state: 'running', sessionId: realId, engine: engineId, node: host.id, jobMeta });
    const job = createChatJob(jobMeta, { journal: record ? runStore.journal(record.id) : null });
    run = { id: realId, engine: engineId, node: host.id, job, session, baseHistory, baseMessages: baseHistory?.messages || [], stopped: false, requestedId: requested };
    runs.set(realId, run);
    for (const [event, data] of buffered.splice(0)) { job.publish(event, data); history.record?.(realId,event,data); }
    return { sessionId: realId, run };
  }

  // Adds input to a live run; steering interrupts the active turn when supported.
  function send(id, input) {
    const run = get(id);
    if (!live(run)) throw httpError(409, '会话连接已结束，请重新发送');
    const turn = validateInput(input);
    if (runStore?.hasMessage(turn.messageId)) return { messageId: turn.messageId };
    run.session.submit(turn.messageId, turn, input.mode !== 'queue', () => { const data = { id: turn.messageId, prompt: turn.prompt, images: turn.images, mode: input.mode, timestamp: new Date().toISOString() }; run.job.publish('input', data); history.record?.(run.id, 'input', data); });
    history.touch(run.id, { prompt: turn.prompt });
    return { messageId: turn.messageId };
  }

  function stop(id) {
    const preparing = preparations.get(id) || [...preparations.values()].find(item => item.conversationId === id);
    if (preparing) { preparing.state = 'cancelling'; preparing.controller.abort(); return true; }
    const run = get(id);
    if (!live(run)) return false;
    run.stopped = true;
    run.job.publish('stopped', {});
    history.record?.(run.id, 'stopped', {});
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
    tasks: () => runStore?.list() || [...preparations.values()],
    preparing: () => [...preparations.values()].map(({ controller, ...row }) => row),
    running: () => [...preparations.values()].map(item => item.conversationId).concat([...runs.values()].filter(run => live(run) && (run.session.currentId || run.session.pendingCount)).map(run => run.id)),
    shutdown() { for (const item of preparations.values()) item.controller.abort(); for (const run of runs.values()) if (live(run)) { try { run.session.stop(); } catch (e) { log.warn?.(e.message); } } },
  };
}
module.exports = { createSessionManager, httpError };
