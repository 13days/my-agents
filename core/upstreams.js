// Model upstreams behind the local capture proxy. Each engine that routes
// through the panel registers one: which request paths it owns, how to relay
// them, and how to read a captured exchange. The proxy server and the capture
// recorder dispatch here instead of testing for a specific engine.
function createUpstreams() {
  const list = [];
  let fallback = null;
  const upstreams = {
    // { id, engine, match(url) → bool, handle(req, res), extract?(rec, { stream }) }
    add(upstream, { isDefault = false } = {}) {
      if (!upstream?.id || typeof upstream.handle !== 'function') throw new Error('上游缺少 id 或 handle');
      if (isDefault) fallback = upstream; else list.push(upstream);
      return upstream;
    },
    for: url => list.find(upstream => upstream.match?.(String(url || ''))) || fallback,
    handle(req, res) {
      const upstream = upstreams.for(req.url);
      if (upstream) return upstream.handle(req, res);
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '没有匹配的上游' }));
    },
    list: () => [...list, ...(fallback ? [fallback] : [])].map(({ id, engine }) => ({ id, engine })),
  };
  return upstreams;
}
module.exports = { createUpstreams };
