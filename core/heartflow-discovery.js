// Search is user-scoped and covers both direct and group chats. Keep fixed upper
// bounds while paging; a separate live lane prevents history from blocking news.
async function discoverMessages({ store, source, now }) {
  const config = store.snapshot().config;
  if (!source.recent) throw new Error('当前消息连接尚不支持自动发现');
  if (!store.snapshot().cursor.discovery) {
    const upper = now(), split = Math.max(config.since, upper - 10 * 60000);
    store.transaction(s => { s.cursor.discovery = { live: { watermark: split }, history: { floor: config.since, upper: split, done: split <= config.since } }; });
  }
  const errors = [];
  for (const lane of ['live', 'history']) {
    try {
      let cursor = store.snapshot().cursor.discovery[lane];
      if (cursor.done) continue;
      const floor = cursor.floor ?? Math.max(config.since, cursor.watermark - 10 * 60000);
      const upper = cursor.upper ?? now();
      for (let i = 0; i < 2; i++) {
        let result;
        try { result = await source.recent(floor, upper, cursor.page); }
        catch (error) {
          if (!cursor.page || !/page[_ ]?token.*(?:invalid|expired)/i.test(String(error.message || error))) throw error;
          // Restart the same bounded window, never skip unseen messages. Ingest deduplicates IDs.
          cursor = { ...cursor }; delete cursor.page;
          const current = store.snapshot();
          if (current.config.discoveryMode !== 'recent' || current.config.since !== config.since || !current.cursor.discovery) throw error;
          store.transaction(s => { s.cursor.discovery[lane] = cursor; });
          result = await source.recent(floor, upper, undefined);
        }
        const current=store.snapshot();
        if(current.config.discoveryMode!=='recent'||current.config.since!==config.since||!current.cursor.discovery)throw new Error('消息读取范围已变化，下次按新范围同步');
        if (!Array.isArray(result.messages)) throw new Error('自动发现未返回有效消息列表');
        if (result.has_more && (!result.page_token || result.page_token === cursor.page)) throw new Error('自动发现分页游标缺失或未前进');
        const rows = result.messages.filter(m => Number(m.create_time) >= floor && Number(m.create_time) <= upper && m.msg_type !== 'system' && m.sender?.sender_type !== 'app');
        store.ingest(rows.map(require('./heartflow-feishu').normalizeMessage));
        cursor = result.has_more ? { floor, upper, page: result.page_token } : lane === 'live' ? { watermark: upper } : { floor, upper, done: true };
        store.transaction(s => {
          s.cursor.discovery[lane] = cursor;
          s.source.lastDiscovery = now();
          s.source.discoveryMessages = (s.source.discoveryMessages || 0) + rows.length;
        });
        if (!result.has_more) break;
      }
    } catch (error) { if (require('./heartflow-feishu').needsPersonalLogin(error)) throw error; errors.push(new Error(`${lane}: ${error.message || error}`)); }
  }
  if (errors.length) throw new AggregateError(errors, errors.map(e => e.message).join('; '));
}
function inScope(message, config) {
  return config.discoveryMode === 'recent' || !config.chats?.length || config.chats.some(c => c.id === message.chatId);
}
module.exports = { discoverMessages, inScope };
