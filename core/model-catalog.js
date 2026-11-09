function normalizeCodexModels(payload) {
  const rows = Array.isArray(payload?.models) ? payload.models : Array.isArray(payload?.data) ? payload.data : [];
  const models = rows.filter(row => row && row.supported_in_api !== false && row.visibility !== 'hide').map(row => ({ id: row.slug || row.id, name: row.display_name || row.slug || row.id, priority: Number.isFinite(row.priority) ? row.priority : 1000, created: row.created || 0 })).filter(row => typeof row.id === 'string' && row.id && !/image|audio|realtime|transcrib|embedding|moderation|tts/i.test(row.id));
  models.sort((a, b) => a.priority - b.priority || b.created - a.created);
  const unique = [...new Map(models.map(row => [row.id, row])).values()];
  const preferred = unique.some(row => row.id === payload?.default_model) ? payload.default_model : unique[0]?.id || '';
  return { models: unique.map(({ id, name }) => ({ id, name })), defaultModel: preferred };
}
function createModelCatalog({ load, now = Date.now, ttl = 5 * 60 * 1000 }) {
  const entries = new Map();
  return {
    async get(key = '', refresh = false) {
      if (refresh) entries.delete(key);
      let entry = entries.get(key);
      if (!entry || now() - entry.at >= ttl) {
        const pending = Promise.resolve().then(() => load(key)).then(result => {
          const normalized = normalizeCodexModels(result);
          if (!normalized.defaultModel) throw new Error('当前账号未返回可用 Codex 模型，请检查账号或手动选择模型');
          return normalized;
        }).catch(error => { if (entries.get(key)?.pending === pending) entries.delete(key); throw error; });
        entry = { at: now(), pending }; entries.set(key, entry);
      }
      return entry.pending;
    },
  };
}
module.exports = { normalizeCodexModels, createModelCatalog };
