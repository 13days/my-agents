// SDK-normalized messages can retain a leading bot mention in text or rich posts.
// Only strip proven bot mentions, and only when they precede a slash command.
function commandText(msg, bot = {}) {
  const original = String(msg.content || '').trim();
  const mentions = [...(Array.isArray(msg.mentions) ? msg.mentions : []), ...(msg.raw?.message?.mentions || msg.raw?.event?.message?.mentions || [])];
  const ids = new Set([bot.openId, bot.userId].filter(Boolean));
  const names = new Set(bot.name ? [bot.name] : []), tokens = new Set();
  for (const mention of mentions) {
    const isBot = mention.isBot || [mention.openId, mention.userId, mention.id?.open_id, mention.id?.user_id].some(id => id && ids.has(id));
    if (!isBot) continue;
    if (mention.name) names.add(mention.name);
    if (mention.key) tokens.add(mention.key);
    for (const id of [mention.openId, mention.userId, mention.id?.open_id, mention.id?.user_id]) if (id) ids.add(id);
  }
  for (const name of names) tokens.add('@' + name);
  const leadingSpace = value => value.replace(/^[\s\u200b\u2060\ufeff]+/u, '');
  let text = leadingSpace(original);
  for (let i = 0; i < 20; i++) {
    const before = text;
    const tag = text.match(/^<at\b([^>]*)>[\s\S]*?<\/at>/i);
    const id = tag?.[1].match(/(?:user_id|open_id)\s*=\s*["']([^"']+)["']/i)?.[1];
    if (tag && ids.has(id)) text = leadingSpace(text.slice(tag[0].length));
    else {
      for (const token of [...tokens].sort((a, b) => b.length - a.length)) {
        if (!text.startsWith(token)) continue;
        const next = text.slice(token.length);
        if (next && !/^[\s/\u200b\u2060\ufeff]/u.test(next)) continue;
        text = leadingSpace(next); break;
      }
    }
    if (before === text) break;
  }
  return text.startsWith('/') ? text : original;
}
module.exports = { commandText };
