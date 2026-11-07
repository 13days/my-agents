const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const cards = require('./feishu-cards');
const { createSimpleReply } = require('./feishu-simple-reply');
const { sendMarkdown } = require('./feishu-markdown');
const { createFeishuInbox } = require('./feishu-inbox');
const { commandText } = require('./feishu-commands');
const { engineCatalog } = require('./channels/engine-catalog');

// The help text lists whichever engines the panel has registered.
function helpText(engines) {
  const ids = engines.ids();
  return [
    '/sessions [关键词] 查看会话卡片', '/switch 序号、ID前缀或名称 切换会话', '/projects 查看项目',
    `/new [${ids.join('|')}] [项目序号或路径] 选择引擎新建，省略时使用默认引擎；路径支持本机已有目录及 ~/`,
    ...engines.list.map(engine => `/${engine.id} [问题] 切到 ${engine.label}，可直接带问题`),
    '/use 引擎 切换引擎（支持别名）', '/engine 查看当前引擎和切换选项', '/current 查看当前位置的绑定会话', '/history 查看最近对话',
    '/rename 新名称 固定会话名称', '/queue 内容 排队处理', '/steer 内容 立即引导', '/stop 停止当前任务',
    '/route 代理路由：/route 序号切账号、auto 故障转移、rr 轮询、reset 清除冷却、pin 序号|off 固定当前会话、codex direct|proxy',
    '/status 网关状态', '/ask 内容 将内容作为正文发给当前引擎',
  ].join('\n');
}
const clip = (text, size) => Array.from(String(text || '')).slice(0, size).join('');
const threadOf = msg => msg.chatType === 'p2p' ? '' : msg.threadId || msg.raw?.message?.thread_id || msg.raw?.event?.message?.thread_id || '';
const contextKey = msg => JSON.stringify([msg.chatType === 'p2p' ? msg.senderId : '*', msg.chatId, threadOf(msg) || 'main']);
const contextLabel = msg => msg.chatType === 'p2p' ? '当前私聊' : threadOf(msg) ? '当前话题' : '当前群聊';
const messageUUID = id => { const hex = crypto.createHash('sha256').update(id).digest('hex'); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`; };
function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, file); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
function load(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw new Error('飞书本地配置损坏，请检查 ' + path.basename(file)); } }

function errorMessage(value, seen = new Set()) {
  if (typeof value === 'string') return (value.includes('[object Object]') || /^(?:error|warn)$/i.test(value.trim())) ? '' : value;
  if (!value || typeof value !== 'object' || seen.has(value)) return '';
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => errorMessage(item, seen)).filter(Boolean).join(' · ');
  for (const detail of [value.response?.data?.msg, value.msg, value.message, value.error, value.err, value.reason]) { const text = errorMessage(detail, seen); if (text) return text; }
  return typeof value.code === 'string' || typeof value.code === 'number' ? '飞书请求失败（' + value.code + '）' : '';
}

function createFeishuGateway({ dir, panel, runtime, channelFactory, replyURL = '', now = Date.now }) {
  const configFile = path.join(dir, 'panel-feishu.json'), stateFile = path.join(dir, 'panel-feishu-state.json');
  const inbox = createFeishuInbox(dir);
  const defaults = { allowAllUsers: false, allowAllGroups: false, enabled: false, appId: '', appSecret: '', domain: 'feishu', allowedUserIds: [], disabledUserIds: [], allowedChatIds: [], defaultProject: '', defaultEngine: 'claude', model: '', keepAwake: false };
  let config = defaults, state = { bindings: {}, engineBindings: {}, cards: {}, listings: {}, receipts: [], projects: [] }, phase = 'disabled', lastError = '', channel = null, connecting = null, pairing = null;
  try { config = { ...defaults, ...load(configFile, {}) }; state = { ...state, ...load(stateFile, {}) }; }
  catch (e) { lastError = e.message; phase = 'error'; }
  // Engines come from the panel registry; unknown defaults fall back at use time.
  const catalog = () => engineCatalog(panel.engines?.());
  const defaultEngine = () => catalog().fallback(config.defaultEngine, 'claude');
  // `config.model` predates per-engine models and always meant the Claude model.
  const modelFor = engine => config.models?.[engine] ?? (engine === 'claude' ? config.model : '');
  const locks = new Map(), inFlight = new Set(), monitors = new Set(), pairAttempts = new Map();
  const replyTargets = new Map();
  const contacts = require('./feishu-contacts').createContactDirectory({ inbox, getChannel: () => channel, getAppId: () => config.appId, now });
  const persist = () => { state.receipts = state.receipts.slice(-2000); const keys = Object.keys(state.cards); for (const key of keys.slice(0, Math.max(0, keys.length - 1000))) delete state.cards[key]; atomic(stateFile, state); };
  const errorText = e => clip((errorMessage(e) || '飞书请求失败，请查看本机服务日志').split(config.appSecret || '\0').join('[secret]'), 600);
  const rememberError = e => { lastError = errorText(e); };
  const allowed = msg => !config.disabledUserIds.includes(msg.senderId) && (msg.chatType === 'p2p' ? config.allowAllUsers || config.allowedUserIds.includes(msg.senderId) : config.allowAllGroups || config.allowedChatIds.includes(msg.chatId));
  const detailed = msg => msg.chatType === 'p2p' || config.allowedChatIds.includes(msg.chatId);
  const managementNotice = msg => send(msg, { text: '此群使用普通文字回复，处理时显示思考表情。请在 Mac 面板逐项授权此群后使用会话管理功能。/new 在默认项目新建会话；/stop 停止当前任务。' });
  const scope = msg => {
    const key = contextKey(msg);
    // Migrate only this exact conversation, never inherit the group's main
    // binding into a topic or treat an ordinary reply as a new conversation.
    const legacy = JSON.stringify([msg.senderId, msg.chatId, threadOf(msg) || 'main']);
    if (!state.bindings[key] && state.bindings[legacy]) { state.bindings[key] = { ...state.bindings[legacy] }; persist(); }
    return key;
  };
  function defaultBinding(msg) {
    const key = scope(msg);
    if (!state.bindings[key] && config.defaultProject) { bind(key, { id: crypto.randomUUID(), cwd: config.defaultProject, engine: defaultEngine() }); }
    return state.bindings[key];
  }
  async function send(msg, content) {
    if (typeof content.text === 'string' || typeof content.markdown === 'string') return sendMarkdown(channel, { ...msg, threadId: threadOf(msg) }, content.markdown ?? content.text);
    return channel.send(msg.chatId, content, { replyTo: msg.messageId, replyInThread: !!threadOf(msg) });
  }
  function cliEnvHint(engine) {
    const meta = catalog().get(engine);
    return meta?.cliEnv ? `${meta.short || meta.label} 的工具环境提供 ${meta.cliEnv}；必要时运行 "$${meta.cliEnv}" --version 验证。` : '';
  }
  function deliveryContext(msg) {
    if (!replyURL) return '';
    for (const [token, target] of replyTargets) if (target.expires <= now()) replyTargets.delete(token);
    const token = crypto.randomBytes(24).toString('hex');
    replyTargets.set(token, { appId: config.appId, msg: { messageId: msg.messageId, senderId: msg.senderId, chatId: msg.chatId, chatType: msg.chatType, threadId: threadOf(msg), rootId: msg.rootId }, expires: now() + 2 * 60 * 60 * 1000 });
    const binding = state.bindings[scope(msg)], engine = binding ? engineOf(binding) : defaultEngine();
    const cli = panel.engineInfo?.(engine);
    const runtime = cli ? `当前会话由 my-agents 直接启动本机 ${catalog().label(engine)} CLI，实际运行版本为 ${cli.version || '未检测'}，可执行文件为 ${JSON.stringify(cli.path)}。核实当前引擎版本时请以该进程信息为准，不要把 PATH 中其他安装的版本或推测的 SDK 版本当作当前版本。${cliEnvHint(engine)}` : '';
    return `[my-agents 飞书发送上下文，本轮有效]\n${runtime}\n${JSON.stringify({ appId: config.appId, chatId: msg.chatId, chatType: msg.chatType, threadId: threadOf(msg), messageId: msg.messageId, senderId: msg.senderId, detailed: detailed(msg) })}\n这条用户消息来自${contextLabel(msg)}。用户说“发卡片／发给我／回复”且未指定其他接收方时，默认发送到当前 chatId 和当前话题，不是发送人的私聊。每轮以本轮位置为准，不沿用历史接收方或其他机器人。普通文字答复由网关自动发回，并按 Markdown 富文本渲染。\n用户明确要求发送飞书卡片或额外消息时，优先调用当前机器人的本地发送入口：POST ${replyURL}，Content-Type: application/json，JSON 为 {"token":"${token}","card":<飞书 JSON 2.0 卡片对象>} 或 {"token":"${token}","text":"消息正文"}。可先把 JSON 写到临时文件，再用 curl --fail-with-body -sS -H 'Content-Type: application/json' --data-binary @文件路径 '${replyURL}'。text 字段支持 Markdown，网关负责渲染，不要为避免显示标记而删除粗体或代码块。此入口固定使用当前机器人和原消息的位置，并在话题内回复；不能另传接收人。仅在用户要求发送时调用，以返回成功为发送依据；不要在答复中输出 token。简洁显示的群中不主动披露本机目录、分支、会话或详细工具数据。\n[/my-agents 飞书发送上下文]`;
  }
  async function sendReply(input) {
    const target = typeof input?.token === 'string' && replyTargets.get(input.token);
    if (!target || target.expires <= now() || target.appId !== config.appId) throw new Error('发送上下文已过期，请从原对话重新发起请求');
    if (!channel || !config.enabled || !allowed(target.msg)) throw new Error('原对话当前未获准发送');
    if (['chatId', 'receive_id', 'threadId', 'appId'].some(key => key in input)) throw new Error('发送目标由原消息固定，不能覆盖');
    if (!!input.card === (typeof input.text === 'string')) throw new Error('请提供 card 或 text 中的一项');
    if (input.card && (typeof input.card !== 'object' || Array.isArray(input.card) || input.card.schema !== '2.0')) throw new Error('请提供飞书 JSON 2.0 卡片对象');
    if (Buffer.byteLength(JSON.stringify(input.card || input.text)) > 28000) throw new Error('单条内容过大，请拆分发送');
    const result = await send(target.msg, input.card ? { card: input.card } : { text: input.text });
    return { ok: true, messageId: result?.messageId, chatId: target.msg.chatId, threadId: threadOf(target.msg) };
  }
  async function sendLong(msg, text) {
    return send(msg, { markdown: text || '没有可显示的内容' });
  }
  function rememberCard(result, msg, binding) {
    if (result?.messageId) { state.cards[result.messageId] = { ...(binding ? { sessionId: binding.id, cwd: binding.cwd } : {}), owner: msg.senderId, chatId: msg.chatId, chatType: msg.chatType, key: contextKey(msg), threadId: threadOf(msg) }; persist(); }
  }
  function session(id) { return panel.sessions().find(item => item.id === id); }
  function engineOf(binding) { return catalog().fallback(session(binding.id)?.engine || binding.engine || panel.engine?.(binding.id), 'claude'); }
  function bindingFor(item) { return { id: item.id, cwd: item.project, engine: engineOf(item) }; }
  function rememberEngine(key, binding) {
    if (!binding) return;
    const engine = engineOf(binding); (state.engineBindings[key] ||= {})[engine] = { ...binding, engine };
  }
  function bind(key, binding) {
    rememberEngine(key, state.bindings[key]);
    binding.engine = engineOf(binding); state.bindings[key] = binding; rememberEngine(key, binding); persist(); return binding;
  }
  async function useEngine(msg, engine, prompt = '') {
    const key = scope(msg), current = state.bindings[key];
    if (!current || engineOf(current) !== engine) {
      rememberEngine(key, current);
      const cached = state.engineBindings[key]?.[engine];
      const saved = cached && session(cached.id) ? cached : null;
      const cwd = saved?.cwd || current?.cwd || config.defaultProject;
      if (!cwd || !projects().includes(cwd)) return projectsCard(msg, 0, engine);
      bind(key, saved && projects().includes(saved.cwd) ? { ...saved } : { id: crypto.randomUUID(), cwd, engine });
    }
    return prompt ? run(msg, prompt, 'steer') : currentCard(msg, state.bindings[key]);
  }
  const pageOf = (page, total) => Math.max(0, Math.min(Math.max(0, Math.ceil(total / cards.PAGE_SIZE) - 1), Math.trunc(Number(page) || 0)));
  async function sessionsCard(msg, query = '', requestedPage = 0) {
    if (!detailed(msg)) return managementNotice(msg);
    const key = contextKey(msg), all = panel.sessions().filter(item => !query || `${item.title} ${item.project}`.toLowerCase().includes(query.toLowerCase()));
    const page = pageOf(requestedPage, all.length), rows = all.slice(page * cards.PAGE_SIZE, (page + 1) * cards.PAGE_SIZE);
    state.listings[key] = all.map(item => item.id); persist();
    const result = await send(msg, { card: cards.sessionList({ engines: catalog(), owner: msg.senderId, key, location: contextLabel(msg), rows: rows.map(item => ({ ...item, running: panel.running(item.id) })), total: all.length, page, query, selected: state.bindings[key]?.id }) });
    rememberCard(result, msg);
  }
  function projects() {
    return [...new Set([config.defaultProject, ...panel.projects(), ...state.projects].filter(Boolean))].filter(folder => { try { return fs.statSync(folder).isDirectory(); } catch { return false; } });
  }
  async function projectsCard(msg, requestedPage = 0, engine = defaultEngine()) {
    if (!detailed(msg)) return managementNotice(msg);
    const all = projects(), page = pageOf(requestedPage, all.length);
    const result = await send(msg, { card: cards.projectList({ owner: msg.senderId, key: contextKey(msg), location: contextLabel(msg), rows: all.slice(page * cards.PAGE_SIZE, (page + 1) * cards.PAGE_SIZE), total: all.length, page, defaultProject: config.defaultProject, engine: catalog().fallback(engine, defaultEngine()), engines: catalog() }) });
    rememberCard(result, msg);
  }
  async function currentCard(msg, binding) {
    if (!detailed(msg)) return send(msg, { text: `${contextLabel(msg)} · ${catalog().label(engineOf(binding))} 已就绪。直接发送消息继续。\n${catalog().switchHint(engineOf(binding))} 切换；各自保留上下文。` });
    const result = await send(msg, { card: cards.currentSession({ engines: catalog(), owner: msg.senderId, key: contextKey(msg), location: contextLabel(msg), binding, item: session(binding.id), running: panel.running(binding.id), requests: panel.pendingPermissions?.(binding.id) || [] }) });
    rememberCard(result, msg, binding);
  }
  async function historyReply(msg, binding) {
    const history = await panel.history(binding.id), assistant = catalog().label(engineOf(binding));
    return sendLong(msg, history.slice(-10).map(item => `**${item.role === 'user' ? '你' : assistant}**\n${item.text || ''}${item.tools?.length ? '\n' + item.tools.map(tool => `🔧 ${tool.name} · ${tool.state}`).join('\n') : ''}`).join('\n\n'));
  }
  async function engineCard(msg) {
    const binding = state.bindings[contextKey(msg)], engine = binding ? engineOf(binding) : defaultEngine();
    if (!detailed(msg)) return send(msg, { text: `${contextLabel(msg)} · ${binding ? '当前' : '默认'}引擎：${catalog().label(engine)}\n${catalog().switchHint(engine)} 切换，可直接带问题。各引擎分别接续上下文；${catalog().ids().map(id => '/new ' + id).join(' 或 ')} 强制新建。其他话题不受影响。` });
    const cwd = binding?.cwd || config.defaultProject;
    const result = await send(msg, { card: cards.enginePicker({ owner: msg.senderId, key: contextKey(msg), location: contextLabel(msg), engine, defaultEngine: defaultEngine(), cwd, engines: catalog() }) });
    rememberCard(result, msg, binding);
  }
  // 路由切换完全在网关内完成，不经过模型：账号挂了也能救回来
  async function routesCard(msg, notice = '') {
    const binding = state.bindings[contextKey(msg)];
    const status = panel.routes(), pinned = binding ? status.pins?.[binding.id] || '' : '';
    const result = await send(msg, { card: cards.routes({ owner: msg.senderId, key: contextKey(msg), status, codex: panel.codex?.(), pinned, notice, now: now() }) });
    rememberCard(result, msg);
  }
  function findAccount(accounts, query) {
    const enabled = accounts.filter(a => a.enabled);
    if (/^\d+$/.test(query)) return accounts[Number(query) - 1];
    const q = query.toLowerCase();
    const matches = enabled.filter(a => a.name.toLowerCase() === q);
    return matches.length === 1 ? matches[0] : enabled.filter(a => a.name.toLowerCase().includes(q)).length === 1 ? enabled.find(a => a.name.toLowerCase().includes(q)) : null;
  }
  async function applyRoute(msg, input) {
    const status = panel.routes(), binding = state.bindings[contextKey(msg)];
    if (input.reset) { panel.resetRoutes(); return '已清除所有账号的冷却状态。'; }
    if (typeof input.codexCapture === 'boolean') { panel.setCodexCapture(input.codexCapture); return input.codexCapture ? 'Codex 已改为经本地代理抓包，下一轮生效。' : 'Codex 已改为直连 OpenAI，下一轮生效。'; }
    if (input.pin !== undefined) {
      if (!binding) throw new Error('当前位置还没有绑定会话');
      if (!catalog().can(engineOf(binding), 'accounts')) throw new Error(`${catalog().label(engineOf(binding))} 会话不走 Claude 账号路由`);
      const account = input.pin ? findAccount(status.accounts, input.pin) : null;
      if (input.pin && !account?.enabled) throw new Error('没有找到可用账号：' + input.pin);
      panel.pinRoute(binding.id, account?.id || '');
      return account ? `当前会话已固定到「${account.name}」，下一条请求生效。` : '当前会话已改为跟随全局路由。';
    }
    if (input.mode) { const result = panel.route({ mode: input.mode }); return `已切换为${cards.MODE_NAMES[input.mode]}。${result.restartRequired ? '（客户端环境变量有变化，外部终端的 Claude 需要重开）' : ''}`; }
    if (input.selected !== undefined) {
      const account = status.accounts.find(a => a.id === input.selected) || findAccount(status.accounts, String(input.selected));
      if (!account) throw new Error('没有找到该账号，发送 /route 查看序号');
      if (!account.enabled) throw new Error(`「${account.name}」已停用，请在 Mac 面板启用`);
      const result = panel.route({ mode: 'manual', selected: account.id });
      return `已切到「${account.name}」（手动），下一条请求生效。${result.restartRequired ? '（客户端环境变量有变化，外部终端的 Claude 需要重开）' : ''}`;
    }
    return '';
  }
  function parseRoute(arg) {
    const [head = '', ...rest] = arg.split(/\s+/).filter(Boolean), tail = rest.join(' '), lower = head.toLowerCase();
    if (!head) return {};
    if (['auto', 'failover', '自动'].includes(lower)) return { mode: 'failover' };
    if (['rr', 'round-robin', 'roundrobin', '轮询'].includes(lower)) return { mode: 'round-robin' };
    if (['reset', 'clear', '清除'].includes(lower)) return { reset: true };
    if (lower === 'pin') return { pin: ['off', 'none', '取消', ''].includes(tail.toLowerCase()) ? '' : tail };
    if (lower === 'codex') {
      if (/^(direct|off|直连)$/i.test(tail)) return { codexCapture: false };
      if (/^(proxy|capture|on|抓包)$/i.test(tail)) return { codexCapture: true };
      throw new Error('用法：/route codex direct 或 /route codex proxy');
    }
    return { selected: arg.trim() };
  }
  async function pair(msg, code) {
    const attempts = pairAttempts.get(msg.senderId) || { count: 0, at: now() };
    if (now() - attempts.at > 60000) { attempts.count = 0; attempts.at = now(); }
    attempts.count++; pairAttempts.set(msg.senderId, attempts);
    const valid = msg.chatType === 'p2p' && attempts.count <= 5 && pairing && pairing.expires > now() && typeof code === 'string' && code.length === pairing.code.length && crypto.timingSafeEqual(Buffer.from(code), Buffer.from(pairing.code));
    if (!valid) { await send(msg, { text: '配对未成功。请在 Mac 面板“飞书网关”生成配对码，再私聊发送 /pair 配对码。' }); return; }
    config.allowedUserIds = [...new Set([...config.allowedUserIds, msg.senderId])]; pairing = null; atomic(configFile, config);
    await send(msg, { text: '配对完成。发送 /sessions 查看会话，/new 选择项目，/help 查看命令。' });
  }
  // 有的引擎（如 Codex）由 CLI 生成会话 ID：提交后改绑到 Panel 返回的真实 ID
  async function submit(binding, input) {
    const engine = engineOf(binding);
    if (binding.engine !== engine) { binding.engine = engine; persist(); }
    const previousId = binding.id;
    const result = await panel.submit({ sessionId: binding.id, cwd: binding.cwd, model: modelFor(engine), engine, ...input });
    if (result?.sessionId && result.sessionId !== binding.id) {
      binding.id = result.sessionId;
      for (const card of Object.values(state.cards)) if (card.sessionId === previousId) { card.originalSessionId ||= previousId; card.sessionId = binding.id; }
    }
    for (const [key, saved] of Object.entries(state.engineBindings)) if (saved[engine]?.id === previousId || state.bindings[key] === binding) rememberEngine(key, binding);
    persist();
  }
  async function run(msg, prompt, mode) {
    const key = scope(msg);
    let binding = state.bindings[key];
    if (binding && !session(binding.id) && !projects().includes(binding.cwd)) binding = null;
    if (!binding) {
      if (!config.defaultProject) { await projectsCard(msg); return; }
      binding = bind(key, { id: crypto.randomUUID(), cwd: config.defaultProject, engine: defaultEngine() });
    }
    if (binding.engine !== engineOf(binding)) { binding.engine = engineOf(binding); persist(); }
    const images = [];
    for (const resource of (msg.resources || []).filter(item => item.type === 'image').slice(0, 4)) {
      let buffer;
      if (channel.rawClient?.im?.v1?.messageResource) {
        const resourceFile = await channel.rawClient.im.v1.messageResource.get({ path: { message_id: msg.messageId, file_key: resource.fileKey }, params: { type: 'image' } });
        const chunks = []; let size = 0;
        for await (const chunk of resourceFile.getReadableStream()) { size += chunk.length; if (size > 5 * 1024 * 1024) throw new Error('图片超过 5 MB，请缩小后重试'); chunks.push(chunk); }
        buffer = Buffer.concat(chunks);
      } else buffer = await channel.downloadResource(resource.fileKey, 'image');
      if (buffer.length > 5 * 1024 * 1024) throw new Error('图片超过 5 MB，请缩小后重试');
      const mimeType = buffer[0] === 0x89 ? 'image/png' : buffer[0] === 0xff ? 'image/jpeg' : buffer.toString('ascii', 0, 4) === 'RIFF' ? 'image/webp' : 'image/gif';
      images.push({ mimeType, data: buffer.toString('base64') });
    }
    if (!prompt && !images.length) throw new Error('请发送文字或图片');
    const id = messageUUID(msg.messageId), view = { text: '', tools: new Map(), reasoning: new Map(), permissions: new Map(), phase: mode === 'queue' ? '已排队' : '正在处理', done: false };
    if (!detailed(msg)) {
      const reply = createSimpleReply({ channel, msg: { ...msg, threadId: threadOf(msg) }, messageId: id, footer: `${catalog().label(engineOf(binding))} · ${catalog().switchHint(engineOf(binding))} 切换引擎`, onError: rememberError, onClose: () => monitors.delete(reply.close) });
      monitors.add(reply.close);
      try {
        await reply.start();
        if (reply.closed) return;
        await submit(binding, { prompt, images, messageId: id, mode, gatewayContext: deliveryContext(msg) });
        reply.attach(listener => panel.watch(binding.id, listener));
      } catch (e) { await reply.close(); throw e; }
      return;
    }
    const startedAt = now();
    const progress = () => cards.task({ engines: catalog(), owner: msg.senderId, key, location: contextLabel(msg), detailed: detailed(msg), binding, title: session(binding.id)?.title || clip(prompt, 80) || '图片对话', view, elapsed: now() - startedAt });
    const sent = await send(msg, { card: progress() }); rememberCard(sent, msg, binding);
    try { await submit(binding, { prompt, images, messageId: id, mode, gatewayContext: deliveryContext(msg) }); }
    catch (e) { view.phase = '失败'; view.text = errorText(e); if (await channel.updateCard(sent.messageId, progress()).then(() => true, () => false)) e.reported = true; throw e; }
    let timer, heartbeat, unsub, dirty = false, busy = false, closed = false, updateFailures = 0;
    const finish = () => { if (closed) return; closed = true; clearTimeout(timer); clearInterval(heartbeat); unsub?.(); monitors.delete(finish); };
    const flush = async () => {
      if (closed || busy) { dirty = true; return; }
      busy = true; dirty = false;
      try { await channel.updateCard(sent.messageId, progress()); updateFailures = 0; }
      catch (e) {
        rememberError(e); updateFailures++;
        if (updateFailures <= 3) { busy = false; timer = setTimeout(flush, 1000 * updateFailures); return; }
        if (view.done) { try { await sendLong(msg, view.phase + '\n' + (view.text || '请用 /history 查看已保存结果')); } catch (fallbackError) { rememberError(fallbackError); } finish(); }
      }
      finally { busy = false; }
      if (dirty) { timer = setTimeout(flush, 1000); return; }
      if (view.done && !closed) { if (view.text.length > cards.REPLY_PREVIEW) { try { await sendLong(msg, view.text); } catch (e) { rememberError(e); } } finish(); }
    };
    const schedule = immediate => { clearTimeout(timer); if (busy) { dirty = true; return; } timer = setTimeout(flush, immediate ? 0 : 1200); };
    heartbeat = setInterval(() => {
      if (view.done || closed) return;
      if (!view.text && !view.tools.size && now() - startedAt >= 30000 && !view.warning) {
        view.phase = '等待引擎响应';
        view.warning = '引擎尚未返回内容，可能正在连接或重试。可以停止任务，检查网络，或用 /route 查看账号状态。';
      }
      schedule(true);
    }, 15000);
    heartbeat.unref?.();
    monitors.add(finish);
    unsub = panel.watch(binding.id, (event, data) => {
      if (event === 'stopped') { view.phase = '已停止'; view.done = true; schedule(true); return; }
      if (event === 'end' && !view.done) { view.phase = '连接已结束'; view.done = true; if (!view.text) view.text = '本轮未完成，可用 /history 查看已保存内容后继续发送。'; schedule(true); return; }
      if (data.messageId !== id) return;
      if (event === 'permission') { view.permissions.set(data.id, data); view.phase = '等待你的授权'; }
      if (event === 'permission_resolved') { view.permissions.delete(data.id); view.phase = data.behavior === 'allow' ? '正在处理' : '授权已结束'; }
      if (event === 'turn') view.phase = '正在思考';
      if (event === 'warning') { view.phase = '连接重试中'; view.warning = clip(data.warning || '引擎正在重试，请稍候', 500); }
      if (event === 'text') { view.text += data.text || ''; view.phase = '正在输出'; }
      if (event === 'reasoning') { view.reasoning.set(data.id, data.text); view.phase = '正在思考'; }
      if (event === 'tool') view.tools.set(data.id, { name: data.name, state: '执行中', input: JSON.stringify(data.input || {}, null, 2) });
      if (event === 'tool_result') { const tool = view.tools.get(data.id); if (tool) { tool.state = data.isError ? '失败' : '已完成'; tool.output = typeof data.output === 'string' ? data.output : JSON.stringify(data.output); } }
      if (event === 'error') { view.text += '\n⚠ ' + data.error; view.phase = '失败'; view.done = true; }
      if (event === 'done') { view.phase = data.isError ? '失败' : data.interrupted ? '已按补充消息继续' : '已完成'; view.done = true; }
      schedule(view.done);
    });
  }
  async function processMessage(msg) {
    if (config.disabledUserIds.includes(msg.senderId)) return;
    const text = commandText(msg, channel?.botIdentity), match = text.match(/^\/(\w+)(?:\s+([\s\S]*))?$/), name = match?.[1]?.toLowerCase(), command = name === 'session' ? 'sessions' : name, arg = match?.[2]?.trim() || '';
    if (command === 'pair') { await pair(msg, arg); return; }
    if (!allowed(msg)) { if (msg.chatType === 'p2p') await send(msg, { text: '此账号尚未配对。请在 Mac 面板“飞书网关”生成配对码，再发送 /pair 配对码。' }); return; }
    const key = scope(msg), binding = state.bindings[key];
    const engines = catalog();
    // /new [引擎] [项目]：首个参数可选择引擎（id 或别名）
    const firstWord = arg.split(/\s+/)[0], explicitEngine = command === 'new' ? engines.find(firstWord) : '';
    const newEngine = explicitEngine || defaultEngine();
    const newTarget = explicitEngine ? arg.slice(firstWord.length).trim() : arg;
    if (!detailed(msg) && (['sessions', 'projects', 'switch', 'history', 'rename', 'route'].includes(command) || command === 'new' && newTarget)) return managementNotice(msg);
    if (!detailed(msg) && command === 'help') return send(msg, { text: `直接发送消息，或 @机器人，在当前位置独立会话中处理。\n/new [${engines.ids().join('|')}] 默认项目新建\n${engines.ids().map(id => '/' + id).join(' 或 ')} 切换引擎\n/current 查看当前引擎与绑定\n/queue 内容 排队\n/steer 内容 引导任务\n/stop 停止任务\n此群使用普通文字回复和临时思考表情，会话管理请先在面板逐项授权此群。` });
    if (!detailed(msg) && command === 'status') return send(msg, { text: `my-agents 在线 · ${contextLabel(msg)}独立会话\n当前引擎：${catalog().label(binding ? engineOf(binding) : defaultEngine())}\n${engines.switchHint(binding ? engineOf(binding) : defaultEngine())} 切换引擎\n此群使用简洁显示：普通文字回复，处理时显示思考表情。` });
    // /<引擎 id 或别名> [问题] 直接切换；/use 与 /engine 带参数时同样切换
    if (command && engines.find(command) && !['new', 'use', 'engine'].includes(command)) return useEngine(msg, engines.find(command), arg);
    if (command === 'engine' || command === 'use') {
      if (!arg) return engineCard(msg);
      const target = engines.find(arg);
      if (!target) throw new Error(`使用 ${engines.ids().map(id => '/' + id).join(' 或 ')} 切换引擎，/engine 查看当前引擎`);
      return useEngine(msg, target);
    }
    if (command === 'help') return send(msg, { text: helpText(engines) });
    if (command === 'sessions') return sessionsCard(msg, arg);
    if (command === 'route') return routesCard(msg, await applyRoute(msg, parseRoute(arg)));
    if (command === 'projects' || command === 'new' && !newTarget && !config.defaultProject) return projectsCard(msg, 0, newEngine);
    if (command === 'new') {
      const rows = projects();
      let cwd;
      const target = newTarget.replace(/^(["'])(.*)\1$/s, '$2');
      if (path.isAbsolute(target) || target === '~' || target.startsWith('~/')) {
        cwd = path.resolve(target.startsWith('~') ? os.homedir() + target.slice(1) : target);
        let directory = false;
        try { directory = fs.statSync(cwd).isDirectory(); } catch {}
        if (!directory) throw new Error('项目目录不存在或不是文件夹，请先在本机创建目录，再用 /new 绝对路径');
        if (!state.projects.includes(cwd)) state.projects.push(cwd);
      } else {
        cwd = !newTarget ? config.defaultProject : /^\d+$/.test(newTarget) ? rows[Number(newTarget) - 1] : rows.find(folder => folder === newTarget || path.basename(folder) === newTarget);
      }
      if (!cwd) throw new Error('未找到该项目。请用 /projects 列出可选项目，或用 /new 绝对路径 指定本机已有目录');
      bind(key, { id: crypto.randomUUID(), cwd, engine: newEngine }); return currentCard(msg, state.bindings[key]);
    }
    if (command === 'switch') {
      const rows = panel.sessions(), ids = state.listings[key] || [];
      const matches = /^\d+$/.test(arg) ? rows.filter(item => item.id === ids[Number(arg) - 1]) : rows.filter(item => arg && (item.id.startsWith(arg) || item.title === arg));
      if (matches.length !== 1) { await sessionsCard(msg, /^\d+$/.test(arg) ? '' : arg); return; }
      bind(key, bindingFor(matches[0])); return currentCard(msg, state.bindings[key]);
    }
    if (command === 'status') return send(msg, { text: `my-agents 在线\n${runtime.status().keepAwake ? 'Mac 保活已开启' : 'Mac 保活未开启'}\n绑定范围：${contextLabel(msg)}\n当前会话：${binding ? session(binding.id)?.title || binding.id : '尚未选择'}\n当前引擎：${catalog().label(binding ? engineOf(binding) : defaultEngine())}\n默认引擎：${catalog().label(defaultEngine())}\n默认项目：${config.defaultProject || '未配置'}` });
    if (['current', 'history', 'rename', 'stop'].includes(command)) {
      if (command === 'current') { const current = binding || defaultBinding(msg); return current ? currentCard(msg, current) : projectsCard(msg); }
      if (!binding) return sessionsCard(msg);
      if (command === 'stop') { await panel.stop(binding.id); return send(msg, { text: '已发送停止请求。' }); }
      if (command === 'rename') { if (!arg) throw new Error('用法：/rename 新名称'); await panel.rename(binding.id, arg); return currentCard(msg, binding); }
      return historyReply(msg, binding);
    }
    if (command && !['ask', 'queue', 'steer'].includes(command)) throw new Error('未知网关命令。发送 /help 查看；转发 Claude 命令请用 /ask ' + text);
    const prompt = command ? arg : text.replace(/<image\b[^>]*>[\s\S]*?<\/image>|<image\b[^>]*\/>/g, '').trim();
    return run(msg, prompt, command === 'queue' ? 'queue' : 'steer');
  }
  async function receive(msg) {
    if (!msg?.messageId || !msg.senderId || !msg.chatId || inFlight.has(msg.messageId) || state.receipts.includes(msg.messageId)) return;
    inFlight.add(msg.messageId);
    const appId = config.appId;
    const userAllowed = msg.chatType !== 'p2p' || config.allowAllUsers || config.allowedUserIds.includes(msg.senderId);
    const groupAllowed = msg.chatType === 'p2p' || config.allowAllGroups || config.allowedChatIds.includes(msg.chatId);
    const needsMention = msg.chatType === 'group' && (!msg.mentionedBot || msg.mentionAll);
    const pairingMessage = msg.chatType === 'p2p' && /^\/pair(?:\s|$)/i.test(commandText(msg, channel?.botIdentity));
    const access = config.disabledUserIds.includes(msg.senderId) ? 'disabled_user' : needsMention ? 'needs_mention' : pairingMessage ? 'pairing' : !userAllowed ? 'blocked_user' : !groupAllowed ? 'blocked_group' : 'allowed';
    try {
      if (!await inbox.record(appId, msg, access)) { inFlight.delete(msg.messageId); return; }
    } catch (e) { rememberError(e); inFlight.delete(msg.messageId); return; }
    if (appId !== config.appId) { inFlight.delete(msg.messageId); return; }
    if (!msg.senderName) contacts.lookup('users', msg.senderId).catch(() => {});
    if (msg.chatType === 'group' && !msg.chatName) contacts.lookup('groups', msg.chatId).catch(() => {});
    if (needsMention) { inFlight.delete(msg.messageId); return; }
    const key = contextKey(msg), previous = locks.get(key) || Promise.resolve();
    const work = previous.catch(() => {}).then(async () => {
      try { await processMessage(msg); state.receipts.push(msg.messageId); persist(); }
      catch (e) { rememberError(e); if (!e?.reported) try { await send(msg, { text: '未能完成：' + errorText(e) }); } catch {} }
    });
    locks.set(key, work);
    try { await work; } finally { inFlight.delete(msg.messageId); if (locks.get(key) === work) locks.delete(key); }
  }
  // Messages and card clicks for one location run one at a time.
  async function withLock(key, fn) {
    const previous = locks.get(key) || Promise.resolve();
    const work = previous.catch(() => {}).then(fn);
    locks.set(key, work);
    try { return await work; } finally { if (locks.get(key) === work) locks.delete(key); }
  }
  async function action(evt) {
    const value = evt.action?.value;
    const msg = { messageId: evt.messageId, senderId: evt.operator?.openId, chatId: evt.chatId, chatType: evt.chatType || inbox.chatType(config.appId, evt.chatId) || state.cards[evt.messageId]?.chatType || 'group', content: '' };
    if (!value || typeof value !== 'object' || value.owner !== msg.senderId || !allowed(msg) || !detailed(msg)) return;
    if (value.key) { try { const [owner, chat, thread] = JSON.parse(value.key); if ((owner !== msg.senderId && !(owner === '*' && msg.chatType !== 'p2p')) || chat !== msg.chatId || typeof thread !== 'string') return; const saved = state.cards[evt.messageId]; if (saved?.key && saved.key !== value.key) return; if (thread !== 'main') msg.threadId = thread; } catch { return; } }
    const key = scope(msg);
    return withLock(contextKey(msg), () => cardAction(msg, key, value));
  }
  async function cardAction(msg, key, value) {
    try {
      if (value.action === 'engine') return engineCard(msg);
      if (value.action === 'use_engine') { if (!catalog().has(value.engine)) throw new Error('引擎无效'); return useEngine(msg, value.engine); }
      if (value.action === 'sessions') return sessionsCard(msg, String(value.query || ''), value.page);
      if (value.action === 'projects') return projectsCard(msg, value.page, value.engine);
      if (value.action === 'route') return routesCard(msg, await applyRoute(msg, { ...(typeof value.selected === 'string' ? { selected: value.selected } : {}), ...(['failover', 'round-robin'].includes(value.mode) ? { mode: value.mode } : {}), ...(value.reset === true ? { reset: true } : {}), ...(typeof value.codexCapture === 'boolean' ? { codexCapture: value.codexCapture } : {}) }));
      if (value.action === 'new') { if (!projects().includes(value.cwd)) throw new Error('此项目当前不可用'); bind(key, { id: crypto.randomUUID(), cwd: value.cwd, engine: catalog().fallback(value.engine, defaultEngine()) }); return currentCard(msg, state.bindings[key]); }
      const original = state.cards[msg.messageId];
      const targetId = original?.originalSessionId === value.id ? original.sessionId : value.id;
      const item = session(targetId);
      if (!item && value.action === 'history' && state.bindings[key]?.id === targetId) return currentCard(msg, state.bindings[key]);
      if (!item) throw new Error('会话不存在或已删除，请发送 /sessions 刷新');
      if (value.action === 'permission') { await panel.permission(item.id, value.requestId, value.behavior); return send(msg, { text: value.behavior === 'allow' ? '已允许本次工具调用。' : '已拒绝本次工具调用。' }); }
      if (value.action === 'stop') { await panel.stop(item.id); return send(msg, { text: '已发送停止请求。' }); }
      if (value.action === 'history') return historyReply(msg, bindingFor(item));
      bind(key, bindingFor(item));
      return currentCard(msg, state.bindings[key]);
    } catch (e) { rememberError(e); await send(msg, { text: errorText(e) }); }
  }
  async function stop() {
    await Promise.allSettled([...monitors].map(finish => finish()));
    const old = channel; channel = null;
    if (old) await old.disconnect().catch(() => {});
    phase = 'disabled';
  }
  async function start() {
    if (connecting) return connecting;
    if (!config.enabled) { phase = 'disabled'; return; }
    if (phase === 'connected' && (!channel?.getConnectionStatus || channel.getConnectionStatus()?.state === 'connected')) return;
    connecting = (async () => {
      await inbox.ready;
      await stop(); phase = 'connecting'; lastError = '';
      const factory = channelFactory || (options => require('@larksuiteoapi/node-sdk').createLarkChannel(options));
      const sdk = channelFactory ? null : require('@larksuiteoapi/node-sdk');
      channel = factory({ appId: config.appId, appSecret: config.appSecret, domain: config.domain === 'lark' ? sdk?.Domain.Lark || 'https://open.larksuite.com' : sdk?.Domain.Feishu || 'https://open.feishu.cn', policy: { dmMode: 'open', requireMention: false, respondToMentionAll: true }, safety: { chatQueue: { enabled: false }, batch: { text: { delayMs: 0, longDelayMs: 0, maxMessages: 1 }, media: { delayMs: 0, maxItems: 1 } } }, wsConfig: { pingTimeout: 20 }, outbound: { streamThrottleMs: 1200 }, logger: { error: rememberError, warn() {}, info() {}, debug() {}, trace() {} }, loggerLevel: sdk?.LoggerLevel.error });
      channel.on('message', msg => { receive(msg).catch(rememberError); }); channel.on('cardAction', evt => { action(evt).catch(rememberError); });
      channel.on('error', rememberError); channel.on('reconnecting', () => { phase = 'reconnecting'; }); channel.on('reconnected', () => { phase = 'connected'; if (/\[ws\]|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|WebSocket/i.test(lastError)) lastError = ''; });
      await channel.connect(); phase = 'connected';
      await inbox.ready;
      contacts.refresh(false).catch(() => {});
    })().catch(async e => { rememberError(e); await stop(); phase = 'error'; throw new Error(lastError || '飞书连接失败'); }).finally(() => { connecting = null; });
    return connecting;
  }
  async function configure(input) {
    const next = { ...config };
    for (const key of ['enabled', 'keepAwake', 'cardCallbacksReady', 'allowAllUsers', 'allowAllGroups']) if (key in input) { if (typeof input[key] !== 'boolean') throw new Error('配置类型无效'); next[key] = input[key]; }
    for (const key of ['appId', 'domain', 'defaultProject', 'defaultEngine', 'model']) if (key in input) { if (typeof input[key] !== 'string') throw new Error('配置类型无效'); next[key] = input[key].trim(); }
    if (input.appSecret) next.appSecret = String(input.appSecret).trim();
    for (const key of ['allowedUserIds', 'disabledUserIds', 'allowedChatIds']) if (key in input) {
      if (!Array.isArray(input[key]) || input[key].some(value => typeof value !== 'string' || !/^[a-zA-Z0-9_-]{3,100}$/.test(value))) throw new Error('飞书用户或群聊 ID 无效'); next[key] = [...new Set(input[key])];
    }
    if (!catalog().has(next.defaultEngine)) throw new Error(`请选择 ${catalog().list.map(engine => engine.label).join(' 或 ')} 作为默认引擎`);
    if (!['feishu', 'lark'].includes(next.domain)) throw new Error('请选择飞书或 Lark');
    if (next.enabled && (!/^[a-zA-Z0-9_-]{8,100}$/.test(next.appId) || !next.appSecret || next.appSecret.length > 1000)) throw new Error('请填写有效的 App ID 和 App Secret');
    if (next.defaultProject) { next.defaultProject = fs.realpathSync(next.defaultProject); if (!fs.statSync(next.defaultProject).isDirectory()) throw new Error('默认项目必须是文件夹'); }
    if (next.model && !/^[\w.\/:\[\]-]{1,100}$/.test(next.model)) throw new Error('模型名称无效');
    if (next.appId !== config.appId || next.domain !== config.domain) { next.cardCallbacksReady = input.cardCallbacksReady || false; next.allowAllUsers = input.allowAllUsers || false; next.allowAllGroups = input.allowAllGroups || false; next.allowedUserIds = input.allowedUserIds || []; next.disabledUserIds = input.disabledUserIds || []; pairing = null; state = { bindings: {}, engineBindings: {}, cards: {}, listings: {}, receipts: [], projects: [] }; persist(); }
    const reconnect = next.enabled !== config.enabled || next.appId !== config.appId || next.appSecret !== config.appSecret || next.domain !== config.domain;
    if (reconnect) await stop();
    config = next; atomic(configFile, config); runtime.keepAwake(config.keepAwake);
    // Access rules are evaluated locally for every message; changing them must
    // not interrupt an existing connection or its live task cards.
    if (config.enabled && (reconnect || ['disabled', 'error'].includes(phase))) await start();
    return status();
  }
  async function labelContact({ id, label }) {
    await inbox.ready;
    const known = inbox.contacts(config.appId);
    if (typeof id !== 'string' || ![...known.users, ...known.groups].some(item => item.id === id)) throw new Error('请选择已发现的用户或群');
    inbox.setAlias(config.appId, id, label);
    return status();
  }
  async function refreshContacts() {
    const nameRefresh = await contacts.refresh(true);
    return { ...status(), nameRefresh };
  }
  function status() {
    let sdkAvailable = !!channelFactory; try { require.resolve('@larksuiteoapi/node-sdk'); sdkAvailable = true; } catch {}
    const { appSecret, ...safe } = config;
    const connection = channel?.getConnectionStatus?.();
    const actualPhase = connection?.state === 'failed' ? 'error' : ['idle', 'connecting', 'reconnecting'].includes(connection?.state) && config.enabled ? 'reconnecting' : phase;
    return { capabilities: { contactNames: true }, config: { ...safe, hasSecret: !!appSecret }, phase: actualPhase, lastError, sdkAvailable, bot: channel?.botIdentity?.name || '', connection, runtime: runtime.status(), bindings: Object.values(state.bindings).length, inbox: inbox.contacts(config.appId) };
  }
  return {
    start, stop, configure, status, receive, action, sendReply, labelContact, refreshContacts,
    revealSecret: () => config.appSecret,
    messages: options => inbox.messages(config.appId, options),
    newPairing() { pairing = { code: crypto.randomBytes(9).toString('base64url'), expires: now() + 10 * 60 * 1000 }; return { command: '/pair ' + pairing.code, expiresAt: pairing.expires }; },
    bootstrap() { runtime.keepAwake(config.keepAwake); return start(); },
  };
}
module.exports = { createFeishuGateway, contextKey, messageUUID, errorMessage };
