const fs = require('fs');
const path = require('path');
const { titleText } = require('./conversation-state');
const normalizeTitle = text => titleText(text).slice(0, 80);
function isManualTitle(meta = {}, firstTitle = '') {
  if (meta.titleSource) return meta.titleSource === 'manual';
  if (!meta.title) return false;
  if (!meta.createdAt) return true;
  const original = firstTitle || meta.initialPrompt;
  return !!original && normalizeTitle(meta.title) !== normalizeTitle(original) && normalizeTitle(meta.title) !== normalizeTitle(meta.initialPrompt);
}
function autoTitlePatch(meta, prompt, firstTitle = '') {
  const title = normalizeTitle(prompt) || '图片对话';
  return { autoTitle: title, autoTitleAt: Date.now(), ...(isManualTitle(meta, firstTitle) ? { titleSource: 'manual' } : { title, titleSource: 'auto' }) };
}

function createSessionStore(dir) {
  const file = path.join(dir, 'panel-sessions.json');
  const read = () => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  function update(id, patch) {
    if (!/^[a-zA-Z0-9-]{8,100}$/.test(id)) throw new Error('无效的会话 ID');
    const records = read();
    records[id] = { ...records[id], ...patch };
    fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(records, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return records[id];
  }
  return { read, update };
}
module.exports = { createSessionStore, normalizeTitle, isManualTitle, autoTitlePatch };
