// "Add a machine" in one step: given only an SSH target, check the remote, install my-agents
// there when it is missing (shipping this panel's own code, so versions match), and return the
// command the hub should launch over SSH. Everything runs through the user's login shell so
// nvm/nodenv/Homebrew PATHs apply.
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const REMOTE_DIR = '"$HOME/repos/my-agents"';
const PANEL_SOURCE = '"$HOME/.local/share/my-agents/source"';
const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
// Same shell setup as SSH nodes (node/hub.js): interactive login shell, so PATH from .zshrc/.bashrc
// applies; stdin is parked on fd 3 while the profile runs. Output is read only from marked lines.
const loginShell = script => `exec "\${SHELL:-/bin/sh}" -ilc ${quote('exec 0<&3 3<&-; ' + script)} 3<&0 </dev/null`;

function run(cmd, args, { input, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${cmd} 超时（${Math.round(timeout / 1000)} 秒）`)); }, timeout);
    child.stdout.on('data', c => { out += c; }); child.stderr.on('data', c => { err += c; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(Object.assign(new Error((err || out).trim().split('\n').slice(-3).join(' ') || `${cmd} 退出码 ${code}`), { code })); });
    if (input) { child.stdin.on('error', () => {}); input.pipe(child.stdin); input.on('error', () => child.stdin.destroy()); }
  });
}
const ssh = (target, script, options) => run('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', target, loginShell(script)], options);

async function inspect(target) {
  let out;
  const probe = ['node', 'my-agents', 'git', 'claude', 'codex'].map(name => `command -v ${name} >/dev/null 2>&1 && echo @@${name}=1`).join('; ');
  try { out = await ssh(target, `${probe}; echo @@nodeVersion=$(node -v 2>/dev/null); [ -f ${PANEL_SOURCE}/server.js ] && echo @@panelSource=1; [ -f ${REMOTE_DIR}/server.js ] && echo @@repo=1; echo @@hostname=$(hostname)`); }
  catch (error) {
    if (/Permission denied|publickey|gssapi/i.test(error.message)) throw new Error(`无法免密登录 ${target}：请先在本机终端执行 ssh ${target} 确认能直接登录（不输密码），再重试`);
    if (/Could not resolve|No route|timed out|Connection refused/i.test(error.message)) throw new Error(`连不上 ${target}：${error.message}`);
    throw new Error(`检查 ${target} 失败：${error.message}`);
  }
  const v = Object.fromEntries([...out.matchAll(/^@@([\w-]+)=(.*)$/gm)].map(m => [m[1], m[2].trim()]));
  const nodeVersion = /^v\d+\./.test(v.nodeVersion || '') ? v.nodeVersion : '';
  return { node: !!v.node && !!nodeVersion, nodeVersion, hostname: v.hostname || '', command: !!v['my-agents'], repo: !!v.repo, panelSource: !!v.panelSource, git: !!v.git, claude: !!v.claude, codex: !!v.codex };
}

async function install(target, { repoDir, hasGit, step, runtimePath }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'my-agents-provision-'));
  try {
    const bundle = hasGit && fs.existsSync(path.join(repoDir, '.git'));
    let archive, unpack;
    if (bundle) {
      step('打包当前提交');
      archive = path.join(tmp, 'source.bundle');
      await run('git', ['-C', repoDir, 'bundle', 'create', archive, 'HEAD'], { timeout: 120000 });
      unpack = 'cat > "$stage/source.bundle"; git init -q "$stage/src"; git -C "$stage/src" fetch -q "$stage/source.bundle" HEAD; git -C "$stage/src" checkout -q -B main FETCH_HEAD; git -C "$stage/src" remote add origin https://github.com/13days/my-agents.git';
    } else {
      step('打包运行所需文件');
      const packed = JSON.parse(await run('npm', ['pack', repoDir, '--json', '--ignore-scripts', '--pack-destination', tmp]));
      archive = path.join(tmp, packed[0].filename);
      unpack = 'mkdir "$stage/src"; tar -xzf - --strip-components=1 -C "$stage/src"';
    }
    step('安装并验证远端程序');
    // Stage on the destination filesystem. A failed download or npm install leaves no
    // half-installed checkout for the next attempt, and rename cannot merge two trees.
    const script = `set -eu; ${runtimePath}; umask 077; mkdir -p "$HOME/repos"; dest=${REMOTE_DIR};
      [ ! -e "$dest" ] || { echo "安装目录已存在，请检查 $dest" >&2; exit 1; };
      stage=$(mktemp -d "$HOME/repos/.my-agents.XXXXXX"); trap 'rm -rf "$stage"' EXIT;
      ${unpack}; cd "$stage/src"; npm install --omit=dev --no-package-lock --no-audit --no-fund --loglevel=error;
      node -e 'require("ws")'; node server.js node --help >/dev/null;
      node -e 'require("fs").renameSync(process.cwd(), process.argv[1])' "$dest"`;
    await ssh(target, `sh -c ${quote(script)}`, { input: fs.createReadStream(archive), timeout: 600000 });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

async function provisionMachine({ ssh: target, repoDir = path.resolve(__dirname, '..'), step = () => {} }) {
  step('检查远端环境');
  const found = await inspect(target);
  // Run the same runtime check as a first-time local install. SSH profiles can print
  // a greeting, so take only the marked path from the bootstrap's stdout.
  const bootstrap = fs.createReadStream(path.join(__dirname, '../scripts/ensure-node.sh'));
  const result = await ssh(target, 'bin=$(sh -s) && printf "@@bin=%s\\n" "$bin"', { input: bootstrap, timeout: 300000 });
  const bin = result.match(/^@@bin=(\/[^\r\n]+)$/m)?.[1];
  if (!bin) throw new Error('无法定位远端 Node.js，请检查登录环境后重试');
  const runtimePath = `export PATH=${quote(bin)}:"$PATH"`;
  const source = found.panelSource ? PANEL_SOURCE : REMOTE_DIR;
  const existingCommand = found.command && !found.repo && !found.panelSource;
  const server = existingCommand ? 'my-agents' : `node ${source}/server.js`;
  const installed = !existingCommand && !found.repo && !found.panelSource;
  if (installed) await install(target, { repoDir, hasGit: found.git, step, runtimePath });
  else {
    const repair = existingCommand ? '' : `cd ${source}; node -e 'if (require("./package.json").name !== "my-agents") process.exit(1)';
      node -e 'require("ws")' 2>/dev/null || npm install --omit=dev --no-package-lock --no-audit --no-fund;`;
    await ssh(target, `set -e; ${runtimePath}; ${repair} ${server} node --help`, { timeout: 600000 });
  }
  const engines = [found.claude && 'Claude Code', found.codex && 'Codex'].filter(Boolean);
  return { command: `${runtimePath}; exec ${server} node --stdio`, installed, hostname: found.hostname, engines,
    warning: engines.length ? '' : '设备已接入。运行任务前，请在这台机器安装 Codex 或 Claude Code 并完成登录。' };
}

// A short readable node id from the SSH target or hostname, unique among existing ids.
function machineId(target, hostname, taken = []) {
  const base = (String(target).split('@').pop().split(':')[0].match(/^\d+(\.\d+){3}$/) ? hostname : String(target).split('@').pop()).split('.')[0].toLowerCase().replace(/[^\w-]/g, '-').slice(0, 40) || 'machine';
  let id = base, n = 2;
  while (taken.includes(id) || id === 'local') id = `${base}-${n++}`;
  return id;
}

// Sharing one in-flight install also makes a retry after a browser timeout safe.
function createMachineProvisioner({ hub, reservedIds, provision = provisionMachine }) {
  const pending = new Map();
  return async (target, label) => {
    if (pending.has(target)) return pending.get(target);
    const task = (async () => {
      const existing = hub.list().find(node => node.ssh === target);
      if (existing) return { node: existing, existing: true };
      const result = await provision({ ssh: target });
      const taken = [...reservedIds(), ...hub.list().map(node => node.id)];
      const id = machineId(label || target, result.hostname, taken);
      const node = hub.add({ id, label: label || id, ssh: target, command: result.command });
      await hub.ensure(id, 4000);
      const status = hub.list().find(item => item.id === id) || node;
      return { ...result, node: status };
    })();
    pending.set(target, task);
    try { return await task; } finally { pending.delete(target); }
  };
}

module.exports = { createMachineProvisioner, provisionMachine, machineId, inspect, install };
