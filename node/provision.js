// "Add a machine" in one step: given only an SSH target, check the remote, install my-agents
// there when it is missing (shipping this panel's own code, so versions match), and return the
// command the hub should launch over SSH. Everything runs through the user's login shell so
// nvm/nodenv/Homebrew PATHs apply.
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const REMOTE_DIR = '~/repos/my-agents';
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
    if (input) { input.pipe(child.stdin); input.on('error', () => child.stdin.destroy()); }
  });
}
const ssh = (target, script, options) => run('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', target, loginShell(script)], options);

async function inspect(target) {
  let out;
  const probe = ['node', 'my-agents', 'git', 'claude', 'codex'].map(name => `command -v ${name} >/dev/null 2>&1 && echo @@${name}=1`).join('; ');
  try { out = await ssh(target, `${probe}; echo @@nodeVersion=$(node -v 2>/dev/null); [ -f ${REMOTE_DIR}/server.js ] && echo @@repo=1; echo @@hostname=$(hostname)`); }
  catch (error) {
    if (/Permission denied|publickey|gssapi/i.test(error.message)) throw new Error(`无法免密登录 ${target}：请先在本机终端执行 ssh ${target} 确认能直接登录（不输密码），再重试`);
    if (/Could not resolve|No route|timed out|Connection refused/i.test(error.message)) throw new Error(`连不上 ${target}：${error.message}`);
    throw new Error(`检查 ${target} 失败：${error.message}`);
  }
  const v = Object.fromEntries([...out.matchAll(/^@@([\w-]+)=(.*)$/gm)].map(m => [m[1], m[2].trim()]));
  const nodeVersion = /^v\d+\./.test(v.nodeVersion || '') ? v.nodeVersion : '';
  return { node: !!v.node && !!nodeVersion, nodeVersion, hostname: v.hostname || '', command: !!v['my-agents'], repo: !!v.repo, git: !!v.git, claude: !!v.claude, codex: !!v.codex };
}

async function install(target, { repoDir, hasGit, step, remoteDir = REMOTE_DIR }) {
  const local = fs.existsSync(path.join(repoDir, '.git'));
  if (local && hasGit) {
    // A git clone keeps later deploys (git pull / bundles) working on the new machine.
    const bundle = path.join(os.tmpdir(), `my-agents-provision-${process.pid}-${Date.now()}.bundle`);
    try {
      step('打包当前版本');
      await run('git', ['-C', repoDir, 'bundle', 'create', bundle, 'HEAD', 'main'], { timeout: 120000 }).catch(() => run('git', ['-C', repoDir, 'bundle', 'create', bundle, 'HEAD'], { timeout: 120000 }));
      step('上传到远端');
      await run('scp', ['-q', '-o', 'BatchMode=yes', bundle, `${target}:/tmp/my-agents-provision.bundle`], { timeout: 300000 });
      step('在远端安装');
      await ssh(target, `set -e; mkdir -p ~/repos; git clone -q /tmp/my-agents-provision.bundle ${remoteDir}; rm -f /tmp/my-agents-provision.bundle; cd ${remoteDir}; git remote set-url origin ${quote(await run('git', ['-C', repoDir, 'remote', 'get-url', 'origin']).then(s => s.trim()).catch(() => ''))} 2>/dev/null || true; npm ci --omit=dev --no-audit --no-fund --loglevel=error`, { timeout: 600000 });
    } finally { fs.rmSync(bundle, { force: true }); }
    return;
  }
  step('上传到远端');
  const tar = spawn('tar', ['-C', repoDir, '-czf', '-', '--exclude=./node_modules', '--exclude=./.git', '--exclude=./.claude', '.'], { stdio: ['ignore', 'pipe', 'ignore'] });
  await ssh(target, `set -e; mkdir -p ${remoteDir}; tar -xzf - -C ${remoteDir}; cd ${remoteDir}; npm ci --omit=dev --no-audit --no-fund --loglevel=error`, { input: tar.stdout, timeout: 600000 });
}

async function provisionMachine({ ssh: target, repoDir = path.resolve(__dirname, '..'), step = () => {} }) {
  step('检查远端环境');
  const found = await inspect(target);
  if (!found.node) throw new Error(`${target} 上没有 Node.js。请先在那台机器安装 Node.js 18 或更高版本（例如 nvm install --lts），再重试`);
  if (Number(found.nodeVersion.slice(1).split('.')[0]) < 18) throw new Error(`${target} 上的 Node.js ${found.nodeVersion} 太旧，需要 18 或更高版本`);
  let command = found.command ? 'my-agents node --stdio' : `node ${REMOTE_DIR}/server.js node --stdio`, installed = false;
  if (!found.command && !found.repo) { await install(target, { repoDir, hasGit: found.git, step }); installed = true; }
  const engines = [found.claude && 'Claude Code', found.codex && 'Codex'].filter(Boolean);
  return { command, installed, hostname: found.hostname, engines,
    warning: engines.length ? '' : '这台机器还没装 Claude Code 或 Codex CLI，接入后需要先安装其中一个才能执行任务' };
}

// A short readable node id from the SSH target or hostname, unique among existing ids.
function machineId(target, hostname, taken = []) {
  const base = (String(target).split('@').pop().split(':')[0].match(/^\d+(\.\d+){3}$/) ? hostname : String(target).split('@').pop()).split('.')[0].toLowerCase().replace(/[^\w-]/g, '-').slice(0, 40) || 'machine';
  let id = base, n = 2;
  while (taken.includes(id) || id === 'local') id = `${base}-${n++}`;
  return id;
}

module.exports = { provisionMachine, machineId, inspect, install };
