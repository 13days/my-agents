const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const cards = require('./feishu-cards');
const conversationState = require('./conversation-state');
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
    `/new [${ids.join('|')}] [第一条问题] 打开新任务表单，选择机器、项目、模型后提交启动`,
    ...engines.list.map(engine => `/${engine.id} [问题] 切到 ${engine.label}，可直接带问题`),
    '/node [节点名] [路径] 查看或切换运行位置（本机 / 远程开发机），例如 /node devbox ~/repos/项目',
    '/leader [节点名] 查看集群或主动迁移 Timi 主节点',
    '/model [模型 ID|default] 查看或切换当前会话模型，default 恢复默认', '/use 引擎 切换引擎（支持别名）', '/engine 查看当前引擎和切换选项', '/current 查看当前位置的绑定会话', '/history 查看最近对话',
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

function createFeishuGateway({ dir, panel, runtime, channelFactory, replyURL = '', leadership = null, now = Date.now }) {
  const configFile = path.join(dir, 'panel-feishu.json'), stateFile = path.join(dir, 'panel-feishu-state.json');
  const inbox = createFeishuInbox(dir);
  const defaults = { allowAllUsers: false, allowAllGroups: false, enabled: false, appId: '', appSecret: '', domain: 'feishu', allowedUserIds: [], disabledUserIds: [], allowedChatIds: [], defaultProject: '', defaultMachine: '', defaultEngine: 'claude', worktree: true, model: '', keepAwake: false };
  const emptyState = () => ({ bindings: {}, engineBindings: {}, cards: {}, sessionRefs: {}, taskCards: {}, sessionModels: {}, listings: {}, receipts: [], projects: [], nodeProjects: {} });
  let config = defaults, state = emptyState(), phase = 'disabled', lastError = '', channel = null, connecting = null, pairing = null;
  function reloadFiles() {
    try { config = { ...defaults, ...load(configFile, {}) }; state = { ...emptyState(), ...load(stateFile, {}) }; state.taskCards ||= {}; state.sessionRefs ||= {}; state.sessionModels ||= {}; state.drafts ||= {}; }
    catch (e) { lastError = e.message; phase = 'error'; }
  }
  reloadFiles();
  const applyRuntime = () => runtime.keepAwake(config.keepAwake);
  // Engines come from the panel registry; unknown defaults fall back at use time.
  const catalog = () => engineCatalog(panel.engines?.());
  const defaultEngine = () => catalog().fallback(config.defaultEngine, 'claude');
  // `config.model` predates per-engine models and always meant the Claude model.
  const modelFor = engine => config.models?.[engine] ?? (engine === 'claude' ? config.model : '');
  const locks = new Map(), inFlight = new Set(), monitors = new Set(), pairAttempts = new Map();
  let channelEpoch = 0;
  const replyTargets = new Map();
  const contacts = require('./feishu-contacts').createContactDirectory({ inbox, getChannel: () => channel, getAppId: () => config.appId, now });
  const persist = () => { const drafts = Object.keys(state.drafts || {}); for (const id of drafts.slice(0,-100)) delete state.drafts[id]; state.receipts = state.receipts.slice(-2000); const keys = Object.keys(state.cards); for (const key of keys.slice(0, Math.max(0, keys.length - 1000))) delete state.cards[key]; atomic(stateFile, state); };
  const errorText = e => clip((errorMessage(e) || '飞书请求失败，请查看本机服务日志').split(config.appSecret || '\0').join('[secret]'), 600);
  const rememberError = e => { lastError = errorText(e); };
  const allowed = msg => !config.disabledUserIds.includes(msg.senderId) && (msg.chatType === 'p2p' ? config.allowAllUsers || config.allowedUserIds.includes(msg.senderId) : config.allowAllGroups || config.allowedChatIds.includes(msg.chatId));
  const detailed = msg => msg.chatType === 'p2p' || config.allowedChatIds.includes(msg.chatId);
  const managementNotice = msg => send(msg, { text: '此群使用普通文字回复，处理时显示思考表情。请在「IM 接入」逐项授权此群后使用会话管理功能。/new 在默认项目新建会话；/stop 停止当前任务。' });
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
    if (!state.bindings[key] && config.defaultProject) { bind(key, { id: crypto.randomUUID(), cwd: config.defaultProject, machineId: config.defaultMachine || panel.machineId?.(), engine: defaultEngine() }); }
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
    const binding = state.bindings[scope(msg)], engine = binding ? engineOf(binding) : defaultEngine(), node = binding ? nodeOf(binding) : 'local';
    const cli = panel.engineInfo?.(engine, node);
    const where = node === 'local' ? '本机' : `远程节点「${nodeLabel(node)}」上的`;
    const runtime = cli ? `当前会话由 my-agents 直接启动${where} ${catalog().label(engine)} CLI，实际运行版本为 ${cli.version || '未检测'}，可执行文件为 ${JSON.stringify(cli.path)}。核实当前引擎版本时请以该进程信息为准，不要把 PATH 中其他安装的版本或推测的 SDK 版本当作当前版本。${cliEnvHint(engine)}` : '';
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
  function rememberSession(binding) {
    state.sessionRefs[binding.id] = { ...state.sessionRefs[binding.id], id:binding.id, cwd:binding.cwd, machineId:binding.machineId, node:binding.node, engine:binding.engine, workspaceId:binding.workspaceId, worktree:binding.worktree, started:!!binding.started || !!state.sessionRefs[binding.id]?.started };
  }
  function rememberCard(result, msg, binding, extra = {}) {
    if (binding) rememberSession(binding);
    if (result?.messageId) { state.cards[result.messageId] = { ...(binding ? { sessionId: binding.id, cwd: binding.cwd, machineId: binding.machineId, engine: binding.engine, node: binding.node, workspaceId: binding.workspaceId, worktree: binding.worktree } : {}), owner: msg.senderId, chatId: msg.chatId, chatType: msg.chatType, key: contextKey(msg), threadId: threadOf(msg), ...extra }; persist(); }
  }
  function referenceId(id) {
    const seen=new Set();
    while (state.sessionRefs[id]?.alias) { if(seen.has(id))throw new Error('会话引用存在循环，请检查历史绑定');seen.add(id);id=state.sessionRefs[id].alias; }
    return id;
  }
  async function recoverSessionCard(msg, key, missing) {
    const candidates=[state.bindings[key],...Object.values(state.engineBindings[key] || {}),...Object.values(state.cards).filter(card=>card.key===key&&card.sessionId).reverse().map(card=>({...card,id:card.sessionId}))];
    const rows=[],seen=new Set([missing]);
    for(const ref of candidates) {
      if(!ref?.id)continue;const id=referenceId(ref.id);if(seen.has(id))continue;seen.add(id);
      const existing=session(id);if(!existing)continue;
      rows.push({...existing,...(state.sessionRefs[id] || {}),project:existing.project || ref.cwd});if(rows.length===5)break;
    }
    const result=await send(msg,{card:cards.sessionRecovery({engines:catalog(),owner:msg.senderId,key,rows,missing})});rememberCard(result,msg);return result;
  }
  async function repairCard(input) {
    if(!/^[\w-]{8,100}$/.test(input.messageId || '') || !/^[a-zA-Z0-9-]{8,100}$/.test(input.originalSessionId || ''))throw new Error('旧卡片引用无效');
    const msg={messageId:input.messageId,senderId:input.senderId,chatId:input.chatId,chatType:input.chatType,threadId:input.threadId || '',content:''};
    if(!['group','p2p'].includes(msg.chatType)||!allowed(msg))throw new Error('此位置没有授权');
    const item=panel.resolveSession ? await panel.resolveSession(input.targetSessionId) : session(input.targetSessionId);
    if(!item)throw new Error('目标历史会话不可用');
    const binding=bindingFor({...item,started:true});
    if(panel.sessionExists && !await panel.sessionExists(binding))throw new Error('原执行机器尚未确认目标历史，请恢复连接后重试');
    const backup=path.join(dir,'backups','card-reference-'+now()+'-'+crypto.randomUUID());fs.mkdirSync(backup,{recursive:true,mode:0o700});fs.copyFileSync(stateFile,path.join(backup,'panel-feishu-state.json'));fs.chmodSync(path.join(backup,'panel-feishu-state.json'),0o600);
    rememberCard({messageId:msg.messageId},msg,binding,{originalSessionId:input.originalSessionId,repairedAt:now()});
    state.sessionRefs[input.originalSessionId]={id:input.originalSessionId,alias:binding.id};persist();
    return {ok:true,messageId:msg.messageId,sessionId:binding.id,machineId:binding.machineId,backup};
  }
  function session(id) { return panel.sessions().find(item => item.id === id); }
  function engineOf(binding) { return catalog().fallback(binding.engine || session(binding.id)?.engine || panel.engine?.(binding.id), 'claude'); }
  function bindingFor(item) { return { started: !!item.started, workspaceId: item.workspaceId, id: item.id, cwd: item.project, worktree: item.worktree, engine: engineOf(item), machineId: item.machineId || (item.node && item.node !== 'local' ? item.node : panel.machineId?.()), ...(item.node && item.node !== 'local' ? { node: item.node } : {}) }; }
  // Where a binding runs: 'local' (this Mac) or a remote node id (see node/). A session stays on its node.
  function nodeOf(binding) { if (binding.machineId) return binding.machineId === panel.machineId?.() ? 'local' : binding.machineId; return session(binding.id)?.node || binding.node || 'local'; }
  const remoteNodes = () => (panel.nodes?.() || []).filter(node => node.id !== 'local');
  const nodeLabel = id => id === 'local' ? panel.machines?.().find(item => item.id === panel.machineId?.())?.label || '本机' : remoteNodes().find(node => node.id === id)?.label || id;
  const findNode = query => { const q = String(query || '').trim().toLowerCase(); if (['local', '本机', panel.machineId?.()].includes(q)) return 'local'; return remoteNodes().find(node => node.id.toLowerCase() === q || String(node.label).toLowerCase() === q)?.id || ''; };
  // Remote directories cannot be checked here; the node validates them when the session starts.
  const usable = binding => nodeOf(binding) === 'local' ? projects().includes(binding.cwd) : true;
  // Per-location memory of the last session for each engine on each node.
  const cacheKey = (engine, node) => { const id = !node || node === 'local' ? panel.machineId?.() || 'local' : node; return id !== 'local' ? `${engine}@${id}` : engine; };
  function rememberEngine(key, binding) {
    if (!binding) return;
    const engine = engineOf(binding); (state.engineBindings[key] ||= {})[cacheKey(engine, nodeOf(binding))] = { ...binding, engine };
  }
  function bind(key, binding) {
    rememberEngine(key, state.bindings[key]);
    binding.machineId ||= binding.node && binding.node !== 'local' ? binding.node : panel.machineId?.();
    binding.engine = engineOf(binding); state.bindings[key] = binding; rememberEngine(key, binding); persist(); return binding;
  }
  async function useEngine(msg, engine, prompt = '') {
    const key = scope(msg), current = state.bindings[key];
    if (!current || engineOf(current) !== engine) {
      rememberEngine(key, current);
      const node = current ? nodeOf(current) : config.defaultMachine && config.defaultMachine !== panel.machineId?.() ? config.defaultMachine : 'local';
      const cached = state.engineBindings[key]?.[cacheKey(engine, node)];
      const saved = cached && (session(cached.id) || await panel.sessionExists?.(cached)) ? cached : null;
      const cwd = saved?.cwd || current?.cwd || config.defaultProject;
      const at = { node };
      if (!cwd || !usable({ ...at, cwd })) return projectsCard(msg, 0, engine, node);
      bind(key, saved && usable(saved) ? { ...saved } : { id: crypto.randomUUID(), cwd, engine, ...(panel.workspaces && current ? { sourceSessionId: current.id } : {}), ...(node !== 'local' ? at : {}) });
    }
    return prompt ? run(msg, prompt, 'steer') : currentCard(msg, state.bindings[key]);
  }
  // Moves this location to another machine, keeping the engine. Resumes that node's last session unless a directory is given.
  async function useNode(msg, node, dir = '') {
    const key = scope(msg), current = state.bindings[key], engine = current ? engineOf(current) : defaultEngine();
    if (node !== 'local' && !remoteNodes().find(item => item.id === node)?.connected) throw new Error(`节点「${nodeLabel(node)}」未连接，请在「机器与引擎」检查执行通道`);
    const target = dir.replace(/^(["'])(.*)\1$/s, '$2');
    if (!target && current && nodeOf(current) === node) return currentCard(msg, current);
    rememberEngine(key, current);
    const cached = state.engineBindings[key]?.[cacheKey(engine, node)];
    if (!target && cached && (session(cached.id) || await panel.sessionExists?.(cached)) && usable(cached)) { bind(key, { ...cached }); return currentCard(msg, state.bindings[key]); }
    let cwd = target;
    if (node === 'local') {
      if (cwd && !path.isAbsolute(cwd) && cwd !== '~' && !cwd.startsWith('~/')) throw new Error('请使用绝对路径或 ~/ 开头的路径');
      if (cwd) cwd = path.resolve(cwd.startsWith('~') ? os.homedir() + cwd.slice(1) : cwd);
      cwd ||= panel.defaultDirectory?.(panel.machineId?.()) || config.defaultProject;
      if (!cwd) return projectsCard(msg, 0, engine, node);
      let directory = false; try { directory = fs.statSync(cwd).isDirectory(); } catch {}
      if (!directory) throw new Error('项目目录不存在或不是文件夹');
      if (!state.projects.includes(cwd)) state.projects.push(cwd);
    } else {
      if (cwd && !cwd.startsWith('/') && cwd !== '~' && !cwd.startsWith('~/')) throw new Error('请使用开发机上的绝对路径或 ~/ 开头的路径');
      if (!cwd) return projectsCard(msg, 0, engine, node);
    }
    bind(key, { id: crypto.randomUUID(), cwd, engine, ...(panel.workspaces && current ? { sourceSessionId: current.id } : {}), ...(node !== 'local' ? { node } : {}) });
    return currentCard(msg, state.bindings[key]);
  }
  async function nodesCard(msg) {
    const binding = state.bindings[contextKey(msg)], node = binding ? nodeOf(binding) : 'local';
    const list = [{ id: 'local', label: nodeLabel('local'), connected: true }, ...remoteNodes()];
    if (!detailed(msg)) return send(msg, { text: `${contextLabel(msg)} · 运行位置：${nodeLabel(node)}\n可选：${list.map(item => `${item.label}（${item.id}）${item.connected ? '' : ' · 离线'}`).join('、')}\n/node 节点名 [路径] 切换，例如 /node ${list[1]?.id || 'devbox'} ~/repos/项目` });
    const result = await send(msg, { card: cards.nodePicker({ owner: msg.senderId, key: contextKey(msg), location: contextLabel(msg), node: node === 'local' ? panel.machineId?.() || 'local' : node, nodes: list.map(item => ({ ...item, id: item.id === 'local' ? panel.machineId?.() || 'local' : item.id })), engines: catalog(), engine: binding ? engineOf(binding) : defaultEngine() }) });
    rememberCard(result, msg, binding);
  }
  // Directories used on a remote node, newest first: its sessions plus ones picked from Feishu.
  function nodeProjects(node) {
    if (node === 'local') return projects();
    const home = remoteNodes().find(item => item.id === node)?.home;
    return [...new Set([...(panel.nodeProjects?.(node) || []), ...panel.sessions().filter(item => item.node === node || item.machineId === node).map(item => item.project), ...(state.nodeProjects[node] || []), home].filter(Boolean))];
  }
  const pageOf = (page, total, size = cards.PAGE_SIZE) => Math.max(0, Math.min(Math.max(0, Math.ceil(total / size) - 1), Math.trunc(Number(page) || 0)));
  async function sessionsCard(msg, query = '', requestedPage = 0) {
    if (!detailed(msg)) return managementNotice(msg);
    query = clip(String(query || ''), 80);
    const directory = panel.sessionCatalog ? await panel.sessionCatalog({ refresh: true, query }) : { sessions: require('./core/session-directory').searchSessions(panel.sessions(), query), unavailable: [] };
    const key = contextKey(msg), all = directory.sessions;
    const page = pageOf(requestedPage, all.length, cards.SESSION_PAGE_SIZE), rows = all.slice(page * cards.SESSION_PAGE_SIZE, (page + 1) * cards.SESSION_PAGE_SIZE);
    state.listings[key] = all.map(item => item.id); persist();
    let previews = [];
    try { previews = panel.sessionPreviews ? await panel.sessionPreviews(rows) : []; } catch (error) { rememberError(error); }
    const byId = new Map(previews.map(preview => [preview.id, preview]));
    const result = await send(msg, { card: cards.sessionList({ engines: catalog(), owner: msg.senderId, key, location: contextLabel(msg), rows: rows.map(item => ({ ...item, ...byId.get(item.id), running: item.running || panel.running(item.id) })), unavailable: directory.unavailable, total: all.length, page, query, selected: state.bindings[key]?.id }) });
    rememberCard(result, msg);
    if (result?.messageId) { state.cards[result.messageId].listing = { page, query }; persist(); }
  }
  function projects() {
    return [...new Set([config.defaultProject, ...panel.projects(), ...state.projects].filter(Boolean))].filter(folder => { try { return fs.statSync(folder).isDirectory(); } catch { return false; } });
  }
  async function projectsCard(msg, requestedPage = 0, engine = defaultEngine(), node = null) {
    if (!detailed(msg)) return managementNotice(msg);
    const current = state.bindings[contextKey(msg)];
    node = node && (node === 'local' || remoteNodes().some(item => item.id === node)) ? node : current ? nodeOf(current) : config.defaultMachine && config.defaultMachine !== panel.machineId?.() ? config.defaultMachine : 'local';
    const all = nodeProjects(node), page = pageOf(requestedPage, all.length);
    const result = await send(msg, { card: cards.projectList({ forms: !!panel.workspaces, owner: msg.senderId, key: contextKey(msg), location: contextLabel(msg), rows: all.slice(page * cards.PAGE_SIZE, (page + 1) * cards.PAGE_SIZE), total: all.length, page, defaultProject: node === 'local' ? config.defaultProject : '', engine: catalog().fallback(engine, defaultEngine()), engines: catalog(), node: node === 'local' ? panel.machineId?.() || 'local' : node, nodeLabel: nodeLabel(node) }) });
    rememberCard(result, msg);
  }
  async function currentCard(msg, binding, switched = false, resolvedItem = null) {
    const node = nodeOf(binding), where = node === 'local' ? '' : ` · ${nodeLabel(node)}`;
    if (!detailed(msg)) return send(msg, { text: `${contextLabel(msg)} · ${catalog().label(engineOf(binding))}${where} · 模型：${modelLabel(binding)} 已就绪。直接发送消息继续。\n${catalog().switchHint(engineOf(binding))} 切换；各自保留上下文。/node 切换运行位置。/model 查看或切换模型。` });
    const result = await send(msg, { card: cards.currentSession({ forms: !!panel.workspaces, engines: catalog(), owner: msg.senderId, key: contextKey(msg), location: contextLabel(msg), nodeLabel: nodeLabel(node), model: modelLabel(binding), binding, switched, exists: !!session(binding.id) || !!binding.started, item: session(binding.id) || resolvedItem, running: panel.running(binding.id), requests: panel.pendingPermissions?.(binding.id) || [] }) });
    rememberCard(result, msg, binding);
  }
  async function historyReply(msg, binding) {
    try {
      const history = await panel.history(binding.id, binding.machineId), assistant = catalog().label(engineOf(binding));
      if (!Array.isArray(history)) throw new Error('历史记录格式无效');
      const recent = history.filter(item => item && (item.text?.trim() || item.tools?.length || item.images?.length)).slice(-10);
      if (!recent.length) return await send(msg, { text: '这段会话暂无已保存的对话。任务仍在运行时，请等本轮结束后再查看。' });
      let hiddenEmail = false, shortened = false;
      const sections = recent.map(item => {
        // Send a privacy-preserving preview; original local transcripts stay intact.
        const text = String(item.text || '').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, () => { hiddenEmail = true; return '[邮箱已隐藏]'; });
        const preview = clip(text, 600); if (preview !== text) shortened = true;
        const imageNote = item.images?.length ? `\n[图片 ${item.images.length} 张]` : '';
        const tools = item.tools?.length ? '\n' + item.tools.map(tool => `🔧 ${tool.name} · ${tool.state}`).join('\n') : '';
        return `**${item.role === 'user' ? '你' : assistant}**\n${preview}${imageNote}${tools}`;
      });
      if (hiddenEmail) sections.push('历史预览已隐藏邮箱，原文仍保留在本机面板。');
      if (shortened) sections.push('长消息仅展示前 600 字；完整内容请在本机面板查看。');
      return await sendLong(msg, sections.join('\n\n'));
    } catch (error) {
      rememberError(error);
      const audited = /audit|contain sensitive data|EMAIL_ADDRESS/i.test(errorMessage(error));
      const text = audited ? '最近对话未能发送：飞书审核拦截了这段内容。请在本机面板查看完整记录，原始对话没有被修改。' : '读取或发送最近对话失败，请稍后重试，或在本机面板查看。';
      return await send(msg, { text }).catch(rememberError);
    }
  }

  async function engineCard(msg) {
    const binding = state.bindings[contextKey(msg)], engine = binding ? engineOf(binding) : defaultEngine();
    if (!detailed(msg)) return send(msg, { text: `${contextLabel(msg)} · ${binding ? '当前' : '默认'}引擎：${catalog().label(engine)}\n${catalog().switchHint(engine)} 切换，可直接带问题。各引擎分别接续上下文；${catalog().ids().map(id => '/new ' + id).join(' 或 ')} 强制新建。其他话题不受影响。` });
    const cwd = binding?.cwd || config.defaultProject;
    const result = await send(msg, { card: cards.enginePicker({ forms: !!panel.workspaces, owner: msg.senderId, key: contextKey(msg), location: contextLabel(msg), engine, defaultEngine: defaultEngine(), cwd, engines: catalog() }) });
    rememberCard(result, msg, binding);
  }
  const selectedModel = binding => state.sessionModels[binding.id] ?? modelFor(engineOf(binding)) ?? '';
  const modelLabel = binding => {
    const next = selectedModel(binding) || (engineOf(binding) === 'codex' ? '默认（账号实时推荐）' : '默认（CLI 配置）'), active = panel.currentModel?.(binding.id);
    if (!selectedModel(binding) && active) return active;
    return panel.running(binding.id) && active && active !== selectedModel(binding) ? `${active}（下一轮：${next}）` : next;
  };
  async function modelsCard(msg, notice = '', refresh = false) {
    const binding = state.bindings[scope(msg)] || defaultBinding(msg);
    if (!binding) return send(msg, { text: '请先用 /new 选择项目，再用 /model 查看和切换模型。' });
    const engine = engineOf(binding);
    let data = { models: [] };
    try { data = await panel.models?.({ engine, sessionId: binding.id, node: nodeOf(binding), refresh }) || data; } catch {}
    if (!detailed(msg)) return send(msg, { text: `${notice ? notice + '\n' : ''}${contextLabel(msg)} · ${catalog().label(engine)}\n模型：${modelLabel(binding)}\n/model 模型ID 切换；/model default 恢复默认。${data.models.length ? '\n可用模型：\n' + data.models.map(item => item.id).join('\n') : ''}` });
    const result = await send(msg, { card: cards.modelPicker({ owner: msg.senderId, key: contextKey(msg), location: contextLabel(msg), engines: catalog(), engine, sessionId: binding.id, model: selectedModel(binding), models: data.models, accountName: data.accountName, forcedModel: data.forcedModel, notice }) });
    rememberCard(result, msg, binding);
  }
  async function setModel(msg, input, expected = {}) {
    const binding = state.bindings[scope(msg)] || defaultBinding(msg);
    if (!binding) throw new Error('请先用 /new 选择项目');
    const engine = engineOf(binding);
    if (expected.id && expected.id !== binding.id || expected.engine && expected.engine !== engine) throw new Error('会话已切换，请发送 /model 重新选择');
    if (typeof input !== 'string') throw new Error('请选择模型，或发送 /model 模型ID');
    const model = input.trim(), reset = model === 'default' || model === '__default__';
    if (!reset && (!/^[\w.\/:\[\]-]{1,100}$/.test(model) || panel.validModel && !panel.validModel(engine, model, nodeOf(binding)))) throw new Error('该引擎的模型 ID 无效');
    if (reset) delete state.sessionModels[binding.id]; else state.sessionModels[binding.id] = model;
    persist();
    return modelsCard(msg, `已${reset ? '恢复默认模型' : '选择模型：' + model}。下一轮生效，当前任务不受影响；完成后发送消息继续。`);
  }
  // 路由切换完全在网关内完成，不经过模型：账号挂了也能救回来
  async function routesCard(msg, notice = '') {
    const binding = state.bindings[contextKey(msg)];
    const status = panel.routes(binding?.engine), pinned = binding ? status.pins?.[binding.id] || '' : '';
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
    const binding = state.bindings[contextKey(msg)], status = panel.routes(binding?.engine);
    if (input.reset) { panel.resetRoutes(binding?.engine); return '已清除所有账号的冷却状态。'; }
    if (typeof input.codexCapture === 'boolean') { panel.setCodexCapture(input.codexCapture); return input.codexCapture ? 'Codex 已改为经本地代理抓包，下一轮生效。' : 'Codex 已改为直连 OpenAI，下一轮生效。'; }
    if (input.pin !== undefined) {
      if (!binding) throw new Error('当前位置还没有绑定会话');
      if (!catalog().can(engineOf(binding), 'accounts')) throw new Error(`${catalog().label(engineOf(binding))} 会话暂不支持账号路由`);
      const account = input.pin ? findAccount(status.accounts, input.pin) : null;
      if (input.pin && !account?.enabled) throw new Error('没有找到可用账号：' + input.pin);
      panel.pinRoute(binding.id, account?.id || '', binding.engine);
      return account ? `当前会话已固定到「${account.name}」，下一条请求生效。` : '当前会话已改为跟随全局路由。';
    }
    if (input.mode) { const result = panel.route({ mode: input.mode }, binding?.engine); return `已切换为${cards.MODE_NAMES[input.mode]}。${result.restartRequired ? '（客户端环境变量有变化，外部终端的 Claude 需要重开）' : ''}`; }
    if (input.selected !== undefined) {
      const account = status.accounts.find(a => a.id === input.selected) || findAccount(status.accounts, String(input.selected));
      if (!account) throw new Error('没有找到该账号，发送 /route 查看序号');
      if (!account.enabled) throw new Error(`「${account.name}」已停用，请在面板账号池启用`);
      const result = panel.route({ mode: 'manual', selected: account.id }, binding?.engine);
      if (binding?.engine === 'codex') panel.pinRoute(binding.id, account.id, binding.engine);
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
    if (!valid) { await send(msg, { text: '配对未成功。请在「IM 接入」生成配对码，再私聊发送 /pair 配对码。' }); return; }
    config.allowedUserIds = [...new Set([...config.allowedUserIds, msg.senderId])]; pairing = null; atomic(configFile, config);
    await send(msg, { text: '配对完成。发送 /sessions 查看会话，/new 选择项目，/help 查看命令。' });
  }
  // 有的引擎（如 Codex）由 CLI 生成会话 ID：提交后改绑到 Panel 返回的真实 ID
  async function submit(binding, input) {
    if (panel.resolveSession && !binding.sourceSessionId && (binding.started || !binding.machineId)) {
      const resolved = await panel.resolveSession(binding.id, binding);
      if (resolved) Object.assign(binding, bindingFor({ ...resolved, started: true }));
    }
    const engine = engineOf(binding);
    if (binding.engine !== engine) { binding.engine = engine; persist(); }
    if (panel.machineId?.() && panel.machineId() !== 'local' && !binding.machineId) throw new Error('此旧会话尚未记录执行机器，请发送 /node 选择机器和项目，再继续。系统不会把旧目录默认用于当前主节点');
    const previousId = binding.id;
    rememberSession(binding);persist();
    const node = nodeOf(binding);
    const result = await panel.submit({ sessionId: binding.sourceSessionId || binding.id, switchMachine: !!binding.sourceSessionId, cwd: binding.cwd, workspaceId: binding.workspaceId, worktree: (binding.worktreeEnabled ?? config.worktree) && !session(binding.id), model: selectedModel(binding), machineId: binding.machineId, engine, ...(node !== 'local' ? { node } : {}), ...input });
    if (result?.sessionId && result.sessionId !== binding.id) {
      binding.id = result.sessionId;
      state.sessionRefs[previousId] = {...state.sessionRefs[previousId],alias:binding.id};
      if (Object.hasOwn(state.sessionModels, previousId)) { state.sessionModels[binding.id] = state.sessionModels[previousId]; delete state.sessionModels[previousId]; }
      for (const card of Object.values(state.cards)) if (card.sessionId === previousId) { card.originalSessionId ||= previousId; card.sessionId = binding.id; }
    }
    if (result?.machineId) { binding.machineId = result.machineId; binding.node = result.machineId === panel.machineId?.() ? 'local' : result.machineId; }
    if (result?.handoff) binding.handoff = result.handoff;
    if (result?.workspaceId) binding.workspaceId = result.workspaceId;
    binding.started = true; delete binding.sourceSessionId;
    if (result?.cwd) {
      binding.cwd = result.cwd;
      const actualNode = nodeOf(binding);
      const list = actualNode === 'local' ? state.projects : (state.nodeProjects[actualNode] ||= []);
      if (!list.includes(result.cwd)) list.push(result.cwd);
    }
    if (result?.worktree) binding.worktree = result.worktree;
    rememberSession(binding);
    for (const [key, saved] of Object.entries(state.engineBindings)) if (saved[engine]?.id === previousId || state.bindings[key] === binding) rememberEngine(key, binding);
    persist();
  }
  function formSpaces() {
    return panel.workspaces?.() || { selfId: panel.machineId?.() || 'local', machines: [{ id: panel.machineId?.() || 'local', label: nodeLabel('local'), online: true }], config: { projects: [], defaults: {} } };
  }
  async function showNewForm(msg, draft, error = '') {
    const spaces = formSpaces(); let models = [];
    try { models = (await Promise.race([Promise.resolve(panel.models?.({ engine: draft.engine, node: draft.machineId === panel.machineId?.() ? 'local' : draft.machineId, refresh: false })), new Promise(resolve => { const timer = setTimeout(() => resolve({ models: [] }), 1500); timer.unref?.(); })]))?.models || []; } catch {}
    if (draft.model && !models.some(item => item.id === draft.model)) models.push({ id: draft.model, name: draft.model });
    const card = require('./feishu-new-session').newSessionForm({ draft, machines: spaces.machines, projects: spaces.config.projects, engines: catalog().list, models, error, owner: msg.senderId, key: scope(msg) });
    const sent = await send(msg, { card }); rememberCard(sent, msg); return sent;
  }
  async function newForm(msg, prompt = '', engine = defaultEngine(), prefill = {}) {
    if (prompt.length > 1000) throw new Error('表单首条问题最多 1000 字，请缩短后重试');
    const spaces = formSpaces(), current = state.bindings[scope(msg)];
    const machineId = prefill.machineId || (prefill.node && prefill.node !== 'local' ? prefill.node : prefill.node === 'local' ? spaces.selfId : '') || current?.machineId || config.defaultMachine || spaces.selfId;
    const cwd = prefill.cwd || (current?.machineId === machineId ? current?.worktree?.repository || current?.cwd : '') || (machineId === config.defaultMachine ? config.defaultProject : '') || spaces.config.defaults[machineId] || '';
    const project = spaces.config.projects.find(item => item.paths[machineId] === cwd);
    const draft = { id: crypto.randomUUID(), sessionId: crypto.randomUUID(), owner: msg.senderId, key: scope(msg), revision: 0, status: 'editing', machineId, workspaceId: project?.id || (cwd ? '__directory__' : '__default__'), cwd, engine, model: '', modelId: '', worktree: config.worktree, prompt };
    state.drafts[draft.id] = draft; persist(); return showNewForm(msg, draft);
  }
  async function submitNewForm(msg, key, value) {
    const draft = state.drafts[value.draftId];
    if (!draft || draft.owner !== msg.senderId || draft.key !== key) throw new Error('此表单已失效，请发送 /new 重新填写');
    if (draft.status === 'submitted') return currentCard(msg, draft.binding);
    if (draft.status === 'submitting') return send(msg, { text: '正在提交，请勿重复点击。' });
    if (value.revision !== draft.revision) return showNewForm(msg, draft, '这是旧版本表单，请在这张新表单中提交');
    const fields = value.fields || {}, text = name => typeof fields[name] === 'string' ? fields[name].trim() : '';
    for (const name of ['machineId','workspaceId','engine','cwd','prompt','modelId']) if (typeof fields[name] === 'string') draft[name] = text(name);
    if (typeof fields.model === 'string') draft.model = fields.model === '__default__' ? '' : fields.model;
    if (typeof fields.worktree === 'string') draft.worktree = fields.worktree !== 'original';
    draft.previousBinding = state.bindings[key] ? { ...state.bindings[key] } : null;
    draft.status = 'submitting'; persist();
    try {
      const spaces = formSpaces(), machine = spaces.machines.find(item => item.id === draft.machineId);
      if (!machine || machine.online === false) throw new Error('所选执行机器未连接，请选择在线机器');
      if (!catalog().has(draft.engine)) throw new Error('所选引擎不可用');
      if (!draft.prompt || draft.prompt.length > 1000) throw new Error('请填写不超过 1000 字的第一条问题');
      const model = draft.modelId || draft.model;
      if (model && !/^[\w.\/:\[\]-]{1,100}$/.test(model)) throw new Error('模型 ID 无效，请修改后重新提交');
      const workspace = spaces.config.projects.find(item => item.id === draft.workspaceId);
      let cwd;
      if (draft.workspaceId === '__directory__') cwd = draft.cwd;
      else if (draft.workspaceId === '__default__') cwd = spaces.config.defaults[draft.machineId] || machine.home;
      else { if (!workspace || !workspace.paths[draft.machineId]) throw new Error('所选项目尚未配置这台机器的目录，请换项目或先配置映射'); cwd = workspace.paths[draft.machineId]; }
      if (!cwd) throw new Error('请填写或选择执行目录');
      if (panel.resolveDirectory) cwd = await panel.resolveDirectory(draft.machineId, cwd);
      if (panel.validateExecution) await panel.validateExecution({ machineId: draft.machineId, engine: draft.engine, cwd });
      const proposed = { draftId: draft.id, id: draft.sessionId, machineId: draft.machineId, cwd, engine: draft.engine, workspaceId: workspace?.id, worktreeEnabled: draft.worktree };
      if (model) state.sessionModels[proposed.id] = model; else delete state.sessionModels[proposed.id];
      await run({ ...msg, turnId: messageUUID('form_' + draft.id + ':' + draft.revision) }, draft.prompt, 'steer', proposed);
      bind(key, proposed); draft.status = 'submitted'; draft.binding = { ...proposed }; persist();
    } catch (error) {
      draft.status = 'editing'; draft.revision++; persist();
      return showNewForm(msg, draft, errorText(error));
    }
  }
  async function run(msg, prompt, mode, proposed = null) {
    const key = scope(msg);
    let binding = proposed || state.bindings[key];
    if (binding && !session(binding.id) && !usable(binding)) binding = null;
    if (!binding) {
      if (!config.defaultProject) { await projectsCard(msg); return; }
      binding = bind(key, { id: crypto.randomUUID(), cwd: config.defaultProject, machineId: config.defaultMachine || panel.machineId?.(), engine: defaultEngine() });
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
    const id = msg.turnId || messageUUID(msg.messageId), view = { text: '', tools: new Map(), reasoning: new Map(), permissions: new Map(), phase: mode === 'queue' ? '已排队' : '正在处理', done: false, accepted: false };
    if (!detailed(msg)) {
      const reply = createSimpleReply({ channel, msg: { ...msg, threadId: threadOf(msg) }, messageId: id, footer: () => `${nodeLabel(nodeOf(binding))} · ${catalog().label(engineOf(binding))} · ${catalog().switchHint(engineOf(binding))} 切换引擎 · 模型：${modelLabel(binding)} · /model 切换模型`, onError: rememberError, onClose: () => monitors.delete(reply.close) });
      monitors.add(reply.close);
      try {
        await reply.start();
        if (reply.closed) return;
        await submit(binding, { prompt, images, messageId: id, mode, gatewayContext: deliveryContext(msg), ...(proposed ? { allowFailover: false } : {}) });
        reply.attach(listener => panel.watch(binding.id, listener));
      } catch (e) { await reply.close(); throw e; }
      return;
    }
    const startedAt = now(), taskModel = selectedModel(binding) || (engineOf(binding) === 'codex' ? '默认（账号实时推荐）' : '默认（CLI 配置）');
    const progress = () => cards.task({ nodeLabel: nodeLabel(nodeOf(binding)), model: view.nativeAttached ? '沿用原终端当前模型' : selectedModel(binding) || panel.currentModel?.(binding.id) || taskModel, engines: catalog(), owner: msg.senderId, key, location: contextLabel(msg), detailed: detailed(msg), binding, title: session(binding.id)?.title || clip(prompt, 80) || '图片对话', view, taskMessageId: id, elapsed: now() - startedAt });
    const sent = await send(msg, { card: progress() }); rememberCard(sent, msg, binding);
    const transport = channel;
    const saveTask = card => {
      if (state.cards[sent.messageId]) state.cards[sent.messageId].canContinue = view.accepted && view.done && ['失败', '连接已结束'].includes(view.phase);
      state.taskCards[sent.messageId] = { appId: config.appId, sessionId: binding.id, done: view.done, card, updatedAt: now(), owner: msg.senderId, chatId: msg.chatId, chatType: msg.chatType };
      persist();
    };
    saveTask(progress());
    try { await submit(binding, { prompt, images, messageId: id, mode, gatewayContext: deliveryContext(msg), ...(proposed ? { allowFailover: false } : {}) }); }
    catch (e) { view.phase = '失败'; view.text = errorText(e); view.done = true; saveTask(progress()); if (await transport.updateCard(sent.messageId, progress()).then(() => true, () => false)) { delete state.taskCards[sent.messageId]; persist(); e.reported = true; } throw e; }
    view.accepted = true;
    let timer, heartbeat, unsub, updating, shuttingDown = false, dirty = false, busy = false, closed = false, updateFailures = 0;
    const finish = () => { if (closed) return; closed = true; clearTimeout(timer); clearInterval(heartbeat); unsub?.(); monitors.delete(shutdownMonitor); };
    const flush = async () => {
      if (closed || busy) { dirty = true; return; }
      busy = true; dirty = false;
      try {
        const terminal = view.done, card = progress(); saveTask(card);
        updating = transport.updateCard(sent.messageId, card);
        await updating; updateFailures = 0;
        if (terminal && !shuttingDown) { delete state.taskCards[sent.messageId]; persist(); }
      }
      catch (e) {
        rememberError(e); updateFailures++;
        if (shuttingDown) return;
        if (updateFailures <= 3) { busy = false; timer = setTimeout(flush, 1000 * updateFailures); return; }
        if (view.done) { try { await sendLong(msg, view.phase + '\n' + (view.text || '请用 /history 查看已保存结果')); } catch (fallbackError) { rememberError(fallbackError); } finish(); }
      }
      finally { busy = false; updating = null; }
      if (shuttingDown) return;
      if (dirty) { timer = setTimeout(flush, view.done ? 0 : 1000); return; }
      if (view.done && !closed) { if (view.text.length > cards.REPLY_PREVIEW) { try { await sendLong(msg, view.text); } catch (e) { rememberError(e); } } finish(); }
    };
    const schedule = immediate => { clearTimeout(timer); if (busy) { dirty = true; return; } timer = setTimeout(flush, immediate ? 0 : 1200); };
    const shutdownMonitor = async () => {
      if (closed) return;
      shuttingDown = true; clearTimeout(timer); clearInterval(heartbeat); unsub?.();
      if (!view.done) {
        view.done = true; view.phase = '连接已结束';
        view.text += '\n\n网关连接已关闭，已停止同步进展。任务是否完成请查看会话记录。';
        for (const tool of view.tools.values()) if (tool.state === '执行中') tool.state = '结果未同步';
      }
      const card = progress(); saveTask(card);
      try {
        // A previously sent thinking update must finish before the terminal update.
        await updating?.catch(rememberError);
        await transport.updateCard(sent.messageId, card);
        delete state.taskCards[sent.messageId]; persist();
      } catch (error) { rememberError(error); }
      finally { finish(); }
    };
    heartbeat = setInterval(() => {
      if (view.done || closed) return;
      if (!view.text && !view.tools.size && now() - startedAt >= 30000 && !view.warning) {
        view.phase = '等待引擎响应';
        view.warning = '引擎尚未返回内容，可能正在连接或重试。可以停止任务，检查网络，或用 /route 查看账号状态。';
      }
      schedule(true);
    }, 15000);
    heartbeat.unref?.();
    monitors.add(shutdownMonitor);
    unsub = panel.watch(binding.id, (event, data = {}) => {
      if (closed || shuttingDown || view.done) return;
      if (event === 'stopped') { view.phase = '已停止'; view.done = true; schedule(true); return; }
      if (event === 'end' && !view.done) { view.phase = data.state === 'unknown' || view.phase === '结果待核对' ? '结果待核对' : '连接已结束'; view.done = true; if (!view.text) view.text = '本轮未完成，可用 /history 查看已保存内容后继续发送。'; schedule(true); return; }
      if (data.messageId !== id) return;
      conversationState.apply(view, event, data);
      if (view.done) saveTask(progress());
      schedule(view.done || ['native_handoff','native_attachment','native_approval','native_delivery_pending'].includes(data.kind));
    });
  }
  async function processMessage(msg) {
    if (config.disabledUserIds.includes(msg.senderId)) return;
    const text = commandText(msg, channel?.botIdentity), match = text.match(/^\/(\w+)(?:\s+([\s\S]*))?$/), name = match?.[1]?.toLowerCase(), command = name === 'session' ? 'sessions' : name, arg = match?.[2]?.trim() || '';
    if (command === 'pair') { await pair(msg, arg); return; }
    if (!allowed(msg)) { if (msg.chatType === 'p2p') await send(msg, { text: '此账号尚未配对。请在「IM 接入」生成配对码，再发送 /pair 配对码。' }); return; }
    const key = scope(msg), binding = state.bindings[key];
    const engines = catalog();
    if (command === 'leader' || command === 'cluster') {
      const info = panel.cluster?.status();
      if (!info?.enabled) throw new Error('当前以单机模式运行，尚未建立集群');
      if (arg) await panel.cluster.transfer(arg);
      const latest = panel.cluster.status();
      return send(msg, { text: `集群：${latest.clusterId}\nTimi 主节点：${latest.leader || '选举中'}\n本机：${latest.nodeId}（${latest.role}）\n成员在线：${latest.online}/${latest.members.length}\n多数派：${latest.hasQuorum ? '正常' : '不可用，网关已隔离'}\n任期：${latest.term}\n\n使用 /leader 节点名 主动迁移。` });
    }
    // /new [引擎] [项目]：首个参数可选择引擎（id 或别名）
    const firstWord = arg.split(/\s+/)[0], explicitEngine = command === 'new' ? engines.find(firstWord) : '';
    const newEngine = explicitEngine || defaultEngine();
    const newTarget = explicitEngine ? arg.slice(firstWord.length).trim() : arg;
    if (command === 'new' && panel.workspaces) return newForm(msg, newTarget, newEngine);
    if (!detailed(msg) && (['sessions', 'projects', 'switch', 'history', 'rename', 'route'].includes(command) || command === 'new' && newTarget)) return managementNotice(msg);
    if (!detailed(msg) && command === 'help') return send(msg, { text: `直接发送消息，或 @机器人，在当前位置独立会话中处理。\n/new [${engines.ids().join('|')}] 默认项目新建\n${engines.ids().map(id => '/' + id).join(' 或 ')} 切换引擎\n/model [模型ID|default] 查看或切换模型\n/current 查看当前引擎与绑定\n/node [节点名] [路径] 切换运行位置（本机 / 开发机）\n/queue 内容 排队\n/steer 内容 引导任务\n/stop 停止任务\n此群使用普通文字回复和临时思考表情，会话管理请先在面板逐项授权此群。` });
    if (!detailed(msg) && command === 'status') return send(msg, { text: `my-agents 在线 · ${contextLabel(msg)}独立会话\n当前引擎：${catalog().label(binding ? engineOf(binding) : defaultEngine())}\n${engines.switchHint(binding ? engineOf(binding) : defaultEngine())} 切换引擎\n此群使用简洁显示：普通文字回复，处理时显示思考表情。` });
    // /<引擎 id 或别名> [问题] 直接切换；/use 与 /engine 带参数时同样切换
    if (command && engines.find(command) && !['new', 'use', 'engine'].includes(command)) return useEngine(msg, engines.find(command), arg);
    if (command === 'engine' || command === 'use') {
      if (!arg) return engineCard(msg);
      const target = engines.find(arg);
      if (!target) throw new Error(`使用 ${engines.ids().map(id => '/' + id).join(' 或 ')} 切换引擎，/engine 查看当前引擎`);
      return useEngine(msg, target);
    }
    if (command === 'model') return arg ? setModel(msg, arg) : modelsCard(msg);
    if (command === 'help') return send(msg, { text: helpText(engines) });
    if (command === 'node' || command === 'nodes') {
      if (!arg) return nodesCard(msg);
      const [name, ...rest] = arg.split(/\s+/), node = findNode(name);
      if (!node) throw new Error(`没有找到节点「${name}」。发送 /node 查看可用节点`);
      return useNode(msg, node, rest.join(' ').trim());
    }
    if (command === 'sessions') return sessionsCard(msg, arg);
    if (command === 'route') return routesCard(msg, await applyRoute(msg, parseRoute(arg)));
    if (command === 'projects' || command === 'new' && !newTarget && !config.defaultProject) return projectsCard(msg, 0, newEngine);
    const newNode = binding ? nodeOf(binding) : config.defaultMachine && config.defaultMachine !== panel.machineId?.() ? config.defaultMachine : 'local';
    if (command === 'new' && newNode !== 'local') {
      const node = newNode;
      // Without a target, start fresh in the same directory on that node.
      if (!newTarget) { bind(key, { id: crypto.randomUUID(), cwd: binding?.cwd || config.defaultProject || panel.defaultDirectory?.(node), engine: newEngine, node }); return currentCard(msg, state.bindings[key]); }
      const target = newTarget.replace(/^(["'])(.*)\1$/s, '$2'), rows = nodeProjects(node);
      const cwd = /^\d+$/.test(target) ? rows[Number(target) - 1] : target.startsWith('/') || target === '~' || target.startsWith('~/') ? target : rows.find(folder => path.posix.basename(folder) === target);
      if (!cwd) throw new Error(`未找到该项目。请用 /projects 列出${nodeLabel(node)}上的项目，或用 /new 绝对路径`);
      bind(key, { id: crypto.randomUUID(), cwd, engine: newEngine, node }); return currentCard(msg, state.bindings[key]);
    }
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
        cwd = !newTarget ? binding?.cwd || panel.defaultDirectory?.(panel.machineId?.()) || config.defaultProject : /^\d+$/.test(newTarget) ? rows[Number(newTarget) - 1] : rows.find(folder => folder === newTarget || path.basename(folder) === newTarget);
      }
      if (!cwd) throw new Error('未找到该项目。请用 /projects 列出可选项目，或用 /new 绝对路径 指定本机已有目录');
      bind(key, { id: crypto.randomUUID(), cwd, engine: newEngine }); return currentCard(msg, state.bindings[key]);
    }
    if (command === 'switch') {
      const rows = panel.sessionCatalog ? (await panel.sessionCatalog({ refresh: true })).sessions : panel.sessions(), ids = state.listings[key] || [];
      const matches = /^\d+$/.test(arg) ? rows.filter(item => item.id === ids[Number(arg) - 1]) : arg ? require('./core/session-directory').searchSessions(rows, arg) : [];
      if (matches.length !== 1) { await sessionsCard(msg, /^\d+$/.test(arg) ? '' : arg); return; }
      bind(key, bindingFor(matches[0])); return currentCard(msg, state.bindings[key]);
    }
    if (command === 'status') return send(msg, { text: `my-agents 在线\n${runtime.status().keepAwake ? 'Mac 保活已开启' : 'Mac 保活未开启'}\n绑定范围：${contextLabel(msg)}\n当前会话：${binding ? session(binding.id)?.title || binding.id : '尚未选择'}\n运行位置：${nodeLabel(binding ? nodeOf(binding) : 'local')}\n当前引擎：${catalog().label(binding ? engineOf(binding) : defaultEngine())}\n默认引擎：${catalog().label(defaultEngine())}\n默认项目：${config.defaultProject || '未配置'}` });
    if (['current', 'history', 'rename', 'stop'].includes(command)) {
      if (command === 'current') { const current = binding || defaultBinding(msg); return current ? currentCard(msg, current) : projectsCard(msg); }
      if (!binding) return sessionsCard(msg);
      if (command === 'stop') { const result = await panel.stop(binding.id); return send(msg, { text: result?.detached ? '已断开 IM 同步，原终端窗口仍保持运行。' : '已发送停止请求。' }); }
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
    const rawValue = evt.action?.value;
    let value = rawValue?.action === 'set_model' ? { ...rawValue, model: evt.action.option } : rawValue;
    if (['new_submit','sessions_search'].includes(value?.action)) value = { ...value, fields: evt.action?.form_value || evt.raw?.action?.form_value || evt.raw?.event?.action?.form_value || {} };
    let keyChatType;
    try { const parts = JSON.parse(value?.key); if (Array.isArray(parts) && parts.length === 3 && parts[1] === evt.chatId && value.owner === evt.operator?.openId) keyChatType = parts[0] === value.owner ? 'p2p' : parts[0] === '*' ? 'group' : undefined; } catch {}
    const msg = { messageId: evt.messageId, senderId: evt.operator?.openId, chatId: evt.chatId, chatType: evt.chatType || inbox.chatType(config.appId, evt.chatId) || state.cards[evt.messageId]?.chatType || keyChatType || 'group', content: '' };
    if (!value || typeof value !== 'object' || !allowed(msg)) return;
    if (value.owner !== msg.senderId) return send(msg, { text: '这张卡片仅限发起人操作，请发送 /sessions 获取自己的会话列表。' });
    if (!detailed(msg) && value.action !== 'new_submit') return managementNotice(msg);
    if (value.key) {
      let parts;
      try { parts = JSON.parse(value.key); } catch { return send(msg, { text: '卡片上下文无效，请发送 /sessions 刷新列表。' }); }
      if (!Array.isArray(parts) || parts.length !== 3) return send(msg, { text: '卡片上下文无效，请发送 /sessions 刷新列表。' });
      const [owner, chat, thread] = parts;
      if ((owner !== msg.senderId && !(owner === '*' && msg.chatType !== 'p2p')) || chat !== msg.chatId || typeof thread !== 'string') return send(msg, { text: '此卡片不属于当前位置，请发送 /sessions 刷新列表。' });
      const saved = state.cards[evt.messageId];
      if (saved?.key && saved.key !== value.key) return send(msg, { text: '此卡片的会话位置已变化，请发送 /sessions 刷新列表。' });
      if (thread !== 'main') msg.threadId = thread;
    }
    const key = scope(msg);
    return withLock(contextKey(msg), () => cardAction(msg, key, value));
  }
  async function cardAction(msg, key, value) {
    try {
      if (value.node === panel.machineId?.()) value = { ...value, node: 'local' };
      const origin = state.cards[msg.messageId];
      if (['use_node','use_engine','set_model','stop','permission','continue_task'].includes(value.action) && origin?.sessionId && state.bindings[key]?.id !== origin.sessionId) throw new Error('会话已切换，请发送 /current 获取最新操作卡片');
      if (value.action === 'new_submit') return submitNewForm(msg, key, value);
      if (value.action === 'new_form') return panel.workspaces ? newForm(msg, '', catalog().fallback(value.engine, defaultEngine()), value) : projectsCard(msg, 0, value.engine);
      if (value.action === 'models') return await modelsCard(msg, '', value.refresh === true);
      if (value.action === 'set_model') return await setModel(msg, value.model, value);
      if (value.action === 'engine') return engineCard(msg);
      if (value.action === 'use_engine') { if (!catalog().has(value.engine)) throw new Error('引擎无效'); return useEngine(msg, value.engine); }
      if (value.action === 'sessions') return sessionsCard(msg, String(value.query || ''), value.page);
      if (value.action === 'sessions_search') return sessionsCard(msg, String(value.fields?.query || ''), 0);
      if (value.action === 'projects') return projectsCard(msg, value.page, value.engine, typeof value.node === 'string' ? value.node : null);
      if (value.action === 'nodes') return nodesCard(msg);
      if (value.node === panel.machineId?.()) value = { ...value, node: 'local' };
      if (value.action === 'use_node') { const node = typeof value.node === 'string' && (value.node === 'local' || remoteNodes().some(item => item.id === value.node)) ? value.node : ''; if (!node) throw new Error('节点无效'); return useNode(msg, node); }
      if (value.action === 'route') return routesCard(msg, await applyRoute(msg, { ...(typeof value.selected === 'string' ? { selected: value.selected } : {}), ...(['failover', 'round-robin'].includes(value.mode) ? { mode: value.mode } : {}), ...(value.reset === true ? { reset: true } : {}), ...(typeof value.codexCapture === 'boolean' ? { codexCapture: value.codexCapture } : {}) }));
      if (value.action === 'new') {
        const node = typeof value.node === 'string' && value.node !== 'local' ? value.node : 'local';
        if (!nodeProjects(node).includes(value.cwd)) throw new Error('此项目当前不可用');
        bind(key, { id: crypto.randomUUID(), cwd: value.cwd, engine: catalog().fallback(value.engine, defaultEngine()), ...(node !== 'local' ? { node } : {}) }); return currentCard(msg, state.bindings[key]);
      }
      const original = state.cards[msg.messageId];
      const repaired = original?.repairedAt && ['view','history','switch','user_messages'].includes(value.action);
      const migrated = original?.originalSessionId && original.originalSessionId === value.id;
      const targetId = referenceId(repaired || migrated ? original.sessionId : value.id);
      const remembered = original?.sessionId === targetId ? { ...original, id: targetId, project: original.cwd } : null;
      const cached = [state.bindings[key], ...Object.values(state.engineBindings[key] || {})].find(item => item?.id === targetId);
      let hint = value.session?.id === targetId ? value.session : remembered || cached || state.sessionRefs[targetId];
      if (!hint?.cwd && !hint?.project && panel.sessionCatalog) {
        const directory = await panel.sessionCatalog({ refresh: true, query: targetId });
        const found = directory.sessions.find(item => item.id === targetId);
        if (found) hint = { ...hint, ...found };
      }
      const resolved = panel.resolveSession ? await panel.resolveSession(targetId, hint || {}) : null;
      const item = resolved ? { ...session(targetId), ...resolved, started: true } : session(targetId) || (hint ? { ...hint, id: targetId, project: hint.project || hint.cwd, title: hint.title || '原会话' } : null);
      if (!item && value.action === 'history' && state.bindings[key]?.id === targetId) return send(msg, { text: '这段会话暂无已保存的对话，发送问题开始后可再查看。' });
      if (!item) return recoverSessionCard(msg,key,targetId);
      if (['stop','permission'].includes(value.action) && value.taskMessageId && panel.activeMessageId && panel.activeMessageId(item.id) !== value.taskMessageId) throw new Error('这张卡片对应的任务已结束，请发送 /current 查看当前任务');
      if (value.action === 'continue_task') {
        if (!origin?.canContinue || referenceId(origin.sessionId) !== targetId) throw new Error('此任务已续接或不需要继续，请查看当前会话');
        if (panel.running?.(item.id)) throw new Error('该会话仍有任务运行，请等待结束后继续');
        // Claim under the conversation lock, before starting another turn. A
        // runtime failure belongs to this session; never reopen its /new draft.
        origin.canContinue = false; persist();
        bind(key, bindingFor(item));
        try {
          return await run({ ...msg, turnId: crypto.randomUUID() }, '继续完成上一轮中断的任务。先查看已有对话、工具结果和当前工作状态，核对已经完成的操作；不要重复执行已经成功的修改或外部操作，从尚未完成的步骤继续。如果缺少必要上下文或执行条件，请说明原因。', 'steer');
        } catch (error) { origin.canContinue = true; persist(); throw error; }
      }
      if (value.action === 'permission') { await panel.permission(item.id, value.requestId, value.behavior); return send(msg, { text: value.behavior === 'allow' ? '已允许本次工具调用。' : '已拒绝本次工具调用。' }); }
      if (value.action === 'stop') { const result = await panel.stop(item.id); return send(msg, { text: result?.detached ? '已断开 IM 同步，原终端窗口仍保持运行。' : '已发送停止请求。' }); }
      if (value.action === 'user_messages') {
        const data = panel.sessionUserPage ? await panel.sessionUserPage(item, value.page) : require('./core/session-previews').userMessagePage({ messages: await panel.history(item.id, item.machineId) }, value.page, item);
        const listing = state.cards[msg.messageId]?.listing || { page: value.listPage || 0, query: value.query || '' };
        const result = await send(msg, { card: cards.sessionUserMessages({ engines: catalog(), owner: msg.senderId, key, item, data, listPage: listing.page, query: listing.query }) });
        rememberCard(result, msg);
        if (result?.messageId) { state.cards[result.messageId].listing = listing; persist(); }
        return result;
      }
      if (value.action === 'view') return currentCard(msg, bindingFor(item));
      if (value.action === 'history') return historyReply(msg, bindingFor(item));
      bind(key, bindingFor(item));
      return currentCard(msg, state.bindings[key], value.action === 'switch', item);
    } catch (e) { rememberError(e); await send(msg, { text: errorText(e) }); }
  }
  async function recoverTaskCards() {
    const pending = Object.entries(state.taskCards);
    for (const [messageId, saved] of pending) {
      if (saved.appId !== config.appId) continue;
      let card = saved.card;
      if (!saved.done) {
        card = JSON.parse(JSON.stringify(card));
        card.header.title.content = '连接已结束'; card.header.template = 'grey';
        card.config.summary = { content: '网关已重启，旧任务进展已停止同步' };
        card.body.elements.unshift(cards.markdown('网关已重启，这张卡片的实时连接已结束。任务是否完成请查看会话记录。'));
        const stripActions = node => {
          if (!node || typeof node !== 'object') return;
          if (Array.isArray(node)) {
            for (let index = node.length - 1; index >= 0; index--) {
              const item = node[index];
              if (item?.tag === 'button' && item.behaviors?.some(behavior => ['stop', 'permission'].includes(behavior.value?.action))) node.splice(index, 1);
              else stripActions(item);
            }
          } else Object.values(node).forEach(stripActions);
        };
        stripActions(card);
      }
      try { await channel.updateCard(messageId, card); delete state.taskCards[messageId]; persist(); }
      catch (error) { rememberError(error); }
    }
  }
  async function stop() {
    channelEpoch++;
    await Promise.allSettled([...monitors].map(finish => finish()));
    const old = channel; channel = null;
    if (old) await old.disconnect().catch(() => {});
    phase = 'disabled';
  }
  async function start() {
    if (connecting) return connecting;
    if (leadership && !leadership.canStart()) throw Object.assign(new Error('当前节点不是持有多数派租约的集群主节点'), { status: 409 });
    if (!config.enabled) { phase = 'disabled'; return; }
    if (phase === 'connected' && (!channel?.getConnectionStatus || channel.getConnectionStatus()?.state === 'connected')) return;
    connecting = (async () => {
      await inbox.ready;
      await stop(); phase = 'connecting'; lastError = '';
      const factory = channelFactory || (options => require('@larksuiteoapi/node-sdk').createLarkChannel(options));
      const sdk = channelFactory ? null : require('@larksuiteoapi/node-sdk');
      channel = factory({ includeRawEvent: true, appId: config.appId, appSecret: config.appSecret, domain: config.domain === 'lark' ? sdk?.Domain.Lark || 'https://open.larksuite.com' : sdk?.Domain.Feishu || 'https://open.feishu.cn', policy: { dmMode: 'open', requireMention: false, respondToMentionAll: true }, safety: { chatQueue: { enabled: false }, batch: { text: { delayMs: 0, longDelayMs: 0, maxMessages: 1 }, media: { delayMs: 0, maxItems: 1 } } }, wsConfig: { pingTimeout: 20 }, outbound: { streamThrottleMs: 1200 }, logger: { error: rememberError, warn() {}, info() {}, debug() {}, trace() {} }, loggerLevel: sdk?.LoggerLevel.error });
      const candidate = channel, epoch = channelEpoch;
      const ownsConnection = () => channel === candidate && epoch === channelEpoch && (!leadership || leadership.canStart());
      channel.on('message', msg => { if (ownsConnection()) receive(msg).catch(rememberError); }); channel.on('cardAction', evt => { if (ownsConnection()) action(evt).catch(rememberError); });
      channel.on('error', error => { if (ownsConnection()) rememberError(error); }); channel.on('reconnecting', () => { if (ownsConnection()) phase = 'reconnecting'; }); channel.on('reconnected', () => { if (!ownsConnection()) return; phase = 'connected'; if (/\[ws\]|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|WebSocket/i.test(lastError)) lastError = ''; });
      await candidate.connect();
      if (!ownsConnection()) { await candidate.disconnect().catch(() => {}); return; }
      phase = 'connected';
      await recoverTaskCards();
      await inbox.ready;
      contacts.refresh(false).catch(() => {});
    })().catch(async e => { rememberError(e); await stop(); phase = 'error'; throw new Error(lastError || '飞书连接失败'); }).finally(() => { connecting = null; });
    return connecting;
  }
  async function configure(input) {
    const next = { ...config };
    for (const key of ['enabled', 'keepAwake', 'cardCallbacksReady', 'worktree', 'allowAllUsers', 'allowAllGroups']) if (key in input) { if (typeof input[key] !== 'boolean') throw new Error('配置类型无效'); next[key] = input[key]; }
    for (const key of ['appId', 'domain', 'defaultProject', 'defaultMachine', 'defaultEngine', 'model']) if (key in input) { if (typeof input[key] !== 'string') throw new Error('配置类型无效'); next[key] = input[key].trim(); }
    if (input.appSecret) next.appSecret = String(input.appSecret).trim();
    for (const key of ['allowedUserIds', 'disabledUserIds', 'allowedChatIds']) if (key in input) {
      if (!Array.isArray(input[key]) || input[key].some(value => typeof value !== 'string' || !/^[a-zA-Z0-9_-]{3,100}$/.test(value))) throw new Error('飞书用户或群聊 ID 无效'); next[key] = [...new Set(input[key])];
    }
    if (!catalog().has(next.defaultEngine)) throw new Error(`请选择 ${catalog().list.map(engine => engine.label).join(' 或 ')} 作为默认引擎`);
    if (!['feishu', 'lark'].includes(next.domain)) throw new Error('请选择飞书或 Lark');
    if (next.enabled && (!/^[a-zA-Z0-9_-]{8,100}$/.test(next.appId) || !next.appSecret || next.appSecret.length > 1000)) throw new Error('请填写有效的 App ID 和 App Secret');
    if ('defaultProject' in input || 'defaultMachine' in input) {
      next.defaultMachine ||= panel.machineId?.() || '';
      if (next.defaultProject) { if (panel.resolveDirectory) next.defaultProject = await panel.resolveDirectory(next.defaultMachine, next.defaultProject); else { next.defaultProject = fs.realpathSync(next.defaultProject); if (!fs.statSync(next.defaultProject).isDirectory()) throw new Error('默认项目必须是文件夹'); } }
    }
    if (next.model && !/^[\w.\/:\[\]-]{1,100}$/.test(next.model)) throw new Error('模型名称无效');
    if (next.appId !== config.appId || next.domain !== config.domain) { next.cardCallbacksReady = input.cardCallbacksReady || false; next.allowAllUsers = input.allowAllUsers || false; next.allowAllGroups = input.allowAllGroups || false; next.allowedUserIds = input.allowedUserIds || []; next.disabledUserIds = input.disabledUserIds || []; pairing = null; state = { bindings: {}, engineBindings: {}, cards: {}, sessionRefs: {}, taskCards: {}, sessionModels: {}, listings: {}, receipts: [], projects: [], nodeProjects: {}, drafts: {} }; persist(); }
    const reconnect = next.enabled !== config.enabled || next.appId !== config.appId || next.appSecret !== config.appSecret || next.domain !== config.domain;
    if (reconnect) await stop();
    config = next; atomic(configFile, config); applyRuntime();
    // Access rules are evaluated locally for every message; changing them must
    // not interrupt an existing connection or its live task cards.
    if (config.enabled && (!leadership || leadership.canStart()) && (reconnect || ['disabled', 'error'].includes(phase))) await start();
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
    return { execution: { selfId: panel.machineId?.() || 'local', machines: panel.machines?.() || [] }, capabilities: { contactNames: true }, config: { ...safe, hasSecret: !!appSecret }, phase: actualPhase, lastError, sdkAvailable, bot: channel?.botIdentity?.name || '', connection, runtime: runtime.status(), bindings: Object.values(state.bindings).length, inbox: inbox.contacts(config.appId) };
  }
  return {
    start, stop, configure, status, receive, action, repairCard, sendReply, labelContact, refreshContacts,
    bootstrapRuntime: applyRuntime,
    async reload() { await stop(); reloadFiles(); applyRuntime(); return status(); },
    revealSecret: () => config.appSecret,
    messages: options => inbox.messages(config.appId, options),
    newPairing() { pairing = { code: crypto.randomBytes(9).toString('base64url'), expires: now() + 10 * 60 * 1000 }; return { command: '/pair ' + pairing.code, expiresAt: pairing.expires }; },
    bootstrap() { applyRuntime(); return start(); },
  };
}
module.exports = { createFeishuGateway, contextKey, messageUUID, errorMessage };
