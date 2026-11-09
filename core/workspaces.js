const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ID = /^[\w.-]{1,64}$/;
const fail = message => Object.assign(new Error(message), { status: 400 });

// Paths belong to execution machines; "local" is only a runtime alias.
function createWorkspaces({ dir, selfId, machines, hostFor, leaderId = () => '' }) {
  const file = path.join(dir, 'panel-workspaces.json');
  function read() {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw fail('工作区配置损坏，请从备份恢复'); return { defaults: {}, projects: [] }; }
  }
  const machine = id => !id || id === 'local' ? selfId() : id;
  function resolve(input = {}, owner = null) {
    const original = machine(owner ? owner.machineId || owner.node || 'local' : input.machineId || input.node);
    const manual = input.switchMachine === true;
    const available = machines();
    let id = manual ? machine(input.machineId || input.node) : original;
    const offline = available.find(item => item.id === id)?.online === false;
    if (offline && !manual && input.allowFailover !== false) id = leaderId() || id;
    if (!available.some(item => item.id === id)) throw fail(`执行机器 ${id} 不在当前配置中，请重新选择执行机器`);
    if (available.find(item => item.id === id)?.online === false) throw fail(`执行机器 ${id} 离线，且没有可用的接管机器`);
    const moved = id !== original || manual;
    const config = read(), sourcePath = owner?.worktree?.repository || owner?.project || input.cwd;
    const inferred = config.projects.find(item => item.paths[original] === sourcePath);
    const manualProject = manual && input.cwd ? config.projects.find(item => item.paths[id] === input.cwd) : null;
    const project = input.workspaceId ? config.projects.find(item => item.id === input.workspaceId) : manual ? manualProject : moved ? inferred : null;
    if (input.workspaceId && !project) throw fail('项目工作区不存在，请重新选择');
    if (moved && !project && !(manual && input.cwd) && sourcePath && sourcePath !== hostFor(original)?.homeDir()) throw fail(`已选择接管机器 ${id}，但原项目尚未配置目录映射；请在「项目与目录」补充映射，或手动选择目标机器的项目`);
    if (moved && !manual && owner?.worktree) throw fail(`已选择接管机器 ${id}，但原独立工作区的未提交改动尚不能确认已同步。请手动选择目标机器的项目接续，或等待原机器恢复；不会自动重跑原任务`);
    const sameWorkspace = manual && id === original && input.cwd === owner?.project && (!input.workspaceId || project?.paths[id] === owner?.worktree?.repository);
    const cwd = (!moved || sameWorkspace) && owner?.project || (project ? project.paths[id] : manual ? input.cwd : moved ? '' : input.cwd) || config.defaults[id] || hostFor(id)?.homeDir();
    if (project && !project.paths[id]) throw fail(`项目「${project.name}」尚未配置在 ${id} 上的目录`);
    return { machineId: id, node: id === selfId() ? 'local' : id, cwd, ...(project ? { workspaceId: project.id } : {}), ...(moved ? { handoff: { from: original, to: id, reason: manual ? 'manual' : 'offline', previousSessionId: input.sessionId || '', context: 'partial' } } : {}) };
  }
  async function save(input) {
    if (!input || !input.defaults || !Array.isArray(input.projects)) throw fail('请提供机器默认目录和项目映射');
    const known = new Set(machines().map(item => item.id)), old = read(), ids = new Set();
    const check = async (id, value, previous) => {
      if (!known.has(id) || typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\0\r\n]/.test(value)) throw fail('机器或目录无效');
      if (value === previous) return value;
      const host = hostFor(id); if (!host) throw fail(`机器 ${id} 未连接，暂时不能校验目录`);
      try { return await host.resolveDir(value); } catch (error) { throw fail(`${id}：${error.message}（${value}）`); }
    };
    const defaults = {};
    for (const [id, value] of Object.entries(input.defaults)) defaults[id] = await check(id, value, old.defaults[id]);
    const projects = [];
    for (const item of input.projects) {
      if (!item || !ID.test(item.id) || ids.has(item.id) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 80 || !item.paths || Array.isArray(item.paths)) throw fail('项目名称、标识或目录映射无效');
      ids.add(item.id); const paths = {}, previous = old.projects.find(row => row.id === item.id);
      for (const [id, value] of Object.entries(item.paths)) if (value) paths[id] = await check(id, value, previous?.paths[id]);
      projects.push({ id: item.id, name: item.name.trim(), paths });
    }
    const config = { defaults, projects }, tmp = file + '.' + crypto.randomUUID() + '.tmp';
    fs.mkdirSync(dir, { recursive: true });
    try { fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(tmp, file); }
    finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
    return config;
  }
  function view() {
    const config = read();
    return { selfId: selfId(), config, machines: machines().map(item => ({ ...item, home: hostFor(item.id)?.homeDir() || '', defaultDirectory: config.defaults[item.id] || hostFor(item.id)?.homeDir() || '' })) };
  }
  return { read, save, resolve, view };
}
module.exports = { createWorkspaces };
