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
    join: (...parts) => path.join(...parts),
    createWorktree: dir => require('../core/worktrees').createWorktree(dir),
    // Read-only file access for history and resource lookups on the node's disk.
    exists: file => fs.existsSync(file),
    readFile: (file, encoding = 'utf8') => fs.promises.readFile(file, encoding),
    readdir: dir => fs.promises.readdir(dir, { withFileTypes: true }).then(entries => entries.map(entry => ({ name: entry.name, dir: entry.isDirectory() }))),
  };
}
module.exports = { createLocalHost };
