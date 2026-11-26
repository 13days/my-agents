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
function fitStream(value, limit = 20480) {
  const bytes = Buffer.from(value);
  if (bytes.length <= limit) return value;
  const suffix = '\n\n… 完整结果见面板「对话」。';
  return bytes.subarray(0, limit - Buffer.byteLength(suffix)).toString('utf8').replace(/\uFFFD$/, '') + suffix;
}

function createWecom({ dir, panel, canStart, connect = connectWecom }) {
  const configFile = path.join(dir, 'panel-wecom.json');
  const stateFile = path.join(dir, 'panel-wecom-state.json');
  const defaults = { enabled: false, botId: '', secret: '', allowedUsers: [], engine: 'codex', workspaceId: '' };
  let config, saved, socket, generation = 0, phase = 'disabled', lastError = '';
  const starting = new Map(), watches = new Set();

  function reload() {
    config = read(configFile, defaults);
    saved = read(stateFile, { bindings: {}, seen: [], owners: {}, activity: {}, lastMessageAt: 0 });
  }
  reload();
  function persist(next) { write(stateFile, next); saved = next; }
  function owner() { return Object.hasOwn(saved.owners, config.botId) ? saved.owners[config.botId] : ''; }
  function status() {
    const { secret, ...visible } = config;
    const recent = Object.hasOwn(saved.activity, config.botId) && saved.activity[config.botId];
    const activity = recent ? { receivedAt: recent.receivedAt, chatType: recent.chatType, stage: recent.stage, errorCode: recent.errorCode } : null;
    const hasHistory = !activity && saved.seen.some(key => JSON.parse(key)[0] === config.botId);
    return { config: { ...visible, hasSecret: !!secret }, phase, lastError, ownerUserId: owner(), activity,
      lastMessageAt: activity?.receivedAt || (hasHistory ? saved.lastMessageAt : 0) };
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
    if (!owner()) {
      const users = new Set(Object.keys(saved.bindings).map(key => JSON.parse(key)).filter(([id]) => id === config.botId).map(([, , user]) => user));
      if (users.size === 1) persist({ ...saved, owners: { ...saved.owners, [config.botId]: [...users][0] } });
    }
    const epoch = ++generation;
    socket = connect({
      botId: config.botId, secret: config.secret,
      onStatus(next, message) {
        if (epoch === generation) { phase = next; lastError = message; }
      },
      onEnter(body, welcome) {
        if (epoch !== generation || !canStart() || body.aibotid !== config.botId || body.chattype === 'group' || !body.from?.userid) return;
        welcome('欢迎使用 my-agents。发送 /whoami 查看身份，直接发文字开始对话。').catch(() => {
          if (epoch === generation) lastError = '欢迎语投递失败，请直接私聊发送 /whoami 测试连接。';
        });
      },
      onMessage(body, reply, sendToChat) {
        receive(body, reply, sendToChat, epoch).catch(() => {
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

  async function receive(body, reply, sendToChat, epoch) {
    const current = () => epoch === generation && canStart() && config.enabled;
    if (!current() || body?.aibotid !== config.botId || typeof body.msgid !== 'string' || !body.msgid) return;
    const user = body.from?.userid, group = body.chattype === 'group';
    if (typeof user !== 'string' || !user.trim() || !['single', 'group'].includes(body.chattype) || (group && (typeof body.chatid !== 'string' || !body.chatid))) return;
    if (!['text', 'voice', 'image', 'file', 'video', 'mixed'].includes(body.msgtype)) return;
    if (body.msgtype === 'text' && (typeof body.text?.content !== 'string' || !body.text.content.trim())) return;
    const botId = config.botId, stream = randomUUID();
    const authorized = () => current() && (user === owner() || config.allowedUsers.includes(user));
    const key = JSON.stringify([config.botId, group ? body.chatid : null, user]);
    const msgKey = JSON.stringify([config.botId, body.msgid]);
    if (saved.seen.includes(msgKey)) return;
    // Reserve the callback before the first await. Redelivery must not run a second agent.
    const receivedAt = Date.now();
    const recent = { msgKey, receivedAt, chatType: body.chattype, stage: 'received' };
    persist({ ...saved, owners: owner() ? saved.owners : { ...saved.owners, [botId]: user },
      activity: { ...saved.activity, [botId]: recent }, seen: [...saved.seen.slice(-2047), msgKey], lastMessageAt: receivedAt });
    function record(stage, error) {
      if (current() && saved.activity[botId]?.msgKey === msgKey) {
        persist({ ...saved, activity: { ...saved.activity, [botId]: { ...recent, stage, errorCode: Number.isInteger(error?.code) ? error.code : undefined } } });
      }
    }
    async function answer(text, finish = true) {
      try {
        const content = fitStream(text);
        try { await reply(stream, content, finish); }
        catch (error) {
          // Only a definite rejection permits sending a separate reply. A timeout may have delivered.
          if (!finish || !Number.isInteger(error.code) || !authorized() || !sendToChat) throw error;
          await sendToChat(group ? body.chatid : user, fitStream(text, 4096));
        }
        if (finish && authorized()) record('replied');
      } catch (error) { record('reply_failed', error); throw error; }
    }
    if (!authorized()) {
      record('restricted');
      if (!group) await answer('你的企业微信 UserID 是 ' + user + '。请让面板管理员在「聊天软件 → 企业微信」添加这个成员。');
      return;
    }
    const prompt = body.msgtype === 'text' && typeof body.text?.content === 'string' ? body.text.content.trim() : '';
    if (!prompt) return answer('目前支持文字消息，请发送文字描述任务。');
    if (prompt === '/whoami') return answer('你的企业微信 UserID 是 ' + user + '。' + (user === owner() ? '你是此机器人的 Owner。' : '你是已授权成员。'));
    if (prompt === '/help') return answer('直接发文字继续当前对话。/new 开始新对话，/whoami 查看成员 ID。');

    // Order concurrent binding creation and /new for this member and chat.
    const receipt = prompt === '/new' ? Promise.resolve() : answer('正在处理…', false).catch(() => {});
    const previous = starting.get(key) || Promise.resolve();
    const run = previous.catch(() => {}).then(async () => {
      if (!authorized()) return;
      if (prompt === '/new') {
        delete saved.bindings[key];
        write(stateFile, saved);
        return answer('下一条消息将开始新对话。');
      }
      await receipt;
      if (!authorized()) return;
      const messageId = randomUUID(), binding = saved.bindings[key], engine = binding?.engine || config.engine;
      let session;
      try {
        session = await panel.submit({ sessionId: binding?.id, engine, workspaceId: binding ? undefined : config.workspaceId || undefined, prompt, messageId, mode: 'queue' });
      } catch (error) { if (authorized()) await answer('任务未能启动。' + error.message); return; }
      if (!current()) return;
      saved.bindings[key] = { id: session.sessionId, engine };
      write(stateFile, saved);
      record('submitted');
      observe(session.sessionId, messageId, authorized, answer);
    });
    starting.set(key, run);
    try { await run; } finally { if (starting.get(key) === run) starting.delete(key); }
  }
  return { status, start, stop, reload, configure };
}

module.exports = { createWecom };
