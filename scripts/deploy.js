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
const dataDir = process.env.MY_AGENTS_HOME || path.join(os.homedir(), '.claude');
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
  const curl = `T=$(cat ${machine.home}/panel-token 2>/dev/null); curl -s -m 20 -X ${method} -H "authorization: Bearer $T" ${body ? `-H 'content-type: application/json' --data-binary @-` : ''} http://127.0.0.1:${machine.port}/api/${pathname}`;
  const out = ssh(machine.host, curl, { input: body ? JSON.stringify(body) : '' });
  try { return JSON.parse(out); } catch { throw new Error(`${machine.id} 返回无效：${out.slice(0, 200)}`); }
}
const api = (machine, ...rest) => machine.local ? localApi(...rest) : Promise.resolve().then(() => remoteApi(machine, ...rest));

async function machines() {
  const cluster = await localApi('cluster'), nodes = (await localApi('nodes')).nodes;
  const knownHosts = nodes.map(node => node.host).filter(Boolean);
  const user = knownHosts[0]?.split('@')[0] || os.userInfo().username;
  let overrides = {}; try { overrides = JSON.parse(fs.readFileSync(path.join(dataDir, 'panel-deploy.json'), 'utf8')); } catch {}
  return cluster.members.filter(member => !member.witness).map(member => {
    const local = member.id === cluster.nodeId, url = new URL(member.url);
    const node = nodes.find(item => item.id === member.id);
    return { id: member.id, label: member.label || member.id, local, port: url.port || 4321,
      host: overrides[member.id]?.host || node?.host || `${user}@${url.hostname}`,
      home: overrides[member.id]?.home || '~/.my-agents', repo: overrides[member.id]?.repo || '~/repos/my-agents' };
  });
}

async function busyTasks(machine) {
  try { return (await api(machine, 'chat/status')).running || []; } catch (error) { log(`  ${machine.label}: 无法读取任务状态（${error.message}），按忙碌处理`); return ['unknown']; }
}
async function waitIdle(machine) {
  if (force) return;
  const deadline = Date.now() + waitMinutes * 60000; let told = false;
  for (;;) {
    const busy = await busyTasks(machine);
    if (!busy.length) return;
    if (Date.now() > deadline) throw new Error(`${machine.label} 上 ${busy.length} 个任务 ${waitMinutes} 分钟内未结束，已停止部署（未重启任何正在运行的机器）。可加 --force 强制`);
    if (!told) { log(`  ${machine.label}: ${busy.length} 个任务正在运行，等待结束后再重启…`); told = true; }
    await sleep(10000);
  }
}
function update(machine, commit, bundle) {
  if (machine.local) return;
  const head = ssh(machine.host, `cd ${machine.repo} && git rev-parse HEAD`);
  if (head === commit) return;
  const pulled = ssh(machine.host, `cd ${machine.repo} && timeout 40 git pull -q --ff-only && git rev-parse HEAD`, { allowFail: true, timeout: 60000 });
  if (pulled.split('\n').pop() === commit) return;
  // GitHub may be unreachable from dev machines: ship the commits directly.
  run('git', ['bundle', 'create', bundle, `${head}..main`]);
  run('scp', ['-q', '-o', 'BatchMode=yes', bundle, `${machine.host}:/tmp/my-agents-deploy.bundle`]);
  ssh(machine.host, `cd ${machine.repo} && git fetch -q /tmp/my-agents-deploy.bundle main:refs/remotes/bundle/main && git merge -q --ff-only bundle/main; rm -f /tmp/my-agents-deploy.bundle`);
  if (ssh(machine.host, `cd ${machine.repo} && git rev-parse HEAD`) !== commit) throw new Error(`${machine.label} 代码未能更新到 ${commit.slice(0, 7)}`);
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
      const cluster = await localApi('cluster');
      const member = cluster.members.find(item => item.id === machine.id);
      if (member?.online && member.build?.gitCommit === commit && cluster.leader) return;
    } catch {}
  }
  throw new Error(`${machine.label} 重启后 3 分钟内未以新版本上线，请检查`);
}
// After a transfer the election may pick any updated node; only the old leader must be gone.
async function waitGateway(avoidLeader) {
  const deadline = Date.now() + 2 * 60000;
  while (Date.now() < deadline) {
    await sleep(3000);
    try { const view = await localApi('feishu'); if (view.cluster?.leader && view.cluster.leader !== avoidLeader && (view.bots || [view]).every(bot => bot.phase === 'connected')) return view; } catch {}
  }
  throw new Error('飞书机器人 2 分钟内未全部重新连接');
}

(async () => {
  if (run('git', ['status', '--porcelain', '--untracked-files=no']).split('\n').some(line => line && !line.endsWith('package-lock.json'))) throw new Error('有未提交的改动，请先提交');
  run('git', ['push', '-q', 'origin', 'main'], { allowFail: true, timeout: 60000 });
  const commit = run('git', ['rev-parse', 'HEAD']);
  const bundle = path.join(os.tmpdir(), `my-agents-deploy-${process.pid}.bundle`);
  const all = await machines();
  log(`部署 ${commit.slice(0, 7)} 到 ${all.map(m => m.label).join('、')}`);
  for (const machine of all) { update(machine, commit, bundle); log(`  ${machine.label}: 代码已就绪`); }
  fs.rmSync(bundle, { force: true });

  let leader = (await localApi('cluster')).leader;
  const order = [...all.filter(m => m.id !== leader), ...all.filter(m => m.id === leader)];
  for (const machine of order) {
    if (machine.id === leader) {
      const target = all.find(m => m.id !== leader);
      if (target) {
        // Tasks on every machine are driven through the leader: wait for all of them.
        for (const other of all) await waitIdle(other);
        log(`  将 IM 主节点从 ${machine.label} 移交给 ${target.label}`);
        await api(machine, 'cluster/transfer', 'POST', { target: target.id }).catch(error => log(`  移交失败（${error.message}），直接重启`));
        try { const view = await waitGateway(machine.id); leader = view.cluster.leader; log(`  ${all.find(m => m.id === leader)?.label || leader} 已接管，机器人全部在线`); } catch (error) { log('  ' + error.message); }
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
