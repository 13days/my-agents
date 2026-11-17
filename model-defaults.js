function modelDefaults(ids, explicit = {}) {
  const defaults = {};
  for (const family of ['opus', 'sonnet', 'haiku']) {
    const key = `ANTHROPIC_DEFAULT_${family.toUpperCase()}_MODEL`;
    if (explicit[key]) continue;
    const options = ids.filter(id => typeof id === 'string' && /claude/i.test(id) && id.toLowerCase().includes(family));
    const preferred = options.filter(id => id.startsWith('auto/'));
    const bare = options.filter(id => id.startsWith('claude-'));
    const pool = preferred.length ? preferred : bare.length ? bare : options.length === 1 ? options : [];
    pool.sort((a, b) => {
      const version = id => { const match = id.match(new RegExp(`${family}[-_]([0-9]{1,2})(?:[-_.]([0-9]{1,2}))?`, 'i')); return match ? Number(match[1]) * 100 + Number(match[2] || 0) : 0; };
      return version(b) - version(a) || a.localeCompare(b);
    });
    if (pool[0]) defaults[key] = pool[0];
  }
  if (!explicit.ANTHROPIC_SMALL_FAST_MODEL && (explicit.ANTHROPIC_DEFAULT_HAIKU_MODEL || defaults.ANTHROPIC_DEFAULT_HAIKU_MODEL)) defaults.ANTHROPIC_SMALL_FAST_MODEL = explicit.ANTHROPIC_DEFAULT_HAIKU_MODEL || defaults.ANTHROPIC_DEFAULT_HAIKU_MODEL;
  return defaults;
}
// A node's settings.json may pin a concrete Claude id (e.g. claude-opus-4-6) that the routed
// gateway does not serve. Keep aliases and non-Claude ids; map a pinned Claude id to its family
// alias when the gateway's discovered default for that family differs, so the CLI resolves it
// through ANTHROPIC_DEFAULT_<FAMILY>_MODEL.
function routedDefaultModel(model, env = {}) {
  if (typeof model !== 'string' || !model) return '';
  const family = ['opus', 'sonnet', 'haiku'].find(name => model.toLowerCase().includes(name));
  if (!family || !/claude/i.test(model)) return model;
  const discovered = env[`ANTHROPIC_DEFAULT_${family.toUpperCase()}_MODEL`];
  return discovered && discovered !== model ? family + (/\[1m\]$/i.test(model) ? '[1m]' : '') : model;
}
module.exports = { modelDefaults, routedDefaultModel };
