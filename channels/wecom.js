const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { connectWecom } = require('./wecom-socket');

function read(file, defaults) {
  try { return { ...defaults, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; }
  catch (error) { if (error.code === 'ENOENT') return defaults; throw error; }
}
function write(file, value) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
function fitStream(value) {
  const bytes = Buffer.from(value);
  if (bytes.length <= 20480) return value;
  return bytes.subarray(0, 20360).toString('utf8').replace(/\uFFFD$/, '') + '\n\n… 完整结果见面板「对话」。';
}

function createWecom({ dir, panel, canStart, connect = connectWecom }) {
  const configFile = path.join(dir, 'panel-wecom.json');
  const stateFile = path.join(dir, 'panel-wecom-state.json');
  const defaults = { enabled: false, botId: '', secret: '', allowedUsers: [], engine: 'codex', workspaceId: '' };
  let config, saved, socket, generation = 0, phase = 'disabled', lastError = '';
  const starting = new Map(), watches = new Set();

  function reload() {
    config = read(configFile, defaults);
    saved = read(stateFile, { bindings: {}, seen: [], lastMessageAt: 0 });
  }
  reload();
  function status() {
    const { secret, ...visible } = config;
    return { config: { ...visible, hasSecret: !!secret }, phase, lastError, lastMessageAt: saved.lastMessageAt };
  }
  function stop() {
    generation++;
    socket?.close();
    socket = null;
    for (const cancel of watches) cancel();
    starting.clear();
    phase = 'disabled';
    lastError = '';
  }
  function start() {
    if (socket || !config.enabled || !canStart()) return;
    const epoch = ++generation;
    socket = connect({
      botId: config.botId, secret: config.secret,
      onStatus(next, message) {
        if (epoch === generation) { phase = next; lastError = message; }
      },
      onMessage(body, reply) {
        receive(body, reply, epoch).catch(() => {
          if (epoch === generation) lastError = '消息处理或回复失败，请在面板「对话」核对本轮结果。';
        });
      },
    });
  }
  function configure(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('企业微信配置无效');
    const next = { ...config };
    for (const key of ['botId', 'secret', 'workspaceId']) {
      if (input[key] !== undefined && typeof input[key] !== 'string') throw Error('企业微信配置字段无效');
    }
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== 'boolean') throw Error('启用状态无效');
      next.enabled = input.enabled;
    }
    if (input.botId !== undefined) next.botId = input.botId.trim();
    if (next.botId !== config.botId) next.secret = '';
    if (input.secret?.trim()) next.secret = input.secret.trim();
    if (input.allowedUsers !== undefined) {
      const ids = input.allowedUsers;
      if (!Array.isArray(ids) || ids.length > 500 || ids.some(id => typeof id !== 'string' || !id.trim() || id.trim() === '*' || id.length > 128)) throw Error('请填写具体的成员 UserID');
      next.allowedUsers = [...new Set(ids.map(id => id.trim()))];
    }
    if (input.engine !== undefined) {
      if (!['claude', 'codex'].includes(input.engine)) throw Error('请选择 Claude Code 或 Codex');
      next.engine = input.engine;
    }
    if (input.workspaceId !== undefined) {
      next.workspaceId = input.workspaceId.trim();
      if (next.workspaceId) panel.validateWorkspace?.(next.workspaceId);
    }
    if (next.enabled && (!next.botId || !next.secret)) throw Error('请填写智能机器人的 Bot ID 和 Secret');
    if (next.botId.length > 256 || next.secret.length > 2048) throw Error('机器人凭据过长');
    const reconnect = next.botId !== config.botId || next.secret !== config.secret || next.enabled !== config.enabled || phase === 'error';
    write(configFile, next);
    if (reconnect) stop();
    config = next;
    start();
    return status();
  }

  function observe(sessionId, messageId, authorized, answer) {
    let content = '', done = false, unwatch, delivery = Promise.resolve();
    // Serialize frames with the same callback request ID, including permission and terminal events.
    function send(text, finish) {
      delivery = delivery.then(() => authorized() && answer(text, finish)).catch(() => {
        if (authorized()) lastError = '回复投递失败，完整记录请查看面板「对话」。';
      });
    }
    function cancel() { done = true; unwatch?.(); watches.delete(cancel); }
    watches.add(cancel);
    try {
      unwatch = panel.watch(sessionId, (event, data = {}) => {
        if (done || (data.messageId !== messageId && !(event === 'end' || (event === 'stopped' && !data.messageId)))) return;
        if (!authorized()) { cancel(); return; }
        if (event === 'text') content += data.text || '';
        if (event === 'permission') send('任务正在等待工具授权，请打开面板「对话」处理。', false);
        if (!['done', 'error', 'stopped', 'end'].includes(event)) return;
        cancel();
        let result = content || '任务已完成。';
        if (event === 'error' || data.isError) result = '执行失败。' + (data.error || '请打开面板查看详情。');
        else if (event === 'stopped' || data.interrupted) result = '本轮已停止。';
        else if (event === 'end') result = '会话连接已结束，请打开面板核对结果。';
        send(result, true);
      });
      if (done) unwatch?.(); // A completed turn may replay synchronously.
    } catch (error) { cancel(); throw error; }
  }

  async function receive(body, reply, epoch) {
    const current = () => epoch === generation && canStart() && config.enabled;
    if (!current() || body?.aibotid !== config.botId || typeof body.msgid !== 'string' || !body.msgid) return;
    const user = body.from?.userid, group = body.chattype === 'group';
    if (typeof user !== 'string' || !user || !['single', 'group'].includes(body.chattype) || (group && !body.chatid)) return;
    const authorized = () => current() && config.allowedUsers.includes(user);
    const stream = randomUUID(), answer = (text, finish = true) => reply(stream, fitStream(text), finish);
    if (!authorized()) {
      if (!group) await answer('你的企业微信 UserID 是 ' + user + '。请让面板管理员在「聊天软件 → 企业微信」添加这个成员。');
      return;
    }

    const key = JSON.stringify([config.botId, group ? body.chatid : null, user]);
    const msgKey = JSON.stringify([config.botId, body.msgid]);
    if (saved.seen.includes(msgKey)) return;
    // Reserve the callback before the first await. Redelivery must not run a second agent.
    const updated = { ...saved, seen: [...saved.seen.slice(-2047), msgKey], lastMessageAt: Date.now() };
    write(stateFile, updated);
    saved = updated;
    const prompt = body.msgtype === 'text' && typeof body.text?.content === 'string' ? body.text.content.trim() : '';
    if (!prompt) return answer('目前支持文字消息，请发送文字描述任务。');
    if (prompt === '/whoami') return answer('你的企业微信 UserID 是 ' + user + '。');
    if (prompt === '/help') return answer('直接发文字继续当前对话。/new 开始新对话，/whoami 查看成员 ID。');

    // Order concurrent binding creation and /new for this member and chat.
    const previous = starting.get(key) || Promise.resolve();
    const run = previous.catch(() => {}).then(async () => {
      if (!authorized()) return;
      if (prompt === '/new') {
        delete saved.bindings[key];
        write(stateFile, saved);
        return answer('下一条消息将开始新对话。');
      }
      await answer('正在处理…', false);
      if (!authorized()) return;
      const messageId = randomUUID(), binding = saved.bindings[key], engine = binding?.engine || config.engine;
      let session;
      try {
        session = await panel.submit({ sessionId: binding?.id, engine, workspaceId: binding ? undefined : config.workspaceId || undefined, prompt, messageId, mode: 'queue' });
      } catch (error) { if (authorized()) await answer('任务未能启动。' + error.message); return; }
      if (!current()) return;
      saved.bindings[key] = { id: session.sessionId, engine };
      write(stateFile, saved);
      observe(session.sessionId, messageId, authorized, answer);
    });
    starting.set(key, run);
    try { await run; } finally { if (starting.get(key) === run) starting.delete(key); }
  }
  return { status, start, stop, reload, configure };
}

module.exports = { createWecom };
