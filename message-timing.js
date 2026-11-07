function messageTimestamp(value) {
  if (value === null || value === undefined || value === '') return undefined;
  const at = typeof value === 'number' ? (value < 1e11 ? value * 1000 : value) : Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
}
function annotateMessageTimings(messages) {
  let sentAt;
  for (const message of messages) {
    const timestamp = messageTimestamp(message.timestamp);
    if (timestamp) message.timestamp = timestamp;
    if (message.role === 'user') sentAt = timestamp ? Date.parse(timestamp) : undefined;
    else if (message.role === 'assistant' && message.durationMs === undefined && sentAt !== undefined && timestamp && Date.parse(timestamp) >= sentAt) message.durationMs = Date.parse(timestamp) - sentAt;
  }
  return messages;
}
module.exports = { messageTimestamp, annotateMessageTimings };
