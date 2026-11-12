const { createRelayClient } = require('./relay');
// A node owns its sessions independently of an individual control connection.
// Rebinding a controller replays events; it never launches the CLI a second time.
function createExecutionRuntime({ eventLimit = 10000, maxEventBytes = 8 * 1024 * 1024, maxSessions = 200, dir = null } = {}) {
  const owners = new Map();
  const store = dir ? require('../core/run-store').createRunStore({ dir }) : null;
  function owner(id) {
    if (!owners.has(id)) owners.set(id, { sessions: new Map(), records: new Map(), peer: null, relay: null });
    return owners.get(id);
  }
  return {
    bind(id, peer) {
      const entry = owner(id); entry.peer = peer;
      for (const record of entry.records.values()) record.attached = false;
      if (entry.relay) entry.relay.attach(peer); else entry.relay = createRelayClient(peer, { reconnectable: true });
      peer.onClose(() => { if (entry.peer === peer) entry.peer = null; });
      return entry;
    },
    claim(id, sid, meta) {
      const entry = owner(id);
      if (entry.records.has(sid)) return entry.records.get(sid);
      if (meta.sessionId) for (const other of owners.values()) for (const record of other.records.values()) {
        if (record.engine !== meta.engine || record.sessionId !== meta.sessionId || record.closed) continue;
        const session = other.sessions.get(record.sid);
        if (!session || session.busy) throw Object.assign(new Error('原会话正在执行或启动，请连接现有任务后继续'), { status: 409 });
        session.close();
      }
      for (const [key, record] of entry.records) { const session = entry.sessions.get(key); if (!record.closed && session && !session.busy && Date.now() - record.updatedAt > 300000) { session.close(); entry.records.delete(key); entry.sessions.delete(key); } }
      for (const [key, record] of entry.records) if (record.closed && Date.now() - record.updatedAt > 300000) { entry.records.delete(key); entry.sessions.delete(key); }
      if (entry.records.size >= maxSessions) throw new Error('执行器任务数量已达上限，请先结束空闲任务');
      const saved = store?.begin({ ...meta, sid, owner: id }, { messageId: id + ':' + sid });
      const record = { ...meta, journal: saved ? store.journal(saved.id) : null, sid, seq: 0, events: [], eventBytes: 0, attached: true, closed: false, updatedAt: Date.now() }; entry.records.set(sid, record); return record;
    },
    emit(id, sid, method, payload) {
      const entry = owner(id), record = entry.records.get(sid); if (!record) return;
      const data = { ...payload, sid, seq: ++record.seq };
      try { record.journal?.append(method, data); } catch (error) { record.journal = null; record.persistenceError = error.code || 'WRITE_FAILED'; }
      record.updatedAt = Date.now();
      if (method === 'session.ready') record.sessionId = data.id;
      if (method === 'session.closed') record.closed = true;
      const bytes = Buffer.byteLength(JSON.stringify(data)); record.eventBytes += bytes;
      record.events.push({ method, data, bytes });
      while (record.events.length > eventLimit || record.eventBytes > maxEventBytes) { record.eventBytes -= record.events.shift().bytes; record.truncated = true; }
      if (record.attached) { try { entry.peer?.notify(method, data); } catch { record.attached = false; } }
    },
    async attach(id, sid, peer, after = 0) {
      const entry = owner(id), record = entry.records.get(sid); if (!record) throw new Error('执行器没有此任务；结果需核对，未自动重新执行');
      if (!record.journal && record.truncated && after < (record.events[0]?.data.seq || record.seq + 1) - 1) throw new Error('执行事件已超出内存保留范围，请查看原会话历史');
      entry.peer = peer; record.attached = false;
      let cursor = after, sent = 0;
      do {
        const replay = record.journal ? record.journal.read(cursor).map(row => ({ method: row.event, data: row.data })) : record.events.filter(item => item.data.seq > cursor);
        if (!replay.length && record.seq > cursor) throw new Error('执行器事件游标不连续，请查看原会话历史');
        for (const item of replay) if (item.data.seq > cursor) {
          if (peer.closed) throw new Error('控制连接在恢复事件时断开');
          peer.notify(item.method, item.data); cursor = item.data.seq;
          if (++sent % 100 === 0) await new Promise(resolve => setImmediate(resolve));
          const deadline = Date.now() + 30000;
          while (peer.bufferedBytes > 1024 * 1024) {
            if (peer.closed || Date.now() > deadline) throw new Error('恢复事件时控制通道拥塞，请重新连接');
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        }
      } while (cursor < record.seq);
      record.attached = true;
      const session = entry.sessions.get(sid);
      return { sid, sessionId: record.sessionId, closed: record.closed, routed: !!session?.routed, nativeAttached: !!session?.nativeAttached, state: { currentId: session?.currentId || '', pendingCount: session?.pendingCount || 0, busy: !!session?.busy } };
    },
    record: (id, sid) => owner(id).records.get(sid),
    running: () => [...owners.values()].flatMap(entry => [...entry.sessions].filter(([sid, session]) => !entry.records.get(sid)?.closed && session.busy).map(([sid]) => sid)),
    shutdown() { for (const entry of owners.values()) for (const session of entry.sessions.values()) { try { session.stop(); } catch {} } },
  };
}
module.exports = { createExecutionRuntime };
