const { sessionPreview } = require('./session-previews');

// Inspect history on its owning machine. Only small previews cross the control
// connection; sending a full transcript can exceed its WebSocket frame limit.
function createSessionInspection({ selfId, localPreviews, localUserPage, peerFor, checkpoint = () => null }) {
  const owner = item => item.machineId || item.node || selfId();
  const local = item => ['local', selfId()].includes(owner(item));
  return {
    async previews(items) {
      const groups = new Map();
      for (const item of items) { const id = owner(item); if (!groups.has(id)) groups.set(id, []); groups.get(id).push(item); }
      const values = new Map();
      await Promise.all([...groups.values()].map(async rows => {
        try {
          const result = local(rows[0]) ? await localPreviews(rows) : await peerFor(owner(rows[0]))?.call('history.previews', { items: rows }, { timeout: 15000 });
          for (const item of result || []) values.set(item.id, item);
        } catch { /* Keep other machines' successful previews. */ }
      }));
      return items.map(item => values.get(item.id) || sessionPreview(checkpoint(item.id), item));
    },
    async userPage(item, page) {
      if (local(item)) return localUserPage({ item, page });
      const peer = peerFor(owner(item));
      if (!peer) throw new Error('原执行机器未连接，请恢复连接后查看用户消息');
      return peer.call('history.userPage', { item, page }, { timeout: 15000 });
    },
  };
}
module.exports = { createSessionInspection };
