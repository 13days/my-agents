// Send Markdown as native post/md elements, keeping every chunk in the original
// reply thread. Using text messages displays Markdown delimiters literally.
function markdownChunks(value, limit = 6000) {
  const text = String(value || '').replace(/<at\b/gi, '&lt;at');
  if (!text) return [];
  const chunks = []; let rest = text, fence = null;
  while (rest.length) {
    const prefix = fence ? fence.marker + fence.language + '\n' : '';
    const available = limit - prefix.length - 16;
    let end = Math.min(rest.length, available);
    if (end < rest.length) {
      const newline = rest.lastIndexOf('\n', end);
      if (newline > available / 2) end = newline + 1;
      if (/[\uD800-\uDBFF]/.test(rest[end - 1])) end--;
    }
    const part = rest.slice(0, end); rest = rest.slice(end);
    for (const line of part.split('\n')) {
      const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (!match) continue;
      if (match[1].length > 100 || match[2].length > 200) continue;
      if (!fence) fence = { marker: match[1], language: match[2].trim() };
      else if (match[1][0] === fence.marker[0] && match[1].length >= fence.marker.length && !match[2].trim()) fence = null;
    }
    chunks.push(prefix + part + (fence && rest ? '\n' + fence.marker : ''));
  }
  return chunks;
}

async function sendMarkdown(channel, msg, value) {
  let result;
  for (const text of markdownChunks(value)) {
    result = await channel.send(msg.chatId, { post: { zh_cn: { title: '', content: [[{ tag: 'md', text }]] } } }, { replyTo: msg.messageId, replyInThread: msg.chatType === 'p2p' || !!msg.threadId });
  }
  return result;
}
module.exports = { markdownChunks, sendMarkdown };
