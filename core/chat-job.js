// Browser connections subscribe to a job; closing a tab does not stop the CLI.
function createChatJob(meta, { journal = null, recovered = false } = {}) {
  const events = [], subscribers = new Set(), listeners = new Set(), started = new Map();
  let closed = recovered;
  let sequence = 0, journalHealthy = !!journal, persistenceError = '';
  const write = (res, event, data, seq) => { if (!res.destroyed && !res.writableEnded) res.write(`${seq ? 'id: ' + (meta.jobId ? meta.jobId + ':' : '') + seq + '\n' : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  const remember = (event, data, seq) => {
    sequence = Math.max(sequence, seq);
    const last = events[events.length - 1];
    if (event === 'text' && last?.event === 'text' && last.data.messageId === data.messageId) { last.data.text += data.text || ''; last.seq = seq; }
    else events.push({ event, data: { ...data }, seq });
  };
  if (recovered && journal) for (const row of journal.read()) remember(row.event, row.data, row.seq);
  return {
    meta,
    events,
    get closed() { return closed; },
    get persistenceError() { return persistenceError; },
    publish(event, data) {
      if (closed) return;
      data = { ...data, timestamp: data.timestamp || new Date().toISOString() };
      const id = data.messageId || data.id;
      if (event === 'turn' && id) started.set(id, Date.parse(data.timestamp));
      if (event === 'done' && started.has(id) && data.durationMs === undefined) data.durationMs = Math.max(0, Date.parse(data.timestamp) - started.get(id));
      let seq;
      try { seq = journalHealthy ? journal.append(event, data) : ++sequence; }
      catch (error) {
        journalHealthy = false; persistenceError = error.code || 'WRITE_FAILED';
        const warning = { kind: 'storage_error', messageId: data.messageId || data.id, warning: '磁盘写入失败，任务进度暂保留在内存；请保留原会话并检查磁盘空间', timestamp: new Date().toISOString() }, warningSeq = ++sequence;
        remember('warning', warning, warningSeq);
        for (const res of subscribers) write(res, 'warning', warning, warningSeq);
        for (const listener of listeners) { try { listener('warning', warning); } catch {} }
        seq = ++sequence;
      }
      remember(event, data, seq);
      for (const res of subscribers) write(res, event, data, seq);
      for (const listener of listeners) { try { listener(event, data); } catch {} }
    },
    subscribe(res, after = null) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.socket?.setNoDelay(true); res.flushHeaders?.();
      write(res, 'meta', meta);
      const replay = after !== null && journalHealthy ? journal.read(after) : after !== null ? events.filter(item => item.seq > after) : events;
      for (const item of replay) write(res, item.event, item.data, item.seq);
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
function parseCursor(value, jobId) {
  const raw = String(value || ''); if (/^\d+$/.test(raw)) return Number(raw);
  const colon = raw.lastIndexOf(':'); return colon > 0 && raw.slice(0, colon) === jobId && /^\d+$/.test(raw.slice(colon + 1)) ? Number(raw.slice(colon + 1)) : null;
}
module.exports = { createChatJob, parseCursor };
