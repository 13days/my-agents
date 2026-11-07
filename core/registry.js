// Engines and the nodes they run on. Nothing outside engines/ should test for
// a specific engine id; ask the registry for metadata and capabilities instead.
//
// A node is a machine that runs engine CLIs: the local node lives in this
// process, remote nodes connect over RPC and expose proxy adapters with the
// same interface.
const REQUIRED = ['id', 'meta', 'capabilities', 'open', 'owns', 'validModel'];

function createRegistry({ defaultEngine = 'claude' } = {}) {
  const nodes = new Map();
  let fallback = defaultEngine;
  const all = () => [...nodes.values()].flatMap(node => [...node.engines.values()]);

  const registry = {
    addNode({ id, label, host, remote = false, info = {} }) {
      const node = { id, label: label || id, host, remote, info, engines: new Map(), connectedAt: Date.now() };
      nodes.set(id, node);
      return node;
    },
    removeNode(id) { if (id !== 'local') nodes.delete(id); },
    node: id => nodes.get(id || 'local') || null,
    nodes: () => [...nodes.values()],

    register(engine, nodeId = 'local') {
      for (const key of REQUIRED) if (!engine[key]) throw new Error(`引擎适配器缺少 ${key}`);
      const node = nodes.get(nodeId);
      if (!node) throw new Error(`节点不存在：${nodeId}`);
      node.engines.set(engine.id, engine);
      return engine;
    },
    // Adapter for an engine on a node (local by default).
    adapter(engineId, nodeId = 'local') {
      const node = nodes.get(nodeId || 'local');
      if (!node) throw Object.assign(new Error(`节点不可用：${nodeId}`), { status: 400 });
      return node.engines.get(engineId) || null;
    },
    // Engine type metadata, independent of node.
    get: id => nodes.get('local')?.engines.get(id) || all().find(engine => engine.id === id) || null,
    has: id => !!registry.get(id),
    ids: () => [...new Set(all().map(engine => engine.id))],
    list: () => registry.ids().map(registry.get),
    defaultId: () => registry.has(fallback) ? fallback : registry.ids()[0],
    setDefault(id) { if (registry.has(id)) fallback = id; },

    describe(engine) {
      let cli = null;
      try { const info = engine.detect?.(); if (info) cli = { path: info.path, version: info.version, source: info.source || '' }; } catch {}
      return {
        id: engine.id, ...engine.meta, capabilities: engine.capabilities, cli, default: engine.id === registry.defaultId(),
        nodes: registry.nodes().filter(node => node.engines.has(engine.id)).map(node => ({ id: node.id, label: node.label, remote: node.remote })),
      };
    },
    // Engine matching user text (commands such as `/use codex`).
    find(text) {
      const value = String(text || '').trim().toLowerCase();
      if (!value) return null;
      return registry.list().find(engine => [engine.id, engine.meta.label, engine.meta.short, ...(engine.meta.aliases || [])].some(name => String(name || '').toLowerCase() === value)) || null;
    },
    label: id => registry.get(id)?.meta.label || id,
  };
  return registry;
}
module.exports = { createRegistry };
