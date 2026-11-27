const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { searchSessions } = require('../core/session-directory');
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
  const defaults = { enabled: false, botId: '', secret: '', allowedUsers: [], engine: 'codex', workspaceId: '', machineId: '', cwd: '', model: '', worktree: false, ownerSessionCatalog: false };
  let config, saved, socket, generation = 0, phase = 'disabled', lastError = '';
  let saving = Promise.resolve();
  const starting = new Map(), watches = new Set(), choices = new Map();

  function reload() {
    config = read(configFile, defaults);
    saved = read(stateFile, { bindings: {}, recent: {}, seen: [], owners: {}, activity: {}, receipts: {}, lastMessageAt: 0 });
  }
  reload();
  function persist(next) { write(stateFile, next); saved = next; }
  function historyFor(key) {
    const current = saved.bindings[key], recent = saved.recent[key] || [];
    return current && !recent.some(row => row.id === current.id) ? [current, ...recent] : recent;
  }
  function remember(key, binding) {
    const recent = [binding, ...historyFor(key).filter(row => row.id !== binding.id)].slice(0, 30);
    persist({ ...saved, bindings: { ...saved.bindings, [key]: binding }, recent: { ...saved.recent, [key]: recent } });
  }
  function label(row) {
    const engine = panel.engines?.().find(item => item.id === row.engine)?.label || row.engine;
    return [row.title || '未命名会话', engine, row.machineId && (panel.machineLabel?.(row.machineId) || row.machineId)].filter(Boolean).join(' · ');
  }
  function owner() { return Object.hasOwn(saved.owners, config.botId) ? saved.owners[config.botId] : ''; }
  function status() {
    const { secret, ...visible } = config;
    const recent = Object.hasOwn(saved.activity, config.botId) && saved.activity[config.botId];
    const clean = ({ receivedAt, chatType, sender, stage, machineId, engine, errorCode }) => ({ receivedAt, chatType, sender, stage, machineId, engine, errorCode });
    const activity = recent ? clean(recent) : null;
    const receipts = Object.hasOwn(saved.receipts, config.botId) ? saved.receipts[config.botId].map(clean) : activity ? [activity] : [];
    const hasHistory = !activity && saved.seen.some(key => JSON.parse(key)[0] === config.botId);
    return { receiver: panel.machineId?.(), defaultMachine: panel.defaultMachine?.(), receipts, engines: panel.engines?.(), config: { ...visible, hasSecret: !!secret }, phase, lastError, ownerUserId: owner(), activity,
      lastMessageAt: activity?.receivedAt || (hasHistory ? saved.lastMessageAt : 0) };
  }
  function stop() {
    generation++;
    socket?.close();
    socket = null;
    for (const cancel of watches) cancel();
    starting.clear(); choices.clear();
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
        welcome('欢迎使用 my-agents。发文字或语音开始对话，发送 /sessions 找回会话，/help 查看用法。').catch(() => {
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
    const pending = saving.then(() => saveConfig(input));
    saving = pending.catch(() => {});
    return pending;
  }
  async function saveConfig(input) {
    const epoch = generation;
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('企业微信配置无效');
    const next = { ...config };
    for (const key of ['botId', 'secret', 'workspaceId', 'machineId', 'cwd', 'model']) {
      if (input[key] !== undefined && typeof input[key] !== 'string') throw Error('企业微信配置字段无效');
    }
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== 'boolean') throw Error('启用状态无效');
      next.enabled = input.enabled;
    }
    if (input.botId !== undefined) next.botId = input.botId.trim();
    if (next.botId !== config.botId) { next.secret = ''; next.ownerSessionCatalog = false; }
    if (input.secret?.trim()) next.secret = input.secret.trim();
    if (input.allowedUsers !== undefined) {
      const ids = input.allowedUsers;
      if (!Array.isArray(ids) || ids.length > 500 || ids.some(id => typeof id !== 'string' || !id.trim() || id.trim() === '*' || id.length > 128)) throw Error('请填写具体的成员 UserID');
      next.allowedUsers = [...new Set(ids.map(id => id.trim()))];
    }
    if (input.ownerSessionCatalog !== undefined) {
      if (typeof input.ownerSessionCatalog !== 'boolean') throw Error('Owner 会话访问设置无效');
      if (input.ownerSessionCatalog && (next.botId !== config.botId || !owner())) throw Error('请先连接机器人，并确认首位发消息的 Owner 后再开启会话访问');
      next.ownerSessionCatalog = input.ownerSessionCatalog;
    }
    if (input.engine !== undefined) {
      if (!(panel.engines?.().map(item => item.id) || ['claude', 'codex']).includes(input.engine)) throw Error('请选择已接入的引擎');
      next.engine = input.engine;
    }
    for (const key of ['workspaceId', 'machineId', 'cwd', 'model']) if (input[key] !== undefined) next[key] = input[key].trim();
    if (input.worktree !== undefined) {
      if (typeof input.worktree !== 'boolean') throw Error('独立工作区设置无效');
      next.worktree = input.worktree;
    }
    if (next.cwd && (next.workspaceId || !next.machineId || /[\0\r\n]/.test(next.cwd) || next.cwd.length > 4096)) throw Error('请为自定义目录指定一台执行机器，并清除项目映射');
    const targetChanged = ['workspaceId', 'machineId', 'cwd'].some(key => next[key] !== config[key]);
    if (targetChanged) {
      const resolved = await panel.validateTarget({machineId: next.machineId, workspaceId: next.workspaceId, cwd: next.cwd});
      if (next.cwd) next.cwd = resolved.cwd;
    }
    if (next.model && (next.model !== config.model || next.machineId !== config.machineId || next.engine !== config.engine)) {
      const catalog = await panel.models({engine: next.engine, machineId: next.machineId, refresh: true});
      if (!catalog.models.some(item => item.id === next.model)) throw Error('所选执行机器和引擎当前无法使用这个模型，请重新选择');
    }
    if (epoch !== generation) throw Error('机器人连接已变化，请刷新后重试');
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
    const recent = { msgKey, receivedAt, chatType: body.chattype, sender: user, stage: 'received' };
    const prior = Object.hasOwn(saved.receipts, botId) ? saved.receipts[botId] : [];
    const receipts = { ...saved.receipts, [botId]: [recent, ...prior].slice(0, 30) };
    persist({ ...saved, owners: owner() ? saved.owners : { ...saved.owners, [botId]: user },
      activity: { ...saved.activity, [botId]: recent }, receipts, seen: [...saved.seen.slice(-2047), msgKey], lastMessageAt: receivedAt });
    function record(stage, error) {
      if (!current() || !saved.receipts[botId]?.some(row => row.msgKey === msgKey)) return;
      const updated = { ...recent, stage, errorCode: Number.isInteger(error?.code) ? error.code : undefined };
      const latest = saved.activity[botId]?.msgKey === msgKey;
      persist({ ...saved, activity: latest ? { ...saved.activity, [botId]: updated } : saved.activity,
        receipts: { ...saved.receipts, [botId]: saved.receipts[botId].map(row => row.msgKey === msgKey ? updated : row) } });
    }
    async function answer(text, finish = true, footer = '') {
      try {
        const frame = limit => fitStream(text, limit - Buffer.byteLength(footer)) + footer;
        const content = frame(20480);
        try { await reply(stream, content, finish); }
        catch (error) {
          // Only a definite rejection permits sending a separate reply. A timeout may have delivered.
          if (!finish || !Number.isInteger(error.code) || !authorized() || !sendToChat) throw error;
          await sendToChat(group ? body.chatid : user, frame(4096));
        }
        if (finish && authorized()) record('replied');
      } catch (error) { record('reply_failed', error); throw error; }
    }
    if (!authorized()) {
      record('restricted');
      if (!group) await answer('你的企业微信 UserID 是 ' + user + '。请让面板管理员在「聊天软件 → 企业微信」添加这个成员。');
      return;
    }
    const source = body.msgtype === 'voice' ? body.voice?.content : body.text?.content;
    const text = ['text', 'voice'].includes(body.msgtype) && typeof source === 'string' ? source.trim() : '';
    if (!text) return answer(body.msgtype === 'voice' ? '这条语音没有可用的转写，请再说一次或发送文字。' : '请发送文字或语音描述任务。');
    const command = body.msgtype === 'text' && text.match(/^\/(sessions|use|status|new|help|whoami)(?:\s+([\s\S]*))?$/i);
    const action = command ? command[1].toLowerCase() : '', arg = command?.[2]?.trim() || '';
    if (action === 'whoami') return answer('你的企业微信 UserID 是 ' + user + '。' + (user === owner() ? '你是此机器人的 Owner。' : '你是已授权成员。'));
    if (action === 'help') return answer('直接发文字或语音继续对话，也可以引用一条消息再提问。\n/sessions [关键词] 找回会话\n/use 1 切换到最近列表的第 1 条\n/status 查看当前会话和执行状态\n/new [任务] 开始新对话\n/whoami 查看成员身份');
    const allowCatalog = () => !group && user === owner() && config.ownerSessionCatalog;
    const visible = row => !row.external || allowCatalog();
    const prompt = action === 'new' ? arg : text;
    const quote = body.quote;
    const quotedText = ['text', 'voice'].includes(quote?.msgtype) ? quote[quote.msgtype]?.content : null;
    const context = typeof quotedText === 'string' && quotedText.trim()
      ? '用户在企业微信中引用了以下消息作为本次提问的背景：\n' + quotedText.trim().slice(0, 8000) : undefined;

    // Serialize the displayed list, selections and submissions for this member in this chat.
    const startsTurn = !action || (action === 'new' && arg);
    const receipt = startsTurn || action === 'sessions' ? answer(startsTurn ? '正在处理…' : '正在查找会话…', false).catch(() => {}) : Promise.resolve();
    const previous = starting.get(key) || Promise.resolve();
    const run = previous.catch(() => {}).then(async () => {
      await receipt;
      if (!authorized()) return;
      const binding = saved.bindings[key];
      if (action === 'sessions') {
        choices.delete(key);
        const recent = historyFor(key).filter(visible);
        const rows = new Map(searchSessions(recent, arg).map(row => [row.id, row]));
        let partial = false;
        if (allowCatalog()) {
          try {
            const result = await panel.sessionCatalog({ query: arg });
            if (!authorized() || !allowCatalog()) return;
            partial = !!result.unavailable.length;
            for (const item of result.sessions) {
              if (item.sourceUnavailable || rows.has(item.id)) continue;
              const known = recent.find(row => row.id === item.id);
              rows.set(item.id, { id: item.id, engine: item.engine, machineId: item.machineId,
                title: String(item.title || item.latestPrompt || item.project || '未命名会话').replace(/\s+/g, ' ').slice(0, 72),
                last: item.last, running: item.running, external: known ? !!known.external : true });
            }
          } catch { partial = true; }
        }
        if (!authorized()) return;
        const matches = searchSessions([...rows.values()].filter(visible)), list = matches.slice(0, 8);
        choices.set(key, list);
        const lines = list.map((row, i) => (i + 1) + '. ' + label(row) + (row.id === binding?.id ? '（当前）' : ''));
        if (list.length) lines.push('发送 /use 序号 切换。' + (matches.length > list.length ? '用 /sessions 关键词 缩小范围。' : ''));
        else lines.push(arg ? '没有匹配的会话，可以换个关键词。' : '这里还没有会话，直接发送任务即可开始。');
        if (partial) lines.push('部分电脑的会话暂时无法读取。');
        return answer(lines.join('\n'));
      }
      if (action === 'use') {
        const selected = /^[1-8]$/.test(arg) && choices.get(key)?.[Number(arg) - 1];
        if (!selected || !visible(selected)) return answer('请先发 /sessions，再发送列表中的序号，例如 /use 1。');
        const selection = { id: selected.id, engine: selected.engine, title: selected.title, machineId: selected.machineId, last: selected.last, model: selected.model, external: !!selected.external };
        if (selected.external) {
          try {
            const catalog = await panel.sessionCatalog({ query: selected.id });
            const item = catalog.sessions.find(row => row.id === selected.id && !row.sourceUnavailable);
            if (!authorized() || !visible(selected)) return;
            const resolved = item && await panel.resolveSession(item.id, item);
            if (!resolved) throw Error();
            selection.engine = resolved.engine;
            selection.machineId = resolved.machineId;
          } catch { if (authorized()) return answer('这条会话暂时无法接续，请检查原执行机器，或重新发送 /sessions。'); return; }
        }
        if (!authorized() || !visible(selected)) return;
        remember(key, selection);
        return answer('已切换到 ' + label(selection) + '。下一条消息将在这条会话中继续。');
      }
      if (action === 'status') {
        if (!binding || !visible(binding)) return answer('当前没有可用会话。直接发送任务，或发 /sessions 选择一条。');
        const state = panel.sessionStatus(binding.id);
        return answer('当前会话：' + label(binding) + '\n执行状态：' + state);
      }
      if (action === 'new' && !arg) {
        if (binding) {
          const recent = historyFor(key);
          const bindings = { ...saved.bindings }; delete bindings[key];
          persist({ ...saved, bindings, recent: { ...saved.recent, [key]: recent } });
        }
        return answer('下一条消息将开始新对话。');
      }
      const target = action === 'new' ? null : binding;
      if (target && !visible(target)) return answer('当前会话的访问已关闭。发送 /new 开始新对话，或发 /sessions 选择其他会话。');
      const messageId = randomUUID(), engine = target?.engine || config.engine;
      const model = target ? target.model : config.model;
      let session;
      try {
        const defaults = target ? {} : {
          machineId: config.machineId || undefined, cwd: config.cwd || undefined, workspaceId: config.workspaceId || undefined,
          worktree: config.worktree,
        };
        session = await panel.submit({ ...defaults, model: model || undefined, sessionId: target?.id, engine, prompt, gatewayContext: context, messageId, mode: 'queue' });
      } catch (error) { if (authorized()) await answer('任务未能启动。' + error.message); return; }
      if (!authorized() || (target && !visible(target))) return;
      recent.machineId = session.machineId;
      recent.engine = session.engine || engine;
      remember(key, { id: session.sessionId, engine: recent.engine, machineId: session.machineId || target?.machineId,
        model, title: target?.title || prompt.replace(/\s+/g, ' ').slice(0, 72), last: Date.now(), external: !!target?.external });
      record('submitted');
      const engineLabel = panel.engines?.().find(item => item.id === recent.engine)?.label || recent.engine;
      const footer = session.machineId ? '\n\n执行机器：' + (panel.machineLabel?.(session.machineId) || session.machineId) + ' · ' + engineLabel : '';
      observe(session.sessionId, messageId, () => authorized() && (!target || visible(target)), (text, finished) => answer(text, finished, finished ? footer : ''));
    });
    starting.set(key, run);
    try { await run; } finally { if (starting.get(key) === run) starting.delete(key); }
  }
  return { status, start, stop, reload, configure, models: input => panel.models(input) };
}

module.exports = { createWecom };
