const fs = require('node:fs');
const path = require('node:path');

function createSessionPins(dir) {
  const file = path.join(dir, 'panel-session-pins.json');
  function read() {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }
  function set({ id, pinned }) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{8,100}$/.test(id) || typeof pinned !== 'boolean') throw new Error('无效的置顶请求');
    const pins = read(), exists = Object.hasOwn(pins, id);
    if (exists === pinned) return { pinnedAt: exists ? pins[id] : 0 };
    if (pinned) pins[id] = Date.now();
    else delete pins[id];
    fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(pins), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return { pinnedAt: pinned ? pins[id] : 0 };
  }
  return { read, set };
}
module.exports = { createSessionPins };
