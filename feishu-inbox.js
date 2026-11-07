const fs = require('fs');
const path = require('path');
const readline = require('readline');

function createFeishuInbox(dir) {
  const file = path.join(dir, 'panel-feishu-inbox.jsonl'), namesFile = path.join(dir, 'panel-feishu-contacts.json'), labelsFile = path.join(dir, 'panel-feishu-contact-labels.json');
  const rows = [], seen = new Set(), users = new Map(), chats = new Map(), counts = new Map();
  let names = {};
  try { names = JSON.parse(fs.readFileSync(namesFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') console.warn('飞书联系人名称索引无法读取，将从消息记录恢复'); }
  let labels = {};
  try { labels = JSON.parse(fs.readFileSync(labelsFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') console.warn('飞书联系人备注无法读取'); }
  const display = item => ({ ...item, alias: labels[key(item.appId, item.id)] || '', displayName: labels[key(item.appId, item.id)] || item.name || '' });
  const key = (appId, id) => `${appId}:${id}`;
  function index(record, offset, length) {
    const id = key(record.appId, record.messageId);
    if (seen.has(id)) return;
    seen.add(id); counts.set(record.appId, (counts.get(record.appId) || 0) + 1);
    rows.push({ appId: record.appId, senderId: record.senderId, chatId: record.chatId, offset, length });
    for (const [map, entityId, name, type] of [[users, record.senderId, record.senderName, 'user'], [chats, record.chatId, record.chatName, record.chatType]]) {
      const entityKey = key(record.appId, entityId);
      const item = map.get(entityKey) || { id: entityId, type, appId: record.appId, firstAt: record.receivedAt, count: 0 };
      item.name = names[entityKey] || name || item.name || '';
      if (type === 'user' && record.chatType === 'group' && record.mentionedBot) { item.mentionCount = (item.mentionCount || 0) + 1; item.lastMentionAt = record.receivedAt; }
      item.lastAt = record.receivedAt; item.count++; map.set(entityKey, item);
    }
  }
  const ready = (async () => {
    if (!fs.existsSync(file)) return;
    let offset = 0;
    const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) {
      const length = Buffer.byteLength(line) + 1;
      try { index(JSON.parse(line), offset, length); } catch {}
      offset += length;
    }
    // Isolate an incomplete final line after a crash, without deleting any bytes.
    const fd = fs.openSync(file, 'r');
    try { const size = fs.fstatSync(fd).size; if (size) { const last = Buffer.alloc(1); fs.readSync(fd, last, 0, 1, size - 1); if (last[0] !== 10) fs.appendFileSync(file, '\n'); } } finally { fs.closeSync(fd); }
  })();
  async function record(appId, msg, access) {
    await ready;
    if (seen.has(key(appId, msg.messageId))) return false;
    fs.mkdirSync(dir, { recursive: true });
    const row = { appId, messageId: msg.messageId, senderId: msg.senderId, senderName: msg.senderName || '', chatId: msg.chatId, chatType: msg.chatType, threadId: msg.threadId || msg.raw?.message?.thread_id || msg.raw?.event?.message?.thread_id || '', rootId: msg.rootId || '', replyToMessageId: msg.replyToMessageId || '', chatName: msg.chatName || '', receivedAt: new Date().toISOString(), createTime: msg.createTime || null, content: String(msg.content || ''), contentType: msg.rawContentType || 'text', rawContent: msg.raw?.event?.message?.content || msg.raw?.message?.content || null, mentionedBot: !!msg.mentionedBot, resources: msg.resources || [], access };
    const data = Buffer.from(JSON.stringify(row) + '\n'), fd = fs.openSync(file, 'a', 0o600);
    try { const offset = fs.fstatSync(fd).size; fs.writeFileSync(fd, data); index(row, offset, data.length); } finally { fs.closeSync(fd); }
    return true;
  }
  function contacts(appId) {
    const recent = map => [...map.values()].filter(item => item.appId === appId).sort((a, b) => b.lastAt.localeCompare(a.lastAt)).map(display);
    return { users: recent(users), groups: recent(chats).filter(item => item.type === 'group'), messageCount: counts.get(appId) || 0 };
  }
  async function messages(appId, { before, userId, chatId, limit = 30 } = {}) {
    await ready;
    const end = before === undefined ? rows.length : Math.min(rows.length, Math.max(0, Number(before) || 0));
    const items = []; let cursor = end;
    const fd = fs.existsSync(file) ? fs.openSync(file, 'r') : null;
    try {
      while (cursor > 0 && items.length < Math.min(100, Math.max(1, limit))) {
        const entry = rows[--cursor];
        if (entry.appId !== appId || userId && entry.senderId !== userId || chatId && entry.chatId !== chatId) continue;
        const bytes = Buffer.alloc(entry.length); let read = 0;
        while (read < bytes.length) { const n = fs.readSync(fd, bytes, read, bytes.length - read, entry.offset + read); if (!n) break; read += n; }
        const item = JSON.parse(bytes.toString('utf8'));
        item.senderName = labels[key(appId, item.senderId)] || users.get(key(appId, item.senderId))?.name || item.senderName;
        item.chatName = labels[key(appId, item.chatId)] || chats.get(key(appId, item.chatId))?.name || item.chatName;
        items.push(item);
      }
    } finally { if (fd !== null) fs.closeSync(fd); }
    return { items, before: cursor, hasMore: cursor > 0 };
  }
  function setName(appId, id, name) {
    if (!name) return;
    const entityKey = key(appId, id); names[entityKey] = String(name);
    for (const map of [users, chats]) if (map.has(entityKey)) map.get(entityKey).name = String(name);
    const temp = namesFile + '.tmp'; fs.writeFileSync(temp, JSON.stringify(names), { mode: 0o600 }); fs.renameSync(temp, namesFile);
  }
  function setAlias(appId, id, label) {
    if (typeof label !== 'string' || label.trim().length > 80) throw new Error('备注名称不能超过 80 个字符');
    const entityKey = key(appId, id), value = label.trim();
    if (value) labels[entityKey] = value; else delete labels[entityKey];
    fs.mkdirSync(dir, { recursive: true });
    const temp = labelsFile + '.tmp'; fs.writeFileSync(temp, JSON.stringify(labels), { mode: 0o600 }); fs.renameSync(temp, labelsFile);
  }
  return { ready, record, contacts, messages, setName, setAlias, groupsForUser: (appId, id) => [...new Set(rows.filter(row => row.appId === appId && row.senderId === id && chats.get(key(appId, row.chatId))?.type === 'group').map(row => row.chatId))], chatType: (appId, id) => chats.get(key(appId, id))?.type };
}
module.exports = { createFeishuInbox };
