#!/usr/bin/env node
// Rolling deploy of the current `main` to every cluster machine without interrupting work:
//   - a machine is restarted only when it has no running panel task (wait up to --wait minutes);
//   - followers first, the IM leader last, after moving leadership to an updated node so the
//     Feishu gateway is already connected elsewhere before the old leader goes down;
//   - each restart is confirmed by the cluster reporting the node online on the new commit.
// Usage: node scripts/deploy.js [--wait 60] [--force]
const { spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const args = process.argv.slice(2);
const force = args.includes('--force');
const waitMinutes = Number(args[args.indexOf('--wait') + 1]) > 0 && args.includes('--wait') ? Number(args[args.indexOf('--wait') + 1]) : 60;
const repo = path.resolve(__dirname, '..');
const dataDir = require('../core/data-dir').resolveDataDir().dir;
const port = process.env.PORT || 4321;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = (...parts) => console.log(new Date().toLocaleTimeString(), ...parts);

function run(cmd, cmdArgs, { input, timeout = 120000, allowFail = false } = {}) {
  const result = spawnSync(cmd, cmdArgs, { cwd: repo, encoding: 'utf8', input: input ?? '', timeout, maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0 && !allowFail) throw new Error(`${cmd} ${cmdArgs.slice(0, 3).join(' ')} 失败：${(result.stderr || result.stdout || '').trim().slice(-400)}`);
  return (result.stdout || '').trim();
}
const ssh = (host, script, opts) => run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, script], opts);
const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";

async function localApi(pathname, method = 'GET', body, attempt = 0) {
  let response;
  try { response = await fetch(`http://127.0.0.1:${port}/api/${pathname}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) }); }
  catch (error) { if (attempt < 4 && method === 'GET') { await sleep(3000); return localApi(pathname, method, body, attempt + 1); } throw error; }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'HTTP ' + response.status);
  return data;
}
// Remote panels are reached on their own loopback, so no token leaves the machine.
function remoteApi(machine, pathname, method = 'GET', body) {
  const curl = `T=$(cat ${machine.home}/panel-token 2>/dev/null); curl -fsS -m 20 -X ${method} -H "authorization: Bearer $T" ${body ? `-H 'content-type: application/json' --data-binary @-` : ''} http://127.0.0.1:${machine.port}/api/${pathname}`;
  const out = ssh(machine.host, curl, { input: body ? JSON.stringify(body) : '' });
  try { return JSON.parse(out); } catch { throw new Error(`${machine.id} 返回无效：${out.slice(0, 200)}`); }
}
const api = (machine, ...rest) => machine.local ? localApi(...rest) : Promise.resolve().then(() => remoteApi(machine, ...rest));

async function machines() {
  const cluster = await localApi('cluster'), nodes = (await localApi('nodes')).nodes;
  let overrides = {}; try { overrides = JSON.parse(fs.readFileSync(path.join(dataDir, 'panel-deploy.json'), 'utf8')); } catch {}
  return cluster.members.filter(member => !member.witness).map(member => {
    const local = member.id === cluster.nodeId, url = new URL(member.url);
    const node = nodes.find(item => item.id === member.id);
    const host = overrides[member.id]?.host || node?.ssh || node?.host;
    if (!local && typeof host !== 'string') throw Error(`${member.id} 未配置部署 SSH 地址`);
    return { id: member.id, label: member.label || member.id, local, port: url.port || 4321,
      host,
      home: overrides[member.id]?.home || '~/.my-agents', repo: local ? repo : overrides[member.id]?.repo || ssh(host, 'systemctl --user show my-agents-panel.service -p WorkingDirectory --value') };
  });
}

async function busyTasks(machine) {
  try {
    const health = await api(machine, 'health');
    if (health?.ready !== true || !['running','preparing','executing'].every(key => Number.isSafeInteger(health.tasks?.[key]) && health.tasks[key] >= 0)) throw Error('任务计数缺失或无效');
    return Object.keys(health.tasks).filter(key => health.tasks[key] > 0);
  } catch (error) { log(`  ${machine.label}: 无法读取任务状态（${error.message}），按忙碌处理`); return ['unknown']; }
}
async function waitIdle(machine) {
  if (force) return;
  const deadline = Date.now() + waitMinutes * 60000; let told = false;
  for (;;) {
    const busy = await busyTasks(machine);
    if (!busy.length) return;
    if (Date.now() > deadline) throw new Error(`${machine.label} 上 ${busy.length} 类任务 ${waitMinutes} 分钟内未结束，已停止部署（未重启任何正在运行的机器）。可加 --force 强制`);
    if (!told) { log(`  ${machine.label}: ${busy.length} 类任务正在运行，等待结束后再重启…`); told = true; }
    await sleep(10000);
  }
}
function update(machine, commit, bundle) {
  if (machine.local) return;
  if (!machine.repo || !machine.repo.startsWith('/')) throw new Error(`${machine.label} 未发现服务实际工作目录，请配置 panel-deploy.json`);
  const remoteRepo = quote(machine.repo);
  const remoteOrigin = ssh(machine.host, `cd ${remoteRepo} && git remote get-url origin`);
  if (remoteOrigin !== run('git', ['remote', 'get-url', 'origin'])) throw new Error(`${machine.label} 仓库地址不一致，已停止`);
  const dirty = ssh(machine.host, `cd ${remoteRepo} && git status --porcelain`);
  if (dirty && dirty !== 'M package-lock.json') throw new Error(`${machine.label} 工作区有未提交改动，已停止`);
  if (ssh(machine.host, `cd ${remoteRepo} && git symbolic-ref --short HEAD`) !== 'main') throw Error(`${machine.label} 尚未检出 main`);
  const head = ssh(machine.host, `cd ${remoteRepo} && git rev-parse HEAD`);
  if (head === commit) return;
  if (dirty && run('git',['diff','--name-only',head,commit,'--','package-lock.json'])) throw Error(`${machine.label} 锁文件有改动，与新版本重叠`);
  // Ship the exact verified commit, including when the node cannot reach origin.
  const remoteBundle = '/tmp/' + path.basename(bundle);
  run('git', ['bundle', 'create', bundle, `${head}..main`]);
  run('scp', ['-q', '-o', 'BatchMode=yes', bundle, `${machine.host}:${remoteBundle}`]);
  try {
    ssh(machine.host, `cd ${remoteRepo} && git fetch -q ${quote(remoteBundle)} main && git merge -q --ff-only --no-overwrite-ignore FETCH_HEAD`);
  } finally { ssh(machine.host, `rm -f ${quote(remoteBundle)}`); }
  if (ssh(machine.host, `cd ${remoteRepo} && git rev-parse HEAD`) !== commit) throw new Error(`${machine.label} 代码未能更新到 ${commit.slice(0, 7)}`);
}
function restart(machine) {
  if (machine.local) run('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/io.my-agents.gateway`]);
  else ssh(machine.host, 'systemctl --user restart my-agents-panel.service');
}
async function waitHealthy(machine, commit) {
  const deadline = Date.now() + 3 * 60000;
  while (Date.now() < deadline) {
    await sleep(3000);
    try {
      // Ask the restarted machine itself: the leader's view of a peer's build can lag behind.
      const health = await api(machine, 'health');
      const cluster = await localApi('cluster');
      const member = cluster.members.find(item => item.id === machine.id);
      if (health?.ready && health.build?.gitCommit === commit && member?.online && cluster.leader) return;
    } catch {}
  }
  throw new Error(`${machine.label} 重启后 3 分钟内未以新版本上线，请检查`);
}
// After a transfer the election may pick any updated node; only the old leader must be gone.
async function waitGateway(avoidLeader) {
  const deadline = Date.now() + 2 * 60000; let last = '';
  while (Date.now() < deadline) {
    await sleep(3000);
    try {
      const view = await localApi('feishu');
      last = `主节点=${view.cluster?.leader || '无'} 机器人=${(view.bots || [view]).map(bot => (bot.appId || '').slice(-6) + ':' + bot.phase).join(',')}${view.lastError ? ' 错误=' + view.lastError : ''}`;
      if (view.cluster?.leader && view.cluster.leader !== avoidLeader && (view.bots || [view]).filter(bot => bot.enabled !== false).every(bot => bot.phase === 'connected')) return view;
    } catch (error) { last = '面板接口：' + error.message; }
  }
  // Say what was actually seen, so a slow election is not mistaken for disconnected bots.
  throw new Error('2 分钟内未确认移交完成（最后状态：' + (last || '未知') + '）');
}

(async () => {
  if (run('git', ['status', '--porcelain', '--untracked-files=no']).split('\n').some(line => line && !line.endsWith('package-lock.json'))) throw new Error('有未提交的改动，请先提交');
  if (run('git', ['rev-parse', 'HEAD']) !== run('git', ['rev-parse', 'main'])) throw new Error('当前检出不是 main 最新提交，已停止部署');
  run('git', ['push', '-q', 'origin', 'main'], { timeout: 60000 });
  const commit = run('git', ['rev-parse', 'HEAD']);
  const bundle = path.join(os.tmpdir(), `my-agents-deploy-${process.pid}.bundle`);
  const all = await machines();
  log(`部署 ${commit.slice(0, 7)} 到 ${all.map(m => m.label).join('、')}`);
  try {
    for (const machine of all) { await waitIdle(machine); update(machine, commit, bundle); log(`  ${machine.label}: 代码已就绪`); }
  } finally { fs.rmSync(bundle, { force: true }); }

  let leader = (await localApi('cluster')).leader;
  const order = [...all.filter(m => m.id !== leader), ...all.filter(m => m.id === leader)];
  for (const machine of order) {
    if (machine.id === leader) {
      const target = all.find(m => m.id !== leader);
      if (target) {
        // A freshly restarted panel does heavy startup work; let it settle before it takes the IM gateway.
        await sleep(45000);
        // Tasks on every machine are driven through the leader: wait for all of them.
        for (const other of all) await waitIdle(other);
        log(`  将 IM 主节点从 ${machine.label} 移交给 ${target.label}`);
        await api(machine, 'cluster/transfer', 'POST', { target: target.id });
        const view = await waitGateway(machine.id); leader = view.cluster.leader; log(`  ${all.find(m => m.id === leader)?.label || leader} 已接管，机器人全部在线`);
      }
    }
    await waitIdle(machine);
    log(`  重启 ${machine.label}…`);
    restart(machine);
    await waitHealthy(machine, commit);
    log(`  ${machine.label}: 已以 ${commit.slice(0, 7)} 上线`);
  }
  const view = await waitGateway();
  log(`完成。IM 主节点：${view.cluster?.leader}；机器人：${(view.bots || []).map(b => b.appId.slice(-6) + ' ' + b.phase).join('，')}`);
})().catch(error => { console.error('部署中止：' + error.message); process.exit(1); });
