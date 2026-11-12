const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Opt-in uses Claude Code's receive policy, rather than impersonating a CLI's
// permission class. Keep an undo record for this key only, never copy credentials.
function createNativeInboxPolicy({ home, stateDir }) {
  const settingsFile = path.join(home, 'settings.json'), stateFile = path.join(stateDir, 'native-inbox-policy.json');
  function read(file) {
    try {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('配置路径不是普通文件');
      const raw = fs.readFileSync(file, 'utf8'), value = JSON.parse(raw);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置必须是 JSON 对象');
      return { raw, value };
    } catch (error) { if (error.code === 'ENOENT') return { raw: null, value: {} }; throw error; }
  }
  function write(file, value, previous) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // Do not replace settings another process changed since the read.
    if (previous !== undefined && read(file).raw !== previous) throw new Error('Claude Code 配置正在更新，请稍后重试');
    const temporary = file + '.' + crypto.randomUUID() + '.tmp';
    try { fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file); }
    finally { try { fs.unlinkSync(temporary); } catch {} }
  }
  return {
    set(enabled) {
      const saved = read(stateFile).value;
      if (!enabled && !saved.owned) return;
      const current = read(settingsFile), value = current.value;
      if (enabled) {
        if (value.crossSessionInbound === 'accept') return;
        if (saved.owned) throw new Error('跨会话接收策略已被手动修改，保留该设置；请关闭再开启自动接收');
        if (value.crossSessionInbound !== undefined && !['hold', 'refuse'].includes(value.crossSessionInbound)) throw new Error('crossSessionInbound 配置无效，未覆盖');
        write(stateFile, { owned: true, settingsFile, hadValue: Object.hasOwn(value, 'crossSessionInbound'), ...(Object.hasOwn(value, 'crossSessionInbound') ? { previous: value.crossSessionInbound } : {}) });
        try { write(settingsFile, { ...value, crossSessionInbound: 'accept' }, current.raw); }
        catch (error) { fs.unlinkSync(stateFile); throw error; }
      } else {
        if (saved.settingsFile !== settingsFile) throw new Error('Claude Code 配置目录已变化，未还原其他目录的设置');
        if (value.crossSessionInbound === 'accept') {
          if (saved.hadValue) value.crossSessionInbound = saved.previous; else delete value.crossSessionInbound;
          write(settingsFile, value, current.raw);
        }
        fs.unlinkSync(stateFile);
      }
    },
    status() {
      try { return { accepting: read(settingsFile).value.crossSessionInbound === 'accept', managedByPanel: !!read(stateFile).value.owned }; }
      catch { return { accepting: false, error: 'Claude Code 接收策略配置无法读取' }; }
    },
  };
}
module.exports = { createNativeInboxPolicy };
