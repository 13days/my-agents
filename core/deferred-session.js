// Accept IM/web input while the original CLI finishes its turn. Never send a
// second writer into the native transcript during a tool call or model request.
function createDeferredSession({ sessionId, open, busy, emit, onClosed, routed = false, pollMs = 1000, quietMs = 2000, now = Date.now }) {
  let inner = null, closed = false, opening = false, timer, idleSince = null, startingIds = [];
  const pending = [];
  const finish = () => { if (closed) return; closed = true; clearTimeout(timer); onClosed(); };
  const schedule = () => { if (!closed) { timer = setTimeout(pump, pollMs); timer.unref?.(); } };
  async function pump() {
    if (closed || opening || !pending.length) return;
    try {
      const active = await busy();
      if (closed) return;
      if (active) { idleSince = null; schedule(); return; }
      if (idleSince === null) idleSince = now();
      if (now() - idleSince < quietMs) { schedule(); return; }
      opening = true;
      inner = await open(finish);
      if (closed) { inner.stop(); return; }
      // Inputs received while waiting stay in order; steering must not discard
      // the first queued question when the real session finally starts.
      const entries = pending.splice(0); startingIds = entries.map(entry => entry.id);
      for (const entry of entries) inner.submit(entry.id, entry.input, false);
      const actual = await inner.ready;
      if (closed) { inner.stop(); return; }
      if (actual !== sessionId) throw new Error('未能接续原会话，已停止本次启动');
      opening = false;
    } catch (error) {
      const ids = new Set([...startingIds, ...pending.splice(0).map(entry => entry.id)]);
      for (const id of ids) emit('error', { messageId: id, error: error.message });
      inner?.stop();
      finish();
    }
  }
  return {
    ready: Promise.resolve(sessionId),
    get routed() { return inner?.routed ?? routed; },
    submit(id, input, steer, accept) {
      if (closed) throw new Error('等待接续已取消，请重新发送');
      if (inner && !pending.length) return inner.submit(id, input, steer, accept);
      pending.push({ id, input }); accept?.();
      emit('warning', { messageId: id, kind: 'native_handoff', warning: '问题已接收，正在等待原执行机器当前一轮完成。完成后自动沿用原会话、目录和历史接续；停止任务只会取消这次等待。' });
      if (!timer && !opening) schedule();
    },
    stop() { pending.length = 0; inner?.stop(); finish(); },
    close() { pending.length = 0; inner?.close(); finish(); },
    respondPermission: (...args) => { if (!inner) throw new Error('尚未开始执行'); return inner.respondPermission(...args); },
    get currentId() { return inner?.currentId || pending[0]?.id || ''; },
    get pendingCount() { return inner?.pendingCount || Math.max(0, pending.length - 1); },
    get busy() { return !closed && (!!pending.length || opening && !inner || !!inner?.busy); },
  };
}
module.exports = { createDeferredSession };
