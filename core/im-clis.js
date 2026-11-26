const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const prefix = path.join(os.homedir(), '.local');
const windows = process.platform === 'win32';
const bin = windows ? prefix : path.join(prefix, 'bin');
const packages = { 'lark-cli': '@larksuite/cli@1.0.100', 'wecom-cli': '@wecom/cli@1.3.4' };

// Login shells and service managers can supply different search paths.
function addIMToolsPath(env = process.env) {
  const dirs = [bin, path.join(os.homedir(), '.npm-global', 'bin')];
  if (process.platform === 'linux') dirs.push('/home/linuxbrew/.linuxbrew/bin');
  env.PATH = [...new Set([...(env.PATH || '').split(path.delimiter).filter(Boolean), ...dirs])].join(path.delimiter);
}

function install() {
  addIMToolsPath();
  const available = name => spawnSync(name, ['--version'], { stdio: 'ignore', timeout: 12000, shell: windows }).status === 0;
  const missing = Object.keys(packages).filter(name => !available(name));
  if (!missing.length) return;
  const args = ['install', '--global', '--prefix', prefix, '--no-fund', '--no-audit', ...missing.map(name => packages[name])];
  const npm = process.env.npm_execpath;
  const result = npm && /\.c?js$/i.test(npm)
    ? spawnSync(process.execPath, [npm, ...args], { stdio: 'inherit' })
    : spawnSync(windows ? 'npm.cmd' : 'npm', args, { stdio: 'inherit', shell: windows });
  if (result.status !== 0 || !missing.every(available)) throw Error('聊天工具安装失败，请检查 npm 和网络后重新运行安装。');
}

if (require.main === module) install();
module.exports = { addIMToolsPath };
