const { messageTimestamp } = require('../message-timing');
const shorten = (text, size) => Array.from(text).slice(0, size).join('');
// Attachment transport markup is not a useful conversation label.
function previewText(text) {
  return String(text || '').replace(/<\/?image\b[^>]*>/gi, '').replace(/\[Image #\d+\]/g, '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱已隐藏]').replace(/\s+/g, ' ').trim();
}
function userMessages(history) {
  return (history?.messages || []).filter(message => message.role === 'user' && (message.text?.trim() || message.images?.length));
}
function sessionPreview(history, item = {}) {
  const users = userMessages(history);
  const available = !!history && item.historyAvailable !== false;
  const times = (history?.messages || []).map(message => messageTimestamp(message.timestamp)).filter(Boolean).map(Date.parse);
  const first = messageTimestamp(item.first || item.createdAt);
  const creationTimes = first ? [...times, Date.parse(first)] : times;
  return {
    id: item.id, turns: available ? users.length : null,
    createdAt: creationTimes.length ? creationTimes.reduce((minimum, at) => Math.min(minimum, at), Infinity) : null,
    lastAt: times.reduce((latest, at) => Math.max(latest, at), Number(item.last) || 0) || null,
    userMessages: users.slice(-2).map((message, index) => ({
      round: users.length - Math.min(2, users.length) + index + 1,
      text: shorten(previewText(message.text) || (message.images?.length ? `[图片 ${message.images.length} 张]` : ''), 100),
      timestamp: messageTimestamp(message.timestamp),
    })),
    previewUnavailable: !available,
  };
}
function userMessagePage(history, requestedPage = 0, item = {}) {
  const users = userMessages(history), size = 5;
  const page = Math.max(0, Math.min(Math.ceil(users.length / size) - 1, Math.trunc(Number(requestedPage) || 0)));
  const end = Math.max(0, users.length - page * size), start = Math.max(0, end - size);
  return { ...sessionPreview(history, item), total: users.length, page, pages: Math.max(1, Math.ceil(users.length / size)),
    messages: users.slice(start, end).map((message, index) => ({ round: start + index + 1, text: shorten(previewText(message.text) || `[图片 ${message.images?.length || 0} 张]`, 1200), timestamp: messageTimestamp(message.timestamp) })) };
}
module.exports = { previewText, sessionPreview, userMessagePage };
