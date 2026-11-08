const path = require('path');
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
const buttons = items => ({ tag: 'column_set', flex_mode: 'flow', horizontal_spacing: '8px', columns: items.map(item => ({ tag: 'column', width: 'auto', elements: [item] })) });
const collapse = (title, elements, expanded = false, id) => ({ tag: 'collapsible_panel', ...(id ? { element_id: id } : {}), expanded, header: { title: plain(title), icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' }, icon_position: 'right', icon_expanded_angle: -180 }, border: { color: 'grey', corner_radius: '5px' }, vertical_spacing: '8px', padding: '8px 8px 8px 8px', elements });
function card(title, elements, { subtitle = 'my-agents · 本机工作空间', template = 'grey', summary = title } = {}) {
  return { schema: '2.0', config: { width_mode: 'default', update_multi: true, summary: { content: clip(summary, 120) } }, header: { title: plain(clip(title, 64)), subtitle: plain(clip(subtitle, 100)), template }, body: { padding: '12px 16px 12px 16px', vertical_spacing: '12px', elements } };
}
// Cards name engines through the catalog the gateway passes in (`context.engines`).
const catalogOf = context => context.engines || engineCatalog();
const action = (context, value) => ({ ...value, owner: context.owner, key: context.key });
function row(title, detail, operation) {
  return { tag: 'column_set', flex_mode: 'stretch', horizontal_spacing: '12px', columns: [
    { tag: 'column', width: 'weighted', weight: 1, elements: [markdown(`**${title}**`), muted(detail)] },
    { tag: 'column', width: 'auto', vertical_align: 'center', elements: [operation] },
  ] };
}
function sessionList({ rows, total, page, query, selected, ...context }) {
  const pages = Math.max(1, Math.ceil(total / SESSION_PAGE_SIZE));
  const elements = [muted(`${context.location ? context.location + ' · ' : ''}共 ${total} 个会话 · 第 ${page + 1} / ${pages} 页${query ? ' · 筛选：' + escape(clip(query, 50)) : ''}`)];
  rows.forEach((item, index) => {
    const number = page * SESSION_PAGE_SIZE + index + 1, current = item.id === selected;
    elements.push(row(`${number}. ${escape(clip(item.title || '未命名会话', 70))}`, `${catalogOf(context).label(item.engine || 'claude')} · ${escape(path.basename(item.worktree?.repository || item.project || '') || '未指定项目')} · ${current ? '● 当前会话' : item.running ? '● 运行中' : '可接续'}`, button(current ? '继续' : '切换', action(context, { action: 'switch', id: item.id }), current ? 'primary' : 'default')));
  });
  if (!rows.length) elements.push(markdown('没有找到匹配的会话。试试其他关键词，或新建一个会话。'));
  if (rows.length) elements.push(collapse('项目路径与会话 ID', rows.map((item, index) => markdown(`**${page * SESSION_PAGE_SIZE + index + 1}. ${escape(clip(item.title || '未命名会话', 60))}**\n${escape(item.project)}\n\`${item.id}\``, true))));
  const navigation = [];
  if (page > 0) navigation.push(button('← 上一页', action(context, { action: 'sessions', page: page - 1, query })));
  if (page + 1 < pages) navigation.push(button('下一页 →', action(context, { action: 'sessions', page: page + 1, query })));
  navigation.push(button('刷新', action(context, { action: 'sessions', page, query })), button('＋ 新建会话', action(context, { action: 'engine' }), 'primary'));
  elements.push(buttons(navigation), muted('切换仅修改当前位置的绑定。/sessions 关键词筛选；/switch 序号切换；/new 使用默认项目新建。'));
  return card('最近会话', elements, { summary: `${total} 个会话 · 选择一个继续工作` });
}
function projectList({ rows, total, page, defaultProject, engine = 'claude', ...context }) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE)), engines = catalogOf(context);
  const elements = [muted(`选择项目，新建 ${engines.label(engine)} 会话 · ${page + 1} / ${pages}`)];
  rows.forEach((cwd, index) => elements.push(row(`${page * PAGE_SIZE + index + 1}. ${escape(path.basename(cwd) || cwd)}`, cwd === defaultProject ? '默认项目' : escape(clip(path.dirname(cwd), 80)), button('新建会话', action(context, { action: 'new', cwd, engine })))));
  if (!rows.length) elements.push(markdown('还没有可用项目。发送 /new 绝对路径 指定本机已有目录，或在 Panel 选择默认项目。'));
  const navigation = [];
  if (page > 0) navigation.push(button('← 上一页', action(context, { action: 'projects', page: page - 1, engine })));
  if (page + 1 < pages) navigation.push(button('下一页 →', action(context, { action: 'projects', page: page + 1, engine })));
  for (const other of engines.others(engine)) navigation.push(button(`改用 ${other.label}`, action(context, { action: 'projects', page, engine: other.id })));
  navigation.push(button('返回会话', action(context, { action: 'sessions' })));
  elements.push(buttons(navigation), muted(`使用未列出的目录：发送 /new ${engine} /绝对路径（支持 ~/，路径有空格也可直接粘贴）。目录须已在本机创建，选用后会保留在列表中。`));
  return card('选择工作项目', elements);
}
function enginePicker({ engine = 'claude', defaultEngine = 'claude', cwd, ...context }) {
  const engines = catalogOf(context), ids = engines.ids();
  const elements = [markdown(`**${context.location || '当前位置'} · 当前引擎：${engines.label(engine)}**`), muted(`默认启动引擎：${engines.label(defaultEngine)}。不同话题独立绑定，同一话题成员共用。`), markdown('切换时接续该引擎上一次会话，无历史则新建。各引擎分别保留上下文。')];
  elements.push(buttons(ids.map(id => button(`使用 ${engines.label(id)}`, action(context, cwd ? { action: 'use_engine', engine: id } : { action: 'projects', engine: id }), id === engine ? 'primary' : 'default'))));
  elements.push(muted(`${ids.map(id => '/' + id).join('、')} 可直接带问题；/engine 查看当前引擎；${ids.map(id => '/new ' + id).join(' 或 ')} 强制新建。`));
  return card('选择会话引擎', elements);
}
function permissions(context, binding, requests) {
  const elements = [];
  for (const request of requests.slice(0, 3)) {
    const preview = request.input?.command || request.input?.file_path || request.input?.url;
    elements.push(markdown(`**需要授权 · ${escape(request.tool)}**${request.description ? '\n' + escape(clip(request.description, 120)) : ''}${preview ? '\n```\n' + clip(preview, 180) + '\n```' : ''}`));
    elements.push(collapse('查看本次调用参数', [markdown('```json\n' + clip(JSON.stringify(request.input || {}, null, 2), 400) + '\n```', true)]));
    elements.push(buttons([button('允许本次调用', action(context, { action: 'permission', id: binding.id, requestId: request.id, behavior: 'allow' }), 'primary'), button('拒绝', action(context, { action: 'permission', id: binding.id, requestId: request.id, behavior: 'deny' }))]));
  }
  if (requests.length > 3) elements.push(muted(`另有 ${requests.length - 3} 项等待授权，处理后会依次显示。`));
  return elements;
}
function currentSession({ binding, item, running, requests = [], ...context }) {
  const pending = !item, title = item?.title || '新会话', engines = catalogOf(context), engineId = item?.engine || binding.engine || 'claude', engine = engines.label(engineId);
  const projectName = path.basename(binding.worktree?.repository || binding.cwd) || binding.cwd, project = escape(projectName);
  const elements = pending ? [markdown(`**当前项目：${project}**`), muted(`${context.location || '当前位置'} · ${engine} · 项目确认后，直接发送问题开始对话`)] : [markdown(`**${escape(clip(title, 100))}**`), muted(`${context.location ? context.location + ' · ' : ''}${engine} · ${project} · ${running ? '● 正在运行' : '已就绪，直接发消息继续'}`)];
  if (binding.worktree) elements.push(muted(`独立工作区 · ${escape(binding.worktree.branch)}`));
  elements.push(...permissions(context, binding, requests), collapse(pending ? '项目位置' : '会话信息', [markdown(pending ? escape(binding.cwd) : `${escape(binding.cwd)}\n\`${binding.id}\``, true)]));
  const actions = pending ? [button('切换项目', action(context, { action: 'projects', engine: engineId }), 'primary'), button('切换引擎', action(context, { action: 'engine' }))] : [button('最近对话', action(context, { action: 'history', id: binding.id })), button('切换会话', action(context, { action: 'sessions' })), button('换项目新建', action(context, { action: 'projects', engine: engineId })), button('切换引擎', action(context, { action: 'engine' }))];
  if (running) actions.push(button('停止任务', action(context, { action: 'stop', id: binding.id }), 'danger'));
  elements.push(buttons(actions), muted(`此绑定仅用于当前位置；群和话题内已授权用户共用。${engines.switchHint(engineId)} 切换引擎，各自接续上下文。`));
  return card(pending ? '新会话已就绪' : '当前会话', elements, { subtitle: `${engine} · ${projectName}`, template: requests.length ? 'orange' : 'grey' });
}
function task({ binding, title, view, elapsed, ...context }) {
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
  const actions = [button('查看会话', action(context, { action: 'switch', id: binding.id })), button('会话列表', action(context, { action: 'sessions' })), button('查看 / 切换引擎', action(context, { action: 'engine' }))];
  if (!view.done) actions.push(button('停止任务', action(context, { action: 'stop', id: binding.id }), 'danger'));
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
  elements.push(muted(`Claude 路由：${MODE_NAMES[mode] || mode}${status.connection && !status.connection.connected ? ' · ⚠ Claude 尚未接入本地代理' : ''}`));
  accounts.forEach((account, index) => {
    const current = mode === 'manual' && account.id === selected;
    elements.push(row(`${index + 1}. ${escape(clip(account.name, 40))}${account.id === pinned ? '（本会话固定）' : ''}`, escape(accountState(account, selected, mode, now)), button(current ? '使用中' : '切到此账号', action(context, { action: 'route', selected: account.id }), current ? 'primary' : 'default')));
  });
  if (!accounts.length) elements.push(markdown('还没有配置代理账号，Claude 请求直连 Anthropic。请在 Mac 面板「账号路由」添加。'));
  const modes = [['failover', '自动故障转移'], ['round-robin', '轮询']].filter(([id]) => id !== mode).map(([id, label]) => button(label, action(context, { action: 'route', mode: id })));
  const controls = [...(accounts.length ? [...modes, button('清除冷却', action(context, { action: 'route', reset: true }))] : [])];
  if (codex) controls.push(button(codex.capture ? 'Codex 改直连' : 'Codex 改抓包', action(context, { action: 'route', codexCapture: !codex.capture })));
  controls.push(button('刷新', action(context, { action: 'route' })));
  if (codex) elements.push(muted(`Codex：${codex.capture ? '经本地代理抓包' : '直连 OpenAI'}${codex.version ? ' · v' + escape(codex.version) : ''}${codex.authMode ? ' · ' + (codex.authMode === 'apikey' ? 'API Key' : 'ChatGPT 订阅') : ''}`));
  elements.push(buttons(controls), muted('/route 序号或名称 切换账号；/route auto 故障转移；/route rr 轮询；/route reset 清除冷却；/route pin 序号|off 固定当前会话；/route codex direct|proxy'));
  return card('代理路由', elements, { subtitle: '切换立即生效，无需经过模型', template: accounts.some(a => a.enabled && (a.cooldownUntil || 0) > now) ? 'orange' : 'grey', summary: `路由：${MODE_NAMES[mode] || mode}` });
}
module.exports = { PAGE_SIZE, SESSION_PAGE_SIZE, REPLY_PREVIEW, card, markdown, button, buttons, collapse, sessionList, projectList, enginePicker, currentSession, task, routes, MODE_NAMES };
