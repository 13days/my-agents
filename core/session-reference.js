// Resolve historical IDs independently of the panel currently receiving IM.
// Stable recorded ownership is authoritative, including while that host is offline.
function createSessionResolver({ metadata, selfId, nodes, owns, history, remember = () => {} }) {
  return async function resolve(id, hint = {}) {
    if (!/^[a-zA-Z0-9-]{8,100}$/.test(id || '')) return null;
    const meta = metadata(id) || {};
    if (meta.deleted) throw new Error('此会话已明确删除，请选择其他会话');
    const stable = record => record.machineId && record.machineId !== 'local' ? record.machineId : record.node && record.node !== 'local' ? record.node : '';
    const recordedMachine = stable(meta);
    const hintedMachine = stable(hint);
    if (recordedMachine || hintedMachine) {
      const source = recordedMachine ? meta : { ...hint, ...meta };
      const machineId = recordedMachine || hintedMachine;
      const resolved = { ...hint, ...source, id, machineId, node: machineId === selfId() ? 'local' : machineId, project: source.project || source.cwd || hint.project || hint.cwd };
      if (!recordedMachine) await remember(resolved);
      return resolved;
    }
    // A legacy `local` alias says nothing about which host owned the session.
    // Probe native transcripts, never copied checkpoints or the newest /new choice.
    let unavailable = false;
    const matches = (await Promise.all(nodes().flatMap(node => node.engines.map(engine => (async () => {
      try { return await owns(node.id, engine, id) ? { node: node.id, engine } : null; }
      catch { unavailable = true; return null; }
    })())))).filter(Boolean);
    if (matches.length > 1) throw new Error('多个机器存在此会话，请在「机器与引擎」确认原执行机器后再切换');
    if (!matches.length) {
      if (Object.keys(meta).length || hint.cwd || hint.project || unavailable) throw new Error('暂时无法确认旧会话的原执行机器；请检查原机器连接后重试，历史不会被删除');
      return null;
    }
    const owner = matches[0], machineId = owner.node === 'local' ? selfId() : owner.node;
    const saved = await history(id, machineId);
    const resolved = { ...hint, ...meta, id, engine: owner.engine, machineId, node: owner.node, project: saved?.project || saved?.cwd || meta.project || hint.project || hint.cwd };
    await remember(resolved);
    return resolved;
  };
}
module.exports = { createSessionResolver };
