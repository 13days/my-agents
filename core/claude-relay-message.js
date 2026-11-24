// Display-only decoding of our IM bridge envelope. This does not change the
// native session's permission policy or turn peer text into execution approval.
function claudeRelayMessage(row) {
  if (row?.type !== 'user' || row.isSidechain) return null;
  const content = row.message?.content;
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(block => block?.type === 'text').map(block => block.text || '').join('\n') : '';
  const match = /^Another Claude session sent a message:\r?\n\[来自飞书 · my-agents-im:([\w-]+)\]\r?\n/.exec(text);
  if (!match) return null;
  const footer = text.lastIndexOf('\n\nThis came from another Claude session');
  if (footer < match[0].length) return null;
  let body = text.slice(match[0].length, footer).trim();
  const context = /^\[(my-agents|Claude Panel) 飞书发送上下文，本轮有效\]\r?\n/.exec(body);
  if (context) {
    const closing = `[/${context[1]} 飞书发送上下文]`, end = body.indexOf(closing, context[0].length);
    if (end < 0) return null;
    body = body.slice(end + closing.length).trim();
  }
  return body ? { text: body, relayMessageId: match[1], source: 'feishu' } : null;
}
module.exports = { claudeRelayMessage };
