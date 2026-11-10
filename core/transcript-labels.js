const fs = require('fs');
const cache = new Map();
function transcriptLabels(file) {
  try {
    const st = fs.statSync(file), key = st.mtimeMs + ':' + st.size, hit = cache.get(file);
    if (hit?.key === key) return hit.value;
    const fd = fs.openSync(file, 'r'); let text;
    try {
      const read = (offset, size) => { const b = Buffer.alloc(size); const n = fs.readSync(fd, b, 0, size, offset); return b.toString('utf8', 0, n); };
      text = st.size <= 320 * 1024 ? read(0, st.size) : read(0, 64 * 1024) + '\n' + read(st.size - 256 * 1024, 256 * 1024).split('\n').slice(1).join('\n');
    } finally { fs.closeSync(fd); }
    const value = {};
    for (const line of text.split('\n')) {
      let row; try { row = JSON.parse(line); } catch { continue; }
      if (row.isSidechain) continue;
      if (row.cwd) value.cwd = row.cwd;
      if (row.gitBranch && row.gitBranch !== 'HEAD') value.gitBranch = row.gitBranch;
      if (row.type === 'custom-title' && row.customTitle) value.sessionName = row.customTitle;
      if (row.type === 'agent-name' && row.agentName) value.sessionName = row.agentName;
    }
    cache.set(file, { key, value }); if (cache.size > 1000) cache.delete(cache.keys().next().value);
    return value;
  } catch { return {}; }
}
module.exports = { transcriptLabels };
