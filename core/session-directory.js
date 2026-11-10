const time = value => typeof value === 'number' ? value : Date.parse(value || '') || 0;
function searchSessions(rows, query = '') {
  const words = String(query).toLowerCase().trim().split(/\s+/).filter(Boolean);
  return rows.filter(row => {
    const text = [row.id, row.title, row.sessionName, row.firstTitle, row.latestPrompt, row.project, row.repository, row.gitBranch, row.machineId, row.engine].filter(Boolean).join(' ').toLowerCase();
    return words.every(word => text.includes(word));
  }).sort((a, b) => Number(!!b.running) - Number(!!a.running) || time(b.last) - time(a.last));
}
function normalize(row, source, native = false) {
  const project = row.cwd || row.project || '', split = project.split('/.claude/worktrees/');
  return { ...row, machineId: native ? source : row.machineId || (row.node && row.node !== 'local' ? row.node : source), project,
    repository: row.worktree?.repository || row.repository || split[0] || project,
    workspaceLabel: split.length > 1 ? split[1].split('/')[0] : row.workspaceLabel || '', native: native || row.native === true };
}
function createSessionDirectory({ local, selfId, peers, ttl = 3000, timeout = 8000, now = Date.now }) {
  let cache = [], unavailable = [], at = 0, pending;
  const remoteCache = new Map();
  function merge(localRows, remoteRows) {
    const all = new Map();
    for (const row of [...localRows, ...remoteRows]) {
      const previous = all.get(row.id);
      if (!previous || row.native && !previous.native || row.native === previous.native && time(row.last) > time(previous.last)) all.set(row.id, row);
    }
    return searchSessions([...all.values()]);
  }
  const snapshot = () => merge(local().map(row => normalize(row, selfId(), row.native)), cache);
  async function list({ refresh = false, query = '' } = {}) {
    if (!pending && (refresh || now() - at >= ttl || !at)) pending = (async () => {
      const connected = peers(), failed = [];
      await Promise.all(connected.map(async ({ id, peer }) => {
        try {
          const rows = await peer.call('history.list', {}, { timeout });
          if (!Array.isArray(rows)) throw new Error('会话目录无效');
          remoteCache.set(id, rows.filter(row => row.native === true || !row.machineId || row.machineId === id).map(row => normalize(row, id, row.native)));
        } catch { failed.push(id); }
      }));
      const ids = new Set(connected.map(peer => peer.id));
      for (const id of remoteCache.keys()) if (!ids.has(id)) failed.push(id);
      unavailable = [...new Set(failed)];
      cache = [...remoteCache].flatMap(([id, rows]) => rows.map(row => ({ ...row, sourceUnavailable: unavailable.includes(id), running: !unavailable.includes(id) && row.running })));
      at = now();
    })().finally(() => { pending = null; });
    if (pending) await pending;
    return { sessions: searchSessions(snapshot(), query), unavailable };
  }
  return { list, snapshot, find: id => snapshot().find(row => row.id === id) };
}
module.exports = { createSessionDirectory, searchSessions };
