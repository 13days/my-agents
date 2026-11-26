const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

function createCaptureSegments(file, {segmentBytes = 64 * 1024 ** 2, maxBytes = 512 * 1024 ** 2} = {}) {
  if (!(segmentBytes > 0 && maxBytes >= segmentBytes)) throw new Error('抓包容量配置无效');
  const dir = file + '.segments';
  let active, archives;
  const part = (name, legacy = false) => ({file:name, bytes:fs.statSync(name, {throwIfNoEntry:false})?.size || 0, legacy});
  function rotate(legacy = false) {
    fs.mkdirSync(dir, {recursive:true, mode:0o700});
    const name = path.join(dir, legacy ? 'legacy.jsonl' : Date.now() + '-' + randomUUID() + '.jsonl');
    fs.renameSync(file, name);
    active.file = name;
    active.legacy = legacy;
    archives.push(active);
    active = part(file);
  }
  function init() {
    if (active) return;
    const existing = fs.existsSync(dir);
    archives = (existing ? fs.readdirSync(dir) : []).filter(name => /^(?:legacy|\d+-[\da-f-]+)\.jsonl$/.test(name)).sort()
      .map(name => part(path.join(dir,name), name === 'legacy.jsonl'));
    active = part(file);
    if (!existing && active.bytes > segmentBytes) rotate(true);
  }
  function remove(old, onRemove) {
    fs.unlinkSync(old.file);
    archives.splice(archives.indexOf(old), 1);
    onRemove(old);
    if (old.legacy) fs.rmSync(old.file + '.index', {force:true});
  }
  function reserve(bytes, onRemove) {
    init();
    if (active.bytes && active.bytes + bytes > segmentBytes) rotate();
    let usage = active.bytes + bytes + archives.reduce((n, p) => n + (p.legacy ? 0 : p.bytes), 0);
    for (const old of [...archives]) {
      if (usage <= maxBytes) break;
      if (old.legacy) continue;
      remove(old, onRemove);
      usage -= old.bytes;
    }
    return active;
  }
  function clear(onRemove) {
    init();
    for (const old of [...archives]) remove(old, onRemove);
    fs.writeFileSync(file, '', {mode:0o600});
    onRemove(active); active = part(file);
  }
  return {
    snapshots() { init(); return [active, ...archives.slice().reverse().sort((a,b)=>Number(a.legacy)-Number(b.legacy))].filter(p=>p.bytes); },
    reserve, clear,
    clearLegacy(onRemove) {
      init();
      const old = archives.find(p=>p.legacy);
      if (old) remove(old, onRemove);
    },
    status() {
      init();
      return {activeBytes:active.bytes, retainedBytes:active.bytes+archives.reduce((n,p)=>n+(p.legacy?0:p.bytes),0),
        legacyBytes:archives.find(p=>p.legacy)?.bytes || 0, segments:archives.length, maxBytes, segmentBytes};
    },
  };
}
module.exports = {createCaptureSegments};
