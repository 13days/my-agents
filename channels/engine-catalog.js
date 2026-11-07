// What a channel (Feishu, …) knows about engines: names, aliases and
// capabilities. Channels never test for a specific engine id; they ask here.
// The built-in list is only a fallback for channels running without a registry.
const BUILTIN = [
  { id: 'claude', label: 'Claude Code', short: 'Claude', aliases: ['cc', 'claude-code'], cliEnv: 'CLAUDE_CLI', capabilities: { accounts: true, permissions: 'auto' } },
  { id: 'codex', label: 'Codex', short: 'Codex', aliases: ['openai-codex'], capabilities: { accounts: false, permissions: 'none' } },
];

function engineCatalog(list) {
  const engines = Array.isArray(list) && list.length ? list : BUILTIN;
  const byId = new Map(engines.map(engine => [engine.id, engine]));
  const catalog = {
    list: engines,
    ids: () => engines.map(engine => engine.id),
    has: id => byId.has(id),
    get: id => byId.get(id) || null,
    label: id => byId.get(id)?.label || id || '',
    // Engine id for user text such as `/use codex` or `/new cc`.
    find(text) {
      const value = String(text || '').trim().toLowerCase();
      if (!value) return '';
      return engines.find(engine => [engine.id, engine.label, engine.short, ...(engine.aliases || [])].some(name => String(name || '').toLowerCase() === value))?.id || '';
    },
    // A usable engine id: the given one when known, otherwise the first engine.
    fallback: (id, fallback) => byId.has(id) ? id : byId.has(fallback) ? fallback : engines[0].id,
    can: (id, capability) => { const value = byId.get(id)?.capabilities?.[capability]; return !!value && value !== 'none'; },
    others: id => engines.filter(engine => engine.id !== id),
    // "/codex 或 /claude": the engines you can switch to first, the current one last.
    switchHint: current => [...catalog.others(current), ...(byId.has(current) ? [byId.get(current)] : [])].map(engine => '/' + engine.id).join(' 或 '),
  };
  return catalog;
}
module.exports = { engineCatalog, BUILTIN_ENGINES: BUILTIN };
