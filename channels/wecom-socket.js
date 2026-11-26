// WeCom intelligent bot long-connection protocol. One callback req_id owns one reply stream.
const WebSocket = require('ws');
const { randomUUID } = require('crypto');

function connectWecom({ botId, secret, onMessage, onStatus, url = 'wss://openws.work.weixin.qq.com' }) {
  let socket, retry, interval, attempts = 0, stopped = false;
  const pending = new Map();
  function request(cmd, body, reqId = cmd + '_' + randomUUID()) {
    return new Promise((resolve, reject) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return reject(Error('企业微信连接已断开'));
      if (pending.has(reqId)) return reject(Error('企业微信上一条回复仍在等待回执'));
      const finish = error => { clearTimeout(timer); pending.delete(reqId); error ? reject(error) : resolve(); };
      const timer = setTimeout(() => finish(Error('企业微信回执超时')), 10000);
      pending.set(reqId, finish);
      socket.send(JSON.stringify({ cmd, headers: { req_id: reqId }, body }), error => { if (error && pending.get(reqId) === finish) finish(error); });
    });
  }
  function open() {
    if (stopped) return;
    onStatus(attempts ? 'reconnecting' : 'connecting', '');
    const ws = socket = new WebSocket(url, { handshakeTimeout: 12000, maxPayload: 2 * 1024 * 1024 });
    let ready = false, reason = '';
    ws.on('open', async () => {
      try {
        await request('aibot_subscribe', { bot_id: botId, secret });
        if (stopped || socket !== ws) return;
        ready = true; attempts = 0; onStatus('connected', '');
        interval = setInterval(() => request('ping').catch(() => ws.terminate()), 30000);
        interval.unref();
      } catch (error) {
        if (stopped) return;
        if (typeof error.code === 'number') { stopped = true; onStatus('error', '企业微信拒绝认证（' + error.code + '），请核对 Bot ID 和 Secret 后重新连接。'); }
        ws.terminate();
      }
    });
    ws.on('message', raw => {
      let frame;
      try { frame = JSON.parse(raw); } catch { return; }
      const id = frame?.headers?.req_id;
      if (!id || stopped) return;
      if (frame.cmd === 'aibot_msg_callback') {
        if (ready) onMessage(frame.body, (stream, content, finish) => request('aibot_respond_msg', { msgtype: 'stream', stream: { id: stream, content, finish } }, id));
      } else if (frame.cmd === 'aibot_event_callback') {
        if (frame.body?.event?.eventtype === 'disconnected_event') {
          stopped = true; onStatus('error', '同一个机器人已在别处连接。关闭重复连接后，再点重新连接。'); ws.terminate();
        }
      } else if (typeof frame.errcode === 'number') {
        pending.get(id)?.(frame.errcode ? Object.assign(Error('企业微信返回错误 ' + frame.errcode), {code:frame.errcode}) : null);
      }
    });
    ws.on('error', () => { reason = '连接失败，请检查网络和企业微信长连接权限。'; });
    ws.on('close', () => {
      clearInterval(interval);
      for (const finish of pending.values()) finish(Error('企业微信连接已断开'));
      if (stopped) return;
      onStatus('reconnecting', reason || '连接中断，正在重新连接。');
      retry = setTimeout(open, Math.min(30000, 1000 * 2 ** Math.min(attempts++, 5))); retry.unref();
    });
  }
  open();
  return { close() { stopped = true; clearTimeout(retry); clearInterval(interval); socket?.terminate(); } };
}
module.exports = { connectWecom };
