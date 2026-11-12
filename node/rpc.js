const crypto = require('crypto');
// Minimal JSON-RPC 2.0 peer over any message transport. Both sides can call
// and notify. A transport is { send(text), onMessage(fn), onClose(fn), close() }.
function createPeer(transport, { timeoutMs = 30000 } = {}) {
  const pending = new Map(), handlers = new Map(), listeners = new Map(), closeListeners = [];
  let nextId = 1, closed = false, chunked = false;
  const fragments = new Map();
  let bufferedBytes = 0, queuedBytes = 0, sending = Promise.resolve();
  const CHUNK = 128 * 1024, MAX_BYTES = 64 * 1024 * 1024;

  const write = message => {
    if (closed) return;
    const text = JSON.stringify({ jsonrpc: '2.0', ...message });
    if (Buffer.byteLength(text) <= CHUNK) return transport.send(text);
    if (Buffer.byteLength(text) > MAX_BYTES) throw Object.assign(new Error('RPC 请求超过 64 MiB'), { status: 413 });
    if (!chunked) { if (Buffer.byteLength(text) > 6 * 1024 * 1024) throw Object.assign(new Error('节点不支持大请求分块，请更新该节点'), { status: 413 }); return transport.send(text); }
    const bytes = Buffer.byteLength(text);
    if (queuedBytes + bytes > MAX_BYTES) throw Object.assign(new Error('RPC 数据发送队列已满，请稍后重试'), { status: 429 });
    queuedBytes += bytes;
    const id = crypto.randomUUID(), total = Math.ceil(text.length / CHUNK);
    sending = sending.catch(() => {}).then(async () => {
      for (let part = 0; part < total; part++) {
        while (!closed && transport.bufferedBytes > 256 * 1024) await new Promise(resolve => setTimeout(resolve, 5));
        if (closed) return;
        transport.send(JSON.stringify({ jsonrpc: '2.0', method: '$fragment', params: { id, part, total, text: text.slice(part * CHUNK, (part + 1) * CHUNK) } }));
        // Let heartbeats and small control messages bypass the remaining body.
        await new Promise(resolve => setImmediate(resolve));
      }
    }).catch(error => {
      const request = pending.get(message.id);
      if (request) { pending.delete(message.id); clearTimeout(request.timer); request.reject(error); }
    }).finally(() => { queuedBytes -= bytes; });
    return sending;
  };
  const fail = (id, error) => write({ id, error: { message: error?.message || String(error), ...(error?.status ? { data: { status: error.status } } : {}) } });

  transport.onMessage(async text => {
    let message;
    try { message = JSON.parse(text); } catch { return; }
    if (!message || typeof message !== 'object') return;
    if (message.method === '$capabilities') { chunked = message.params?.chunks === true; return; }
    if (message.method === '$fragment') {
      const { id, part, total, text: body } = message.params || {};
      if (typeof id !== 'string' || id.length > 80 || !Number.isInteger(part) || !Number.isInteger(total) || part < 0 || part >= total || total > 512 || typeof body !== 'string' || body.length > CHUNK) return;
      let item = fragments.get(id);
      if (!item) {
        if (part !== 0 || fragments.size >= 8) return;
        item = { parts: [], bytes: 0, total, timer: setTimeout(() => { if (fragments.delete(id)) bufferedBytes -= item.bytes; }, 30000) }; item.timer.unref?.(); fragments.set(id, item);
      }
      if (part !== item.parts.length || total !== item.total) return;
      const bytes = Buffer.byteLength(body);
      if (bufferedBytes + bytes > MAX_BYTES) { fragments.delete(id); clearTimeout(item.timer); bufferedBytes -= item.bytes; return; }
      clearTimeout(item.timer); item.timer = setTimeout(() => { if (fragments.delete(id)) bufferedBytes -= item.bytes; }, 30000); item.timer.unref?.();
      item.parts.push(body); item.bytes += bytes; bufferedBytes += bytes;
      if (item.parts.length !== total) return;
      fragments.delete(id); clearTimeout(item.timer); bufferedBytes -= item.bytes;
      try { message = JSON.parse(item.parts.join('')); } catch { return; }
      if (!message || typeof message !== 'object' || message.method === '$fragment') return;
    }
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
    for (const item of fragments.values()) clearTimeout(item.timer); fragments.clear(); bufferedBytes = 0;
    for (const listener of closeListeners) { try { listener(); } catch {} }
  });

  queueMicrotask(() => { if (!closed) write({ method: '$capabilities', params: { chunks: true } }); });
  return {
    call(method, params = {}, { timeout = timeoutMs } = {}) {
      if (closed) return Promise.reject(new Error('节点连接已断开'));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = timeout ? setTimeout(() => { pending.delete(id); reject(new Error(`节点响应超时：${method}`)); }, timeout) : null;
        timer?.unref?.();
        pending.set(id, { resolve, reject, timer });
        try { write({ id, method, params }); } catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
      });
    },
    notify: (method, params = {}) => write({ method, params }),
    handle(method, fn) { handlers.set(method, fn); return this; },
    on(method, fn) { if (!listeners.has(method)) listeners.set(method, []); listeners.get(method).push(fn); return this; },
    onClose(fn) { if (closed) fn(); else closeListeners.push(fn); },
    close() { transport.close(); },
    get closed() { return closed; },
    get bufferedBytes() { return transport.bufferedBytes || 0; },
  };
}
module.exports = { createPeer };
