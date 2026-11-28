// One user turn at a time, shared by every engine. Steering inputs jump ahead
// of queued ones and interrupt the active turn when the engine supports it.
// The engine supplies how a turn starts and how it is interrupted; it reports
// completion with finish().
function createTurnQueue({ start, forward, interrupt, canInterrupt = () => true, isOpen = () => true, onIdle, limit = 20 }) {
  const pending = [], seen = new Set();
  let current = null, stopped = false;
  const pump = () => {
    if (stopped || current || !pending.length) return;
    current = pending.shift();
    start(current);
  };
  return {
    submit(id, payload, steer = false, onAccept, insert = false) {
      if (stopped || !isOpen()) throw new Error('会话连接已结束，请重新发送');
      if (seen.has(id)) return;
      if (pending.length >= limit) throw new Error('等待中的消息太多，请稍后再发送');
      seen.add(id);
      onAccept?.();
      const entry = { id, payload, steer, interrupted: false };
      // Forwarded inputs already belong to the CLI. Its acknowledgement tells us
      // whether they joined the active turn or will start after the current result.
      if (insert && current && forward) {
        entry.forwarded = true;
        const at = pending.findIndex(item => !item.forwarded);
        pending.splice(at < 0 ? pending.length : at, 0, entry);
        forward(entry);
        return;
      }
      const queuedAt = steer ? pending.findIndex(item => !item.steer && !item.forwarded) : -1;
      if (queuedAt < 0) pending.push(entry); else pending.splice(queuedAt, 0, entry);
      if (steer && current && !current.interrupted && canInterrupt(current)) {
        current.interrupted = true;
        interrupt(current);
      }
      pump();
    },
    acknowledgeForwarded(id) {
      // A result and the next acknowledgement can arrive in a single stdout chunk.
      if (!current && pending[0]?.forwarded) pump();
      const at = pending.findIndex(entry => entry.forwarded && entry.id === id);
      if (at < 0) return false;
      pending.splice(at, 1);
      return true;
    },
    // The active turn ended; let its final events flush before the next one starts.
    finish() {
      const finished = current;
      current = null;
      queueMicrotask(() => { if (pending.length) pump(); else if (!current && !stopped) onIdle?.(); });
      return finished;
    },
    // Engines that cannot interrupt (or whose interrupt was refused) keep the turn.
    keep() { if (current) current.interrupted = false; },
    get current() { return current; },
    get currentId() { return current?.id || ''; },
    get pendingCount() { return pending.length; },
    get interrupted() { return !!current?.interrupted; },
    get stopped() { return stopped; },
    stop() { stopped = true; pending.length = 0; if (current) current.interrupted = true; },
  };
}
module.exports = { createTurnQueue };
