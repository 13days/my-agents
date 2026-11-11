const fs = require('fs');
// A gap between HTTP requests can be a local tool execution, not an idle turn.
// Inspect only a bounded tail; no transcript or tool output leaves this machine.
function nativeTurnBusy(file) {
  if (!file) return false;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, length = Math.min(size, 512 * 1024), start = size - length;
    const buffer = Buffer.alloc(length); fs.readSync(fd, buffer, 0, length, start);
    const lines = buffer.toString('utf8').split('\n'); if (start) lines.shift();
    for (let i = lines.length - 1; i >= 0; i--) {
      let row; try { row = JSON.parse(lines[i]); } catch { continue; }
      if (row.isSidechain) continue;
      if (row.type === 'result') return false;
      if (!['assistant', 'user'].includes(row.type)) continue;
      if (row.type === 'user') return true;
      const message = row.message || {};
      if (['end_turn', 'stop_sequence'].includes(message.stop_reason)) return false;
      return (message.content || []).some(block => block.type === 'tool_use') || message.stop_reason === 'tool_use';
    }
    return size > 0;
  } catch { return false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
module.exports = { nativeTurnBusy };
