const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// The machine an engine runs on. Engines only start processes and resolve
// working directories through their host, so the same adapter code runs
// in-process (local) or inside a remote `my-agents node`.
function createLocalHost({ id = 'local', label = '本机' } = {}) {
  return {
    id,
    label,
    platform: process.platform,
    homeDir: () => os.homedir(),
    tmpDir: () => os.tmpdir(),
    spawn: (cmd, args, { cwd, env } = {}) => spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }),
    // Resolves a working directory; throws a user-facing error when unusable.
    resolveDir(dir) {
      let real;
      // `~/…` comes from chat input (e.g. Feishu /node devbox ~/repos/x); expand it on the machine that runs the CLI.
      const input = typeof dir === 'string' && dir.trim() ? dir.trim().replace(/^~(?=$|\/)/, os.homedir()) : process.cwd();
      try { real = fs.realpathSync(input); }
      catch { throw Object.assign(new Error('工作目录不存在'), { status: 400 }); }
      if (!fs.statSync(real).isDirectory()) throw Object.assign(new Error('工作目录必须是文件夹'), { status: 400 });
      return real;
    },
    async listDirectories({ dir = '~', hidden = false, offset = 0 }) {
      if (typeof dir !== 'string' || dir.length > 4096 || /[\0\r\n]/.test(dir) || !(dir === '~' || dir.startsWith('~/') || path.isAbsolute(dir))) throw new Error('请输入这台电脑上的绝对目录或 ~/ 路径');
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('目录页码无效');
      const cwd = this.resolveDir(dir);
      const entries = await fs.promises.readdir(cwd, { withFileTypes: true });
      const names = [];
      for (const entry of entries) {
        if (!hidden && entry.name.startsWith('.')) continue;
        if (entry.isDirectory() || (entry.isSymbolicLink() && await fs.promises.stat(path.join(cwd, entry.name)).then(stat => stat.isDirectory(), () => false))) names.push(entry.name);
      }
      names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      const end = offset + 150;
      return { cwd, parent: path.dirname(cwd), directories: names.slice(offset, end).map(name => ({ name, path: path.join(cwd, name) })), nextOffset: end < names.length ? end : null };
    },
    join: (...parts) => path.join(...parts),
    createWorktree: (dir, options) => require('../core/worktrees').createWorktree(dir, options),
    // Read-only file access for history and resource lookups on the node's disk.
    exists: file => fs.existsSync(file),
    readFile: (file, encoding = 'utf8') => fs.promises.readFile(file, encoding),
    readdir: dir => fs.promises.readdir(dir, { withFileTypes: true }).then(entries => entries.map(entry => ({ name: entry.name, dir: entry.isDirectory() }))),
  };
}
module.exports = { createLocalHost };
