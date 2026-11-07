const { sendMarkdown } = require('./feishu-markdown');
// Simple chats use ordinary rich-text replies and a temporary reaction on the user's
// message. Capture the transport so cleanup also works while the gateway stops.
function createSimpleReply({ channel, msg, messageId, footer = '', onError = () => {}, onClose = () => {} }) {
  let reactionId, unsubscribe, timer, closed = false, closing, text = '', done = false, fallback = '已完成。', permissionPending = false;
  async function clearReaction() {
    if (!reactionId) return;
    const id = reactionId; reactionId = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await channel.removeReaction(msg.messageId, id); return; }
      catch (e) { onError(e); }
    }
  }
  function close() {
    if (closing) return closing;
    closed = true; clearTimeout(timer); unsubscribe?.(); onClose();
    closing = clearReaction(); return closing;
  }
  async function sendText(value) {
    return sendMarkdown(channel, msg, value);
  }
  async function finish() {
    if (closed) return;
    // Stop listening before awaiting the send, so error/done/end cannot send twice.
    closed = true; clearTimeout(timer); unsubscribe?.();
    try { if (text || fallback) await sendText((text || fallback) + (footer ? '\n\n' + footer : '')); }
    catch (e) { onError(e); }
    finally { await close(); }
  }
  return {
    async start() {
      try { reactionId = await channel.addReaction(msg.messageId, 'Typing'); if (closed) await clearReaction(); }
      catch (e) { onError(e); } // Missing reaction permission must not block Claude.
    },
    attach(watch) {
      unsubscribe = watch((event, data = {}) => {
        if (closed) return;
        if (event !== 'stopped' && event !== 'end' && data.messageId !== messageId) return;
        if (event === 'text') text += data.text || '';
        if (event === 'permission' && !permissionPending) {
          permissionPending = true;
          sendText('任务需要工具授权，请在 Mac 的 Panel 中确认后继续。').catch(onError);
        }
        if (event === 'permission_resolved') permissionPending = false;
        if (event === 'error') { text += (text ? '\n' : '') + '未能完成：' + (data.error || '执行失败'); done = true; }
        if (event === 'done') { done = true; if (data.interrupted) fallback = ''; else if (data.isError) fallback = '执行失败，请查看 Panel 中的任务记录。'; }
        if (event === 'stopped') { done = true; fallback = '已停止。'; }
        if (event === 'end' && !done) { done = true; fallback = '任务连接已结束，请重新发送消息继续。'; }
        if (done) { clearTimeout(timer); timer = setTimeout(finish, 0); }
      });
      if (closed) unsubscribe?.();
    },
    close,
    get closed() { return closed; },
  };
}
module.exports = { createSimpleReply };
