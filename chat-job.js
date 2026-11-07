// Browser connections subscribe to a job; closing a tab does not stop the CLI.
function createChatJob(meta) {
  const events = [], subscribers = new Set(), listeners = new Set(), started = new Map();
  let closed = false;
  const write = (res, event, data) => { if (!res.destroyed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  return {
    meta,
    events,
    get closed() { return closed; },
    publish(event, data) {
      if (closed) return;
      data = { ...data, timestamp: data.timestamp || new Date().toISOString() };
      const id = data.messageId || data.id;
      if (event === 'turn' && id) started.set(id, Date.parse(data.timestamp));
      if (event === 'done' && started.has(id) && data.durationMs === undefined) data.durationMs = Math.max(0, Date.parse(data.timestamp) - started.get(id));
      const last = events[events.length - 1];
      // Compact adjacent text deltas for replay while forwarding every delta.
      if (event === 'text' && last?.event === 'text' && last.data.messageId === data.messageId) last.data.text += data.text || '';
      else events.push({ event, data: { ...data } });
      for (const res of subscribers) write(res, event, data);
      for (const listener of listeners) { try { listener(event, data); } catch {} }
    },
    subscribe(res) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.socket?.setNoDelay(true); res.flushHeaders?.();
      write(res, 'meta', meta);
      for (const item of events) write(res, item.event, item.data);
      write(res, 'replay_end', {});
      if (closed) res.end();
      else {
        subscribers.add(res);
        const heartbeat = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(': keep-alive\n\n'); }, 15000);
        heartbeat.unref();
        res.on('close', () => { clearInterval(heartbeat); subscribers.delete(res); });
      }
    },
    listen(listener) {
      for (const item of events) listener(item.event, item.data);
      if (!closed) listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      if (closed) return;
      this.publish('end', {}); closed = true;
      for (const res of subscribers) if (!res.destroyed) res.end();
      subscribers.clear();
      listeners.clear();
    },
  };
}
module.exports = { createChatJob };
