function createContactDirectory({ inbox, getChannel, getAppId, now = Date.now }) {
  const lookups = new Map(), groupMembers = new Map();
  async function memberNames(appId, chatId, channel) {
    const api = channel.rawClient?.im?.v1?.chatMembers;
    if (!api?.get) return new Map();
    const key = `${appId}:${chatId}`, existing = groupMembers.get(key);
    if (existing && (existing.pending || existing.expires > now())) return existing.promise;
    const entry = { pending: true, expires: now() + 5 * 60 * 1000 };
    entry.promise = Promise.resolve().then(async () => {
      const names = new Map(), wanted = new Set(inbox.contacts(appId).users.filter(item => inbox.groupsForUser?.(appId, item.id).includes(chatId)).map(item => item.id));
      let pageToken;
      try {
        for (let page = 0; page < 20; page++) {
          const result = await api.get({ path: { chat_id: chatId }, params: { member_id_type: 'open_id', page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) } });
          if (result?.code && result.code !== 0) break;
          for (const item of result?.data?.items || []) if (wanted.has(item.member_id) && typeof item.name === 'string' && item.name.trim()) names.set(item.member_id, item.name.trim());
          if (!result?.data?.has_more || !result.data.page_token || [...wanted].every(id => names.has(id))) break;
          pageToken = result.data.page_token;
        }
      } catch {}
      finally { entry.pending = false; if (!names.size) entry.expires = now() + 60 * 1000; }
      return names;
    });
    groupMembers.set(key, entry); return entry.promise;
  }
  async function lookup(kind, id, force = false) {
    const channel = getChannel(), appId = getAppId(), key = `${appId}:${kind}:${id}`;
    if (!channel) return false;
    const previous = lookups.get(key);
    if (previous?.promise) return previous.promise;
    if (!force && previous?.retryAt > now()) return previous.ok;
    const entry = { retryAt: now() + 5 * 60 * 1000, ok: false };
    lookups.set(key, entry);
    entry.promise = Promise.resolve().then(async () => {
      try {
        let name;
        if (kind === 'groups') {
          if (!channel.getChatInfo) return false;
          name = (await channel.getChatInfo(id))?.name;
        } else {
          const userApi = channel.rawClient?.contact?.v3?.user;
          try {
            const result = userApi?.get && await userApi.get({ path: { user_id: id }, params: { user_id_type: 'open_id' } });
            if (!result?.code) name = result?.data?.user?.name || result?.data?.user?.nickname || result?.data?.user?.en_name;
          } catch {}
          if (!name) {
            for (const chatId of inbox.groupsForUser?.(appId, id) || []) {
              if (getAppId() !== appId || getChannel() !== channel) return false;
              name = (await memberNames(appId, chatId, channel)).get(id); if (name) break;
            }
          }
        }
        if (typeof name !== 'string' || !name.trim() || getAppId() !== appId || getChannel() !== channel) return false;
        inbox.setName(appId, id, name.trim().slice(0, 200)); entry.ok = true; return true;
      } catch { return false; }
      finally { entry.promise = null; if (!entry.ok) entry.retryAt = now() + 60 * 1000; }
    });
    return entry.promise;
  }
  async function refresh(force = true) {
    await inbox.ready;
    const appId = getAppId(), contacts = inbox.contacts(appId);
    if (force) for (const [key, entry] of groupMembers) if (!entry.pending) groupMembers.delete(key);
    const queue = ['users', 'groups'].flatMap(kind => contacts[kind].filter(item => force || !item.name).map(item => ({ kind, id: item.id })));
    let updated = 0, failed = 0;
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (;;) {
        const item = queue.shift(); if (!item || getAppId() !== appId) return;
        if (await lookup(item.kind, item.id, force)) updated++; else failed++;
      }
    }));
    return { updated, failed };
  }
  return { lookup, refresh };
}
module.exports = { createContactDirectory };
