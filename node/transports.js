// Message transports for node RPC: WebSocket frames or newline-delimited JSON
// over a pair of streams (SSH stdio, child processes).
function wsTransport(socket) {
  return {
    send: text => { if (socket.readyState === 1) socket.send(text); },
    onMessage: fn => socket.on('message', data => fn(String(data))),
    onClose: fn => { socket.on('close', fn); socket.on('error', fn); },
    close: () => socket.close(),
  };
}

function streamTransport(readable, writable, { onEnd } = {}) {
  let buffer = '';
  const messageListeners = [], closeListeners = [];
  let ended = false;
  const end = () => { if (ended) return; ended = true; for (const fn of closeListeners) fn(); };
  readable.setEncoding?.('utf8');
  readable.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) for (const fn of messageListeners) fn(line);
    }
  });
  readable.on('end', end); readable.on('close', end); readable.on('error', end);
  writable.on?.('error', end);
  return {
    send: text => { if (!ended && writable.writable !== false) writable.write(text + '\n'); },
    onMessage: fn => messageListeners.push(fn),
    onClose: fn => closeListeners.push(fn),
    close: () => { end(); onEnd?.(); },
  };
}

// Two connected in-memory transports, for tests.
function pairTransports() {
  const make = () => ({ message: [], close: [], other: null, open: true });
  const a = make(), b = make(); a.other = b; b.other = a;
  const wrap = side => ({
    send: text => { if (side.open) setImmediate(() => side.other.open && side.other.message.forEach(fn => fn(text))); },
    onMessage: fn => side.message.push(fn),
    onClose: fn => side.close.push(fn),
    close: () => { for (const s of [side, side.other]) if (s.open) { s.open = false; s.close.forEach(fn => fn()); } },
  });
  return [wrap(a), wrap(b)];
}
module.exports = { wsTransport, streamTransport, pairTransports };
