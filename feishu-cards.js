const path = require('path');
const { previewText } = require('./core/session-previews');
const { engineCatalog } = require('./channels/engine-catalog');
const PAGE_SIZE = 5;
const SESSION_PAGE_SIZE = 15;
const REPLY_PREVIEW = 2200;
const clip = (value, max) => { const chars = Array.from(String(value || '')); return chars.length > max ? chars.slice(0, max).join('') + '…' : chars.join(''); };
const escape = value => String(value || '').replace(/([\\`*_[\]<>])/g, '\\$1').replace(/\s+/g, ' ');
const plain = value => ({ tag: 'plain_text', content: String(value || '') });
const markdown = (content, small = false) => ({ tag: 'markdown', content: String(content || '').replace(/<at\b/gi, '&lt;at'), text_size: small ? 'notation' : 'normal' });
const muted = content => markdown(`<font color='grey'>${content}</font>`, true);
const button = (text, value, type = 'default') => ({ tag: 'button', text: plain(text), type, behaviors: [{ type: 'callback', value }] });
const buttons = items => ({ tag: 'column_set', flex_mode: 'none', columns: [{ tag: 'column', width: 'weighted', weight: 1, elements: Array.from({ length: Math.ceil(items.length / 2) }, (_, i) => ({ tag: 'column_set', flex_mode: 'none', horizontal_spacing: '8px', columns: items.slice(i * 2, i * 2 + 2).map(item => ({ tag: 'column', width: 'weighted', weight: 1, elements: [{ ...item, width: 'fill' }] })) })) }] });
const collapse = (title, elements, expanded = false, id) => ({ tag: 'collapsible_panel', ...(id ? { element_id: id } : {}), expanded, header: { title: plain(title), icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' }, icon_position: 'right', icon_expanded_angle: -180 }, border: { color: 'grey', corner_radius: '5px' }, vertical_spacing: '8px', padding: '8px 8px 8px 8px', elements });
function card(title, elements, { subtitle = 'my-agents · 工作空间', template = 'grey', summary = title } = {}) {
  return { schema: '2.0', config: { width_mode: 'default', update_multi: true, summary: { content: clip(summary, 120) } }, header: { title: plain(clip(title, 64)), subtitle: plain(clip(subtitle, 100)), template }, body: { padding: '12px 16px 12px 16px', vertical_spacing: '12px', elements } };
}
// Cards name engines through the catalog the gateway passes in (`context.engines`).
const catalogOf = context => context.engines || engineCatalog();
const sessionReference = item => ({ id: item.id, machineId: item.machineId || (item.node !== 'local' ? item.node : undefined), engine: item.engine, cwd: item.cwd || item.project, workspaceId: item.workspaceId });
const action = (context, value) => ({ ...value, ...(value.id && value.id === context.session?.id && (context.session.machineId || context.session.cwd) ? { session: context.session } : {}), owner: context.owner, key: context.key });
function row(title, detail, operation) {
  return { tag: 'column_set', flex_mode: 'stretch', horizontal_spacing: '12px', columns: [
    { tag: 'column', width: 'weighted', weight: 1, elements: [markdown(`**${title}**`), muted(detail)] },
    { tag: 'column', width: 'auto', vertical_align: 'center', elements: [operation] },
  ] };
}
function sessionTime(value, timeZone) {
  if (!value) return '未记录';
  const at = typeof value === 'number' ? (value < 1e11 ? value * 1000 : value) : value;
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? '未记录' : new Intl.DateTimeFormat('zh-CN', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}
function sessionList({ rows, total, page, query, selected, ...context }) {
  const pages = Math.max(1, Math.ceil(total / SESSION_PAGE_SIZE));
  const timeZone = context.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const render = (previewSize, titleSize, previewCount) => {
    const elements = [muted(`${context.location ? context.location + ' · ' : ''}共 ${total} 个会话 · 第 ${page + 1} / ${pages} 页${query ? ' · 筛选：' + escape(clip(query, 50)) : ''}`)];
    rows.forEach((item, index) => {
      const rowContext = { ...context, session: { ...sessionReference(item), cwd: undefined } };
      const number = page * SESSION_PAGE_SIZE + index + 1, current = item.id === selected;
      const title = previewText(item.title) || (item.title ? '图片会话' : '未命名会话');
      const turns = Number.isInteger(item.turns) ? `${item.turns} 轮` : '轮次未记录';
      const messages = previewCount ? (item.userMessages || []).slice(-previewCount) : [];
      const previews = messages.map(message => `**第 ${message.round} 轮 · ${sessionTime(message.timestamp, timeZone)}**\n${escape(clip(message.text, previewSize))}`);
      if (!previews.length) previews.push(!previewCount ? '点击下方按钮查看用户消息。' : item.previewUnavailable ? '暂时无法读取用户消息；远程历史可能尚未同步。' : '暂无已保存的用户消息。');
      const contents = !previewCount && (item.userMessages || []).length ? [] : [markdown(previews.join('\n\n'), true)];
      if ((item.userMessages || []).length) contents.push(button('查看全部用户消息', action(context, { action: 'user_messages', id: item.id })));
      const line = row('', `${escape(clip(item.machineId || item.node || '机器未记录',24))} · ${catalogOf(context).label(item.engine || 'claude')} · ${escape(clip(path.basename(item.worktree?.repository || item.project || ''), 24)) || '未指定项目'} · ${turns} · ${current ? '● 当前会话' : item.running ? '● 运行中' : '可接续'}\n创建 ${sessionTime(item.createdAt || item.first, timeZone)} · 最近 ${sessionTime(item.lastAt || item.last, timeZone)}`, button(current ? '继续' : '切换', action(rowContext, { action: 'switch', id: item.id }), current ? 'primary' : 'default'));
      line.columns[0].elements[0] = { tag: 'collapsible_panel', expanded: false, header: { title: plain(`${number}. ${clip(title, titleSize)}`), icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined' }, icon_position: 'left' }, elements: contents };
      delete line.flex_mode; delete line.horizontal_spacing; delete line.columns[1].vertical_align;
      elements.push(line);
    });
    if (!rows.length) elements.push(markdown('没有找到匹配的会话。试试其他关键词，或新建一个会话。'));
    const navigation = [];
    if (page > 0) navigation.push(button('← 上一页', action(context, { action: 'sessions', page: page - 1, query })));
    if (page + 1 < pages) navigation.push(button('下一页 →', action(context, { action: 'sessions', page: page + 1, query })));
    navigation.push(button('刷新', action(context, { action: 'sessions', page, query })), button('＋ 新建会话', action(context, { action: 'new_form' }), 'primary'));
    elements.push(buttons(navigation), muted(`点击会话标题展开用户消息；轮次按实际用户发送次数统计。时间：${timeZone}。/sessions 关键词筛选；/switch 序号切换。`));
    return card('最近会话', elements, { summary: `${total} 个会话 · 选择一个继续工作` });
  };
  // Collapsed content still counts toward Feishu's 30 KB limit.
  let output;
  for (const [previewSize, titleSize, previewCount] of [[90, 60, 2], [50, 45, 2], [24, 30, 1], [12, 20, 1], [0, 20, 0]]) {
    output = render(previewSize, titleSize, previewCount);
    if (Buffer.byteLength(JSON.stringify({ msg_type: 'interactive', content: JSON.stringify(output) })) < 28000) break;
  }
  return output;
}
function sessionUserMessages({ item, data, listPage = 0, query = '', ...context }) {
  context.session = sessionReference(item);
  const timeZone = context.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const elements = [markdown(`**${escape(clip(previewText(item.title) || '图片会话', 90))}**`), muted(`${catalogOf(context).label(item.engine || 'claude')} · ${data.turns === null ? '轮次未记录' : data.turns + ' 轮'} · 第 ${data.page + 1} / ${data.pages} 页`), muted(`创建 ${sessionTime(data.createdAt || item.first, timeZone)} · 最近 ${sessionTime(data.lastAt || item.last, timeZone)}`)];
  for (const message of data.messages) elements.push(markdown(`**第 ${message.round} 轮 · ${sessionTime(message.timestamp, timeZone)}**\n${escape(clip(message.text, 1000))}`));
  if (!data.messages.length) elements.push(markdown(data.previewUnavailable ? '暂时无法读取用户消息。' : '暂无用户消息。'));
  const values = { action: 'user_messages', id: item.id, listPage, query };
  const navigation = [];
  if (data.page + 1 < data.pages) navigation.push(button('← 更早消息', action(context, { ...values, page: data.page + 1 })));
  if (data.page > 0) navigation.push(button('较新消息 →', action(context, { ...values, page: data.page - 1 })));
  navigation.push(button('返回会话列表', action(context, { action: 'sessions', page: listPage, query })), button('继续此会话', action(context, { action: 'switch', id: item.id }), 'primary'));
  elements.push(collapse('项目路径与会话 ID', [markdown(`${escape(item.project)}\n\`${item.id}\``, true)]), buttons(navigation), muted('这里只展示用户发送的消息；长消息显示摘要，邮箱已隐藏。完整原文保留在本机面板。'));
  return card('会话用户消息', elements);
}
function projectList({ rows, total, page, defaultProject, engine = 'claude', node = 'local', nodeLabel = '本机', ...context }) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE)), engines = catalogOf(context), remote = node !== 'local';
  const at = remote ? { node } : {};
  const elements = [muted(`${escape(nodeLabel)} · 选择项目，新建 ${engines.label(engine)} 会话 · ${page + 1} / ${pages}`)];
  rows.forEach((cwd, index) => elements.push(row(`${page * PAGE_SIZE + index + 1}. ${escape(path.posix.basename(cwd) || cwd)}`, cwd === defaultProject ? '默认项目' : escape(clip(path.posix.dirname(cwd), 80)), button('新建会话', action(context, { action: context.forms ? 'new_form' : 'new', cwd, engine, ...at })))));
  if (!rows.length) elements.push(markdown(remote ? `${escape(nodeLabel)}上还没有用过的项目。发送 /node ${node} 开发机上的绝对路径 开始。` : '还没有可用项目。发送 /new 绝对路径 指定本机已有目录，或在 Panel 选择默认项目。'));
  const navigation = [];
  if (page > 0) navigation.push(button('← 上一页', action(context, { action: 'projects', page: page - 1, engine, ...at })));
  if (page + 1 < pages) navigation.push(button('下一页 →', action(context, { action: 'projects', page: page + 1, engine, ...at })));
  for (const other of engines.others(engine)) navigation.push(button(`改用 ${other.label}`, action(context, { action: 'projects', page, engine: other.id, ...at })));
  navigation.push(button('切换运行位置', action(context, { action: 'nodes' })), button('返回会话', action(context, { action: 'sessions' })));
  elements.push(buttons(navigation), muted(remote ? `使用未列出的目录：发送 /node ${node} /绝对路径（支持 ~/）。目录须已在${escape(nodeLabel)}上创建。` : `使用未列出的目录：发送 /new ${engine} /绝对路径（支持 ~/，路径有空格也可直接粘贴）。目录须已在本机创建，选用后会保留在列表中。`));
  return card('选择工作项目', elements, { subtitle: `my-agents · ${nodeLabel}` });
}
function nodePicker({ node = 'local', nodes = [], engine = 'claude', ...context }) {
  const engines = catalogOf(context);
  const current = nodes.find(item => item.id === node)?.label || node;
  const elements = [markdown(`**${context.location || '当前位置'} · 运行位置：${escape(current)}**`), muted(`当前引擎：${engines.label(engine)}。切换后在该机器上接续上一次会话，没有则选择项目新建。`)];
  for (const item of nodes) {
    const here = item.id === node;
    const detail = item.id === 'local' ? '当前面板的执行机器' : `${item.connected ? '在线' : '离线'}${item.platform ? ' · ' + escape(item.platform) : ''}`;
    elements.push(row(escape(item.label || item.id), detail, here ? button('当前', action(context, { action: 'nodes' }), 'primary') : item.connected ? button('切到这里', action(context, { action: 'use_node', node: item.id })) : button('离线', action(context, { action: 'nodes' }))));
  }
  if (nodes.length < 2) elements.push(markdown('还没有远程节点。请在「机器与引擎」添加执行机器。'));
  elements.push(muted(`/node 节点名 路径 直接切到某台机器的指定目录，例如 /node ${escape(nodes[1]?.id || 'devbox')} ~/repos/项目。远程节点上的 Claude 和 Codex 都走面板的账号与抓包。`));
  return card('选择运行位置', elements, { subtitle: `my-agents · ${current}` });
}
function enginePicker({ engine = 'claude', defaultEngine = 'claude', cwd, ...context }) {
  const engines = catalogOf(context), ids = engines.ids();
  const elements = [markdown(`**${context.location || '当前位置'} · 当前引擎：${engines.label(engine)}**`), muted(`默认启动引擎：${engines.label(defaultEngine)}。不同话题独立绑定，同一话题成员共用。`), markdown('切换时接续该引擎上一次会话，无历史则新建。各引擎分别保留上下文。')];
  elements.push(buttons(ids.map(id => button(`使用 ${engines.label(id)}`, action(context, cwd ? { action: 'use_engine', engine: id } : { action: context.forms ? 'new_form' : 'projects', engine: id }), id === engine ? 'primary' : 'default'))));
  elements.push(muted(`${ids.map(id => '/' + id).join('、')} 可直接带问题；/engine 查看当前引擎；${ids.map(id => '/new ' + id).join(' 或 ')} 强制新建。`));
  return card('选择会话引擎', elements);
}
function permissions(context, binding, requests) {
  const elements = [];
  for (const request of requests.slice(0, 3)) {
    const preview = request.input?.command || request.input?.file_path || request.input?.url;
    elements.push(markdown(`**需要授权 · ${escape(request.tool)}**${request.description ? '\n' + escape(clip(request.description, 120)) : ''}${preview ? '\n```\n' + clip(preview, 180) + '\n```' : ''}`));
    elements.push(collapse('查看本次调用参数', [markdown('```json\n' + clip(JSON.stringify(request.input || {}, null, 2), 400) + '\n```', true)]));
    elements.push(buttons([button('允许本次调用', action(context, { action: 'permission', id: binding.id, requestId: request.id, ...(context.taskMessageId ? { taskMessageId: context.taskMessageId } : {}), behavior: 'allow' }), 'primary'), button('拒绝', action(context, { action: 'permission', id: binding.id, requestId: request.id, ...(context.taskMessageId ? { taskMessageId: context.taskMessageId } : {}), behavior: 'deny' }))]));
  }
  if (requests.length > 3) elements.push(muted(`另有 ${requests.length - 3} 项等待授权，处理后会依次显示。`));
  return elements;
}
function modelPicker({ engine, sessionId, model = '', models = [], accountName = '', forcedModel = '', notice = '', ...context }) {
  const options = new Map(models.filter(item => typeof item.id === 'string' && item.id.length <= 100).slice(0, 50).map(item => [item.id, item.name || item.id]));
  if (model) options.set(model, options.get(model) || model);
  const elements = [markdown(`**${context.location || '当前位置'} · ${catalogOf(context).label(engine)}**`), markdown(`模型：**${escape(model || '默认（CLI 配置）')}**`)];
  if (notice) elements.push(markdown(escape(notice)));
  if (accountName) elements.push(muted(`代理账号：${escape(accountName)}`));
  if (forcedModel) elements.push(muted(`账号固定映射到 ${escape(forcedModel)}，会覆盖这里的模型选择。`));
  elements.push({ tag: 'select_static', placeholder: plain('选择模型'), width: 'fill', initial_option: model || '__default__', options: [
    { text: plain(engine === 'codex' ? '默认（账号实时推荐）' : '默认（跟随网关 / CLI 配置）'), value: '__default__' },
    ...Array.from(options, ([id, name]) => ({ text: plain(clip(name, 48)), value: id })),
  ], behaviors: [{ type: 'callback', value: action(context, { action: 'set_model', id: sessionId, engine }) }] });
  elements.push(muted('下一轮生效，当前任务不受影响。/model 模型ID 可手动指定；/model default 恢复默认。模型选择按会话保存。'));
  if (!models.length) elements.push(muted('该引擎暂未返回模型列表，可使用命令输入模型 ID。'));
  if (models.length > 50) elements.push(muted('下拉框展示前 50 个模型，其余可用 /model 模型ID 指定。'));
  elements.push(buttons([button('刷新模型', action(context, { action: 'models', refresh: true })), button('查看会话', action(context, { action: 'switch', id: sessionId }))]));
  return card('查看 / 切换模型', elements);
}
function currentSession({ binding, item, exists = false, running, model = '默认（CLI 配置）', requests = [], nodeLabel = '本机', ...context }) {
  context.session = sessionReference(binding);
  const pending = !item && !exists, title = item?.title || '新会话', engines = catalogOf(context), engineId = item?.engine || binding.engine || 'claude', engine = engines.label(engineId);
  const projectName = path.posix.basename(binding.worktree?.repository || binding.cwd) || binding.cwd, project = escape(projectName), where = escape(nodeLabel);
  const elements = pending ? [markdown(`**当前项目：${project}**`), muted(`${context.location || '当前位置'} · ${engine} · ${where} · 项目确认后，直接发送问题开始对话`)] : [markdown(`**${escape(clip(title, 100))}**`), muted(`${context.location ? context.location + ' · ' : ''}${engine} · ${where} · ${project} · ${running ? '● 正在运行' : '已就绪，直接发消息继续'}`)];
  elements.push(muted(`模型：${escape(model)}`));
  if (nodeLabel) elements.push(muted(`执行机器：${escape(nodeLabel)}`));
  if (binding.handoff) elements.push(markdown(`**${binding.handoff.from === binding.handoff.to ? '已创建接续会话 · ' + escape(binding.handoff.to) : '执行位置已切换：' + escape(binding.handoff.from) + ' → ' + escape(binding.handoff.to)}**\n${binding.handoff.reason === 'offline' ? '原机器离线，接管机器已接续新一轮。' : '已按手动选择创建接续会话。'}${binding.handoff.context === 'checkpoint' ? '上下文来自有限的对话检查点，文件和工具状态需核对。' : '没有可恢复的对话检查点，请补充必要上下文。'}`));
  if (binding.worktree) elements.push(muted(`独立工作区 · ${escape(binding.worktree.branch)}`));
  elements.push(...permissions(context, binding, requests), collapse(pending ? '项目位置' : '会话信息', [markdown(pending ? escape(binding.cwd) : `${escape(binding.cwd)}\n\`${binding.id}\``, true)]));
  const actions = pending ? [button('切换项目', action(context, { action: context.forms ? 'new_form' : 'projects', engine: engineId }), 'primary'), button('切换引擎', action(context, { action: 'engine' })), button('切换运行位置', action(context, { action: 'nodes' }))] : [button('最近对话', action(context, { action: 'history', id: binding.id })), button('切换会话', action(context, { action: 'sessions' })), button('换项目新建', action(context, { action: context.forms ? 'new_form' : 'projects', engine: engineId })), button('切换引擎', action(context, { action: 'engine' })), button('切换运行位置', action(context, { action: 'nodes' }))];
  actions.push(button('查看 / 切换模型', action(context, { action: 'models' })));
  if (running) actions.push(button('停止任务', action(context, { action: 'stop', id: binding.id }), 'danger'));
  elements.push(buttons(actions), muted(`此绑定仅用于当前位置；群和话题内已授权用户共用。卡片操作限发起人，其他成员可使用命令。${engines.switchHint(engineId)} 切换引擎，各自接续上下文。`));
  return card(pending ? '新会话已就绪' : '当前会话', elements, { subtitle: `${engine} · ${nodeLabel} · ${projectName}`, template: requests.length ? 'orange' : 'grey' });
}
function task({ binding, title, view, elapsed, nodeLabel = '', model = '默认（CLI 配置）', ...context }) {
  context.session = sessionReference(binding);
  const tools = [...view.tools.values()], requests = view.done ? [] : [...view.permissions.values()];
  const done = tools.filter(item => item.state === '已完成').length;
  const failed = view.phase === '失败' || view.phase === '连接已结束';
  const template = failed ? 'red' : requests.length ? 'orange' : view.done ? 'green' : 'blue';
  if (context.detailed === false) {
    const elements = [muted(`${Math.max(0, Math.floor(elapsed / 1000))} 秒${tools.length ? ` · 工具 ${done}/${tools.length}` : ''}`)];
    if (tools.length) elements.push(markdown(tools.slice(-8).map(tool => `🔧 ${escape(clip(tool.name, 60))} · ${escape(tool.state)}`).join('\n')));
    elements.push(markdown(view.done ? clip(view.text || '本轮已结束。', REPLY_PREVIEW) : requests.length ? '等待授权，请在本机 Panel 处理。' : '正在处理，完成后会显示回复。'));
    if (view.done && view.text.length > REPLY_PREVIEW) elements.push(muted('完整回复将在下方另行发送。'));
    return card(view.phase, elements, { subtitle: '工具执行状态与最终回复', template, summary: `${view.phase}${view.done ? ' · ' + clip(view.text, 90) : ''}` });
  }
  const elements = [muted(`${context.location ? context.location + ' · ' : ''}${catalogOf(context).label(binding.engine || 'claude')} · ${escape(path.basename(binding.cwd) || '项目')} · ${Math.max(0, Math.floor(elapsed / 1000))} 秒${tools.length ? ` · 工具 ${done}/${tools.length}` : ''}`)];
  elements.push(muted(`模型：${escape(model)}`));
  if (nodeLabel) elements.push(muted(`执行机器：${escape(nodeLabel)}`));
  if (binding.handoff) elements.push(markdown(`**${binding.handoff.from === binding.handoff.to ? '已创建接续会话 · ' + escape(binding.handoff.to) : '执行位置已切换：' + escape(binding.handoff.from) + ' → ' + escape(binding.handoff.to)}**\n${binding.handoff.reason === 'offline' ? '原机器离线，接管机器已接续新一轮。' : '已按手动选择创建接续会话。'}${binding.handoff.context === 'checkpoint' ? '上下文来自有限的对话检查点，文件和工具状态需核对。' : '没有可恢复的对话检查点，请补充必要上下文。'}`));
  if (view.warning && !view.done) elements.push(muted(clip(view.warning, 500)));
  if (view.text) elements.push(markdown(clip(view.text, REPLY_PREVIEW)));
  else elements.push(markdown(requests.length ? '请确认下方工具调用，授权后继续。' : view.done ? '本轮已结束。' : '正在处理你的请求，进展会更新在这张卡片中。'));
  if (view.text.length > REPLY_PREVIEW) elements.push(muted('卡片展示回复摘要；完成后会另发完整回复。'));
  const reasoning = [...(view.reasoning?.values() || [])].join('\n\n');
  if (reasoning) elements.push(collapse('思考摘要', [markdown(clip(reasoning, 3000), true)], false, 'reasoning_summary'));
  elements.push(...permissions(context, binding, requests));
  if (tools.length) {
    const recent = tools.slice(-4);
    const steps = recent.map((tool, index) => collapse(`${tools.length - recent.length + index + 1}. ${tool.name} · ${tool.state}`, [
      ...(tool.input ? [markdown('**输入**\n```json\n' + clip(tool.input, 120) + '\n```', true)] : []),
      ...(tool.output ? [markdown('**结果**\n```\n' + clip(tool.output, 200) + '\n```', true)] : []),
    ], tool.state === '失败', `tool_step_${tools.length - recent.length + index}`));
    if (tools.length > recent.length) steps.unshift(muted(`显示最近 ${recent.length} 项，完整执行记录保存在 Panel。`));
    elements.push(collapse(`执行详情 · ${tools.length} 个工具`, steps, false, 'execution_details'));
  }
  elements.push(collapse('会话信息', [markdown(`**${escape(clip(title, 80))}**\n${escape(binding.cwd)}\n\`${binding.id}\``, true)]));
  if (binding.worktree) elements.push(muted(`独立工作区 · ${escape(binding.worktree.branch)}`));
  const actions = [button('执行机器', action(context, { action: 'nodes' })), button('查看会话', action(context, { action: 'view', id: binding.id })), button('会话列表', action(context, { action: 'sessions' })), button('查看 / 切换引擎', action(context, { action: 'engine' }))];
  actions.push(button('查看 / 切换模型', action(context, { action: 'models' })));
  if (!view.done) actions.push(button('停止任务', action(context, { action: 'stop', id: binding.id, ...(context.taskMessageId ? { taskMessageId: context.taskMessageId } : {}) }), 'danger'));
  elements.push(buttons(actions));
  return card(view.phase, elements, { subtitle: clip(title, 90), template, summary: `${view.phase} · ${clip(view.text || title, 90)}` });
}
const MODE_NAMES = { manual: '手动', failover: '自动故障转移', 'round-robin': '轮询' };
function accountState(account, selected, mode, now) {
  if (!account.enabled) return '已停用';
  const cooling = (account.cooldownUntil || 0) > now ? `冷却 ${Math.ceil((account.cooldownUntil - now) / 1000)} 秒` : '';
  const last = account.lastStatus ? `上次 ${account.lastStatus}` : '';
  return [mode === 'manual' && account.id === selected ? '● 当前' : '', cooling, last].filter(Boolean).join(' · ') || '可用';
}
function routes({ status, codex, pinned, notice = '', now = Date.now(), ...context }) {
  const { mode, selected, accounts = [] } = status;
  const elements = [];
  if (notice) elements.push(markdown(notice));
  elements.push(muted(`${status.engine === 'codex' ? 'Codex 账号池' : 'Claude 路由'}：${MODE_NAMES[mode] || mode}${status.connection && !status.connection.connected ? ' · ⚠ Claude 尚未接入本地代理' : ''}`));
  accounts.forEach((account, index) => {
    const current = mode === 'manual' && account.id === selected;
    elements.push(row(`${index + 1}. ${escape(clip(account.name, 40))}${account.id === pinned ? '（本会话固定）' : ''}`, escape(accountState(account, selected, mode, now)), button(current ? '使用中' : '切到此账号', action(context, { action: 'route', selected: account.id }), current ? 'primary' : 'default')));
  });
  if (!accounts.length) elements.push(markdown('还没有配置可用账号，请在面板「引擎与账号」添加或导入登录。'));
  const modes = [['failover', '自动故障转移'], ['round-robin', '轮询']].filter(([id]) => id !== mode).map(([id, label]) => button(label, action(context, { action: 'route', mode: id })));
  const controls = [...(accounts.length ? [...modes, button('清除冷却', action(context, { action: 'route', reset: true }))] : [])];
  if (codex) controls.push(button(codex.capture ? 'Codex 改直连' : 'Codex 改抓包', action(context, { action: 'route', codexCapture: !codex.capture })));
  controls.push(button('刷新', action(context, { action: 'route' })));
  if (codex) elements.push(muted(`Codex：${codex.capture ? '经本地代理抓包' : '直连 OpenAI'}${codex.version ? ' · v' + escape(codex.version) : ''}${codex.authMode ? ' · ' + (codex.authMode === 'apikey' ? 'API Key' : 'ChatGPT 订阅') : ''}`));
  elements.push(buttons(controls), muted('/route 序号或名称 切换账号；/route auto 故障转移；/route rr 轮询；/route reset 清除冷却；/route pin 序号|off 固定当前会话；/route codex direct|proxy'));
  return card('代理路由', elements, { subtitle: '切换立即生效，无需经过模型', template: accounts.some(a => a.enabled && (a.cooldownUntil || 0) > now) ? 'orange' : 'grey', summary: `路由：${MODE_NAMES[mode] || mode}` });
}
module.exports = { PAGE_SIZE, SESSION_PAGE_SIZE, REPLY_PREVIEW, card, markdown, button, buttons, collapse, sessionList, sessionUserMessages, projectList, nodePicker, enginePicker, modelPicker, currentSession, task, routes, MODE_NAMES };
