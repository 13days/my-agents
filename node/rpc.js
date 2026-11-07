// Minimal JSON-RPC 2.0 peer over any message transport. Both sides can call
// and notify. A transport is { send(text), onMessage(fn), onClose(fn), close() }.
function createPeer(transport, { timeoutMs = 30000 } = {}) {
  const pending = new Map(), handlers = new Map(), listeners = new Map(), closeListeners = [];
  let nextId = 1, closed = false;

  const write = message => { if (!closed) transport.send(JSON.stringify({ jsonrpc: '2.0', ...message })); };
  const fail = (id, error) => write({ id, error: { message: error?.message || String(error), ...(error?.status ? { data: { status: error.status } } : {}) } });

  transport.onMessage(async text => {
    let message;
    try { message = JSON.parse(text); } catch { return; }
    if (!message || typeof message !== 'object') return;
    if (message.method && message.id !== undefined) {
      const handler = handlers.get(message.method);
      if (!handler) return fail(message.id, new Error(`未知方法：${message.method}`));
      try { write({ id: message.id, result: (await handler(message.params || {})) ?? null }); }
      catch (e) { fail(message.id, e); }
    } else if (message.method) {
      for (const listener of listeners.get(message.method) || []) { try { listener(message.params || {}); } catch {} }
    } else if (pending.has(message.id)) {
      const { resolve, reject, timer } = pending.get(message.id);
      pending.delete(message.id); clearTimeout(timer);
      if (message.error) reject(Object.assign(new Error(message.error.message), message.error.data?.status ? { status: message.error.data.status } : {}));
      else resolve(message.result);
    }
  });
  transport.onClose(() => {
    if (closed) return;
    closed = true;
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error('节点连接已断开')); }
    pending.clear();
    for (const listener of closeListeners) { try { listener(); } catch {} }
  });

  return {
    call(method, params = {}, { timeout = timeoutMs } = {}) {
      if (closed) return Promise.reject(new Error('节点连接已断开'));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = timeout ? setTimeout(() => { pending.delete(id); reject(new Error(`节点响应超时：${method}`)); }, timeout) : null;
        timer?.unref?.();
        pending.set(id, { resolve, reject, timer });
        write({ id, method, params });
      });
    },
    notify: (method, params = {}) => write({ method, params }),
    handle(method, fn) { handlers.set(method, fn); return this; },
    on(method, fn) { if (!listeners.has(method)) listeners.set(method, []); listeners.get(method).push(fn); return this; },
    onClose(fn) { if (closed) fn(); else closeListeners.push(fn); },
    close() { transport.close(); },
    get closed() { return closed; },
  };
}
module.exports = { createPeer };
