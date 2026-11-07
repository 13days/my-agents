let feishuStatusTimer = null;
function stopFeishuPolling() { clearInterval(feishuStatusTimer); feishuStatusTimer = null; }
async function renderFeishuGateway() {
  stopFeishuPolling();
  let data;
  try { data = await api('GET', 'feishu'); } catch (e) { toast(e.message, false); return; }
  if (state.type !== 'feishu') return;
  const contactNamesSupported = !!data.capabilities?.contactNames;
  const c = data.config, cliSetup = data.cliSetup || { available: false, phase: 'idle' };
  $('#empty').style.display = 'none'; $('#metabar').style.display = 'none'; $('#render').classList.add('wide'); $('#render').style.display = 'block';
  $('#title').firstChild.textContent = rt('飞书网关', 'Feishu gateway'); $('#fpath').textContent = '';
  $('#editBtn').disabled = $('#delBtn').disabled = true;
  $('#render').innerHTML = `${viewHeading('feishu')}
    <div class="gateway-status chart"><div><span id="feishu-phase" class="route-badge"></span><p id="feishu-connection-note" class="route-muted"></p></div><div class="gateway-runtime" id="feishu-runtime"></div></div>
    <div class="gateway-columns"><section class="chart"><h3>${esc(rt('连接机器人', 'Connect your bot'))}</h3>
      <section id="feishu-cli-setup" class="gateway-cli-setup" ${cliSetup.available ? '' : 'hidden'}>
        <p class="route-muted">${esc(rt('已检测到 Lark CLI，扫码创建机器人并自动连接，无需填写 App ID 和 Secret。', 'Lark CLI detected. Scan to create and connect your bot without entering app credentials.'))}</p>
        <div class="gateway-cli-actions"><select id="feishu-cli-brand" aria-label="${esc(rt('扫码创建服务', 'Service for QR setup'))}"><option value="feishu">飞书</option><option value="lark">Lark</option></select><button class="btn primary" type="button" id="feishu-cli-create">${esc(rt('扫码创建机器人', 'Create bot with QR code'))}</button><button class="btn" type="button" id="feishu-cli-callbacks" hidden>${esc(rt('启用卡片按钮（扫码）', 'Enable card buttons (scan)'))}</button><button class="btn" type="button" id="feishu-cli-cancel" hidden>${esc(rt('取消', 'Cancel'))}</button></div>
        <p id="feishu-cli-state" class="route-muted" role="status"></p>
        <div id="feishu-cli-qr" hidden><img id="feishu-cli-qr-image" alt="${esc(rt('扫码创建飞书机器人', 'Scan to create a bot'))}" hidden><p><a id="feishu-cli-link" target="_blank" rel="noreferrer">${esc(rt('或打开创建链接', 'Or open the setup link'))}</a></p></div>
      </section>
      <form id="feishu-form" class="gateway-form">
        <label class="gateway-check"><input type="checkbox" id="feishu-enabled" ${c.enabled ? 'checked' : ''}>${esc(rt('启用飞书网关', 'Enable Feishu gateway'))}</label>
        <details id="feishu-manual-credentials" class="gateway-access" ${cliSetup.available ? '' : 'open'}><summary>${esc(rt('手动配置应用（备用）', 'Manual app setup (fallback)'))}</summary>
        <label>App ID<input id="feishu-app-id" value="${esc(c.appId)}" autocomplete="off" placeholder="cli_…"></label>
        <label>App Secret<span class="gateway-secret-field"><input id="feishu-app-secret" type="password" autocomplete="new-password" placeholder="${esc(c.hasSecret ? rt('已保存，留空保持不变', 'Saved; leave blank to keep it') : rt('填写自建应用的 Secret', 'Enter your custom app secret'))}"><button id="feishu-secret-toggle" class="btn" type="button" aria-controls="feishu-app-secret" aria-pressed="false">${esc(rt('显示', 'Show'))}</button></span></label>
        </details>
        <div class="gateway-form-row"><label>${esc(rt('服务', 'Service'))}<select id="feishu-domain"><option value="feishu">飞书</option><option value="lark">Lark</option></select></label><label>${esc(rt('默认启动引擎', 'Default engine'))}<select id="feishu-default-engine" ${['claude', 'codex'].includes(c.defaultEngine) ? '' : 'disabled'}><option value="claude">Claude Code</option><option value="codex">Codex</option></select></label></div>
        <p class="gateway-engine-hint route-muted">${esc(['claude', 'codex'].includes(c.defaultEngine) ? rt('新话题首次发送消息，或 /new 未指定引擎时，使用此默认值。已有话题继续使用各自绑定的引擎。', 'Used for the first message in an unbound topic and /new without an engine. Existing topics retain their engine.') : rt('当前运行的服务尚未加载引擎设置，请重启面板后使用默认引擎和 /engine 命令。', 'Restart the panel service to enable default-engine settings and /engine commands.'))}</p>
        <label>${esc(rt('Claude Code 模型（选填）', 'Claude Code model (optional)'))}<input id="feishu-model" value="${esc(c.model)}" placeholder="${esc(rt('沿用 Claude Code 默认模型', 'Use Claude Code default'))}"></label>
        <label>${esc(rt('默认项目', 'Default project'))}<div class="gateway-project"><input id="feishu-project" readonly value="${esc(c.defaultProject)}" placeholder="${esc(rt('未选择时，飞书里用 /new 选择项目', 'Use /new in Feishu when no default is selected'))}"><button type="button" class="btn" id="feishu-project-pick">${esc(rt('选择文件夹', 'Choose folder'))}</button></div></label>
        <details id="feishu-access" class="gateway-access" open><summary>${esc(rt('访问权限 · 自动发现的用户与群', 'Access · discovered users and groups'))}</summary>
          <label class="gateway-check"><input type="checkbox" id="feishu-all-users" ${c.allowAllUsers ? 'checked' : ''}>${esc(rt('放行所有私聊用户（无需配对）', 'Allow all private-chat users (no pairing required)'))}</label>
          <p class="gateway-access-warning">${esc(rt('此开关和下方用户勾选仅控制私聊。放行群内任何人 @机器人都可使用，无需单独授权。禁用用户优先于所有放行规则，群聊和私聊均不再处理；消息仍记录。', 'This switch and user selections control private chats only. Anyone may @mention the bot in allowed groups. Disabled users cannot use private or group chats, even with open access; their messages are still logged.'))}</p>
          <div id="feishu-known-users" class="gateway-contact-list"></div>
          <label class="gateway-check"><input type="checkbox" id="feishu-all-groups" ${c.allowAllGroups ? 'checked' : ''}>${esc(rt('放行所有群', 'Allow all groups'))}</label>
          <p class="route-muted">${esc(rt('开启后所有群可使用简洁模式：普通文字回复，处理时在原消息上显示思考表情，结束后移除。下方逐项勾选的群显示会话按钮和详细工具调用。群内任何人 @机器人即可使用，已禁用用户除外。关闭时仅允许勾选的群。', 'Open groups receive plain text replies with a temporary thinking reaction. Individually selected groups also show session controls and detailed tool calls. Anyone can @mention the bot in allowed groups, except disabled users. When off, only selected groups are allowed.'))}</p>
          <div id="feishu-known-groups" class="gateway-contact-list"></div>
          <p class="route-muted">${esc(rt('用户和群会在机器人收到消息后自动出现；未放行的消息也会记录，但不会执行任务。权限勾选自动保存，对后续新消息生效；旧消息不会自动重放。', 'Users and groups appear after the bot receives a message. Blocked messages are logged without running tasks. Access selections save automatically for new messages; old messages are not replayed.'))}</p>
          <p id="feishu-access-result" class="route-muted" role="status" aria-live="polite"></p>
          <details class="gateway-access"><summary>${esc(rt('手动添加或检查 ID（可选）', 'Edit IDs manually (optional)'))}</summary><label>${esc(rt('允许的用户 Open ID', 'Allowed user Open IDs'))}<textarea id="feishu-users" rows="3">${esc(c.allowedUserIds.join('\n'))}</textarea></label><label>${esc(rt('禁用的用户 Open ID', 'Disabled user Open IDs'))}<textarea id="feishu-disabled-users" rows="2">${esc((c.disabledUserIds || []).join('\n'))}</textarea></label><label>${esc(rt('允许的群 Chat ID', 'Allowed group chat IDs'))}<textarea id="feishu-chats" rows="2">${esc(c.allowedChatIds.join('\n'))}</textarea></label></details>
        </details>
        <div class="gateway-power"><label class="gateway-check"><input type="checkbox" id="feishu-awake" ${c.keepAwake ? 'checked' : ''} ${data.runtime.supported ? '' : 'disabled'}>${esc(rt('防止 Mac 闲置睡眠（合盖仍可能睡眠）', 'Prevent idle sleep (closing the lid may still force sleep)'))}</label><label class="gateway-check"><input type="checkbox" id="feishu-autostart" ${data.runtime.autoStart ? 'checked' : ''} ${data.runtime.supported ? '' : 'disabled'}>${esc(rt('登录后自动启动（下次登录生效）', 'Start automatically at login (effective next login)'))}</label><p class="route-muted">${esc(rt('需保持网络与供电。合盖、手动睡眠或关机时无法保证在线。飞书任务默认跳过 Claude Code 工具权限确认。', 'Keep the network and power connected. Closing the lid, forcing sleep or shutting down can take the gateway offline. Tasks skip Claude Code tool permission prompts by default.'))}</p></div>
        <div class="gateway-form-footer"><span id="feishu-save-result" role="status"></span><button class="btn primary" type="submit" id="feishu-save">${esc(rt('保存配置', 'Save configuration'))}</button></div>
      </form></section>
      <div class="gateway-side"><section class="chart"><h3>${esc(rt('配对你的飞书账号', 'Pair your Feishu account'))}</h3><p class="route-muted">${esc(rt('连接后，在本机生成一次配对命令，私聊机器人发送。私聊需配对或勾选放行；放行群内任何人 @机器人即可使用。禁用用户在所有位置均不可用。', 'After connecting, generate a pairing command here and send it privately to the bot. Private chats require pairing or explicit permission. Anyone can @mention the bot in allowed groups. Disabled users cannot use it anywhere.'))}</p><button type="button" class="btn" id="feishu-pair">${esc(rt('生成配对命令', 'Generate pairing command'))}</button><div id="feishu-pair-result" hidden><input id="feishu-pair-command" readonly aria-label="Pairing command"><button class="btn" id="feishu-copy-pair">${esc(rt('复制', 'Copy'))}</button><p class="route-muted">${esc(rt('10 分钟有效；使用一次或重启 Panel 后失效。', 'Expires after 10 minutes, one use, or a Panel restart.'))}</p></div><p class="route-muted" id="feishu-paired-count"></p></section>
      <section class="chart"><h3>${esc(rt('在飞书里使用', 'Use it in Feishu'))}</h3><div class="gateway-command-list"><code>/sessions</code><span>${esc(rt('查看并点击切换会话', 'Browse and switch sessions'))}</span><code>/new</code><span>${esc(rt('在默认项目新建会话', 'Create a session in the default project'))}</span><code>/switch 2</code><span>${esc(rt('按列表序号切换', 'Switch by list number'))}</span><code>/history</code><span>${esc(rt('查看最近对话', 'View recent messages'))}</span><code>/queue 内容</code><span>${esc(rt('排队执行', 'Queue a follow-up'))}</span><code>/steer 内容</code><span>${esc(rt('引导当前任务', 'Steer the current task'))}</span><code>/stop</code><span>${esc(rt('停止当前 Panel 任务', 'Stop the current panel task'))}</span></div><p class="route-muted">${esc(rt('私聊、各群、群内每个话题分别绑定会话；群和话题内已授权用户共用绑定。普通回复沿用当前位置的绑定。/sessions 切换绑定；/new 使用默认项目新建；/projects 选择其他项目。', 'Private chats, groups and individual topics have separate bindings, shared by allowed users within each group or topic. Replies use the current binding. Use /sessions to switch, /new for the default project, or /projects to choose another project.'))}</p></section></div></div>
    <section class="chart gateway-inbox"><div class="route-heading"><h3>${esc(rt('收到的消息', 'Received messages'))}</h3><span id="feishu-inbox-count" class="route-muted"></span><button class="btn" type="button" id="feishu-inbox-refresh">${esc(rt('刷新记录', 'Refresh log'))}</button></div>
      <p class="route-muted">${esc(rt('在本机完整保存飞书实际推送给机器人的消息、发送人和群信息，包括被权限拦截的消息。不会补采历史聊天；内容仅在此 Mac 保存。', 'Stores complete messages actually delivered to the bot on this Mac, including blocked messages. It does not fetch past chat history.'))}</p>
      <div class="gateway-inbox-filters"><select id="feishu-log-user" aria-label="${esc(rt('按用户筛选消息', 'Filter messages by user'))}"></select><select id="feishu-log-chat" aria-label="${esc(rt('按群筛选消息', 'Filter messages by group'))}"></select></div>
      <div id="feishu-inbox-items"></div><button class="btn" type="button" id="feishu-inbox-more" hidden>${esc(rt('加载更早消息', 'Load earlier messages'))}</button>
    </section>
    <details class="chart gateway-setup" ${c.appId || cliSetup.available ? '' : 'open'}><summary>${esc(rt('首次接入：飞书应用配置', 'First-time app setup'))}</summary><ol><li>${esc(rt('在飞书开放平台创建企业自建应用，开启机器人能力，填写上面的 App ID 和 Secret。', 'Create a custom app in the developer console, enable the bot feature, and enter its App ID and Secret above.'))} <a href="https://open.feishu.cn/app" target="_blank" rel="noreferrer">${esc(rt('打开飞书开放平台', 'Open developer console'))}</a></li><li>${esc(rt('开通 im:message:send_as_bot、im:message.p2p_msg:readonly、im:message.reactions:write_only 权限；需要群聊时再添加 im:message.group_at_msg:readonly。', 'Enable im:message:send_as_bot im:message.p2p_msg:readonly and im:message.reactions:write_only; add im:message.group_at_msg:readonly for groups.'))}</li><li>${esc(rt('事件配置选择“长连接”，订阅 im.message.receive_v1；回调配置也选择“长连接”，添加 card.action.trigger。', 'Choose long connection for events and subscribe to im.message.receive_v1. Also choose long connection under callbacks and add card.action.trigger.'))}</li><li>${esc(rt('发布应用版本，确认你在应用可用范围内；保存启用网关后完成配对。', 'Publish the app, include yourself in its availability scope, then enable the gateway and pair your account.'))}</li></ol><p class="route-muted">${esc(rt('Mac 主动连接飞书，不需要公网 IP、端口映射或共享云存储。会话记录仍以这台 Mac 上的 Panel 为准。', 'The Mac connects outbound to Feishu. No public IP, port forwarding or shared cloud store is required. Session records remain on this Mac.'))}</p><p id="feishu-sdk-hint" class="route-muted" ${data.sdkAvailable ? 'hidden' : ''}>${esc(rt('源码运行需先安装可选依赖：npm install', 'For source checkouts, install the optional dependency first: npm install'))}</p></details>`;
  // Keep the existing form controls and handlers; organize them into focused pages.
  const canvas = $('#render');
  const status = canvas.querySelector('.gateway-status');
  const columns = canvas.querySelector('.gateway-columns');
  const connection = columns.firstElementChild;
  connection.classList.add('gateway-connection-card');
  connection.querySelector('h3').innerHTML = `<span class="gateway-step">01</span>${esc(rt('连接机器人', 'Connect your bot'))}`;
  const side = columns.querySelector('.gateway-side');
  const pairing = side.firstElementChild;
  pairing.classList.add('gateway-pair-card');
  pairing.querySelector('h3').innerHTML = `<span class="gateway-step">02</span>${esc(rt('配对与授权', 'Pair your account'))}`;
  const access = $('#feishu-access'); access.classList.add('chart', 'gateway-access-card');
  access.querySelector(':scope > summary').textContent = rt('访问控制', 'Access control');
  const contactToolbar = document.createElement('div'); contactToolbar.className = 'gateway-contact-toolbar';
  contactToolbar.innerHTML = `<p class="route-muted">${esc(contactNamesSupported ? rt('显示飞书姓名和群名；获取不到时可添加本机备注。', 'Shows Feishu names. Add a local label when a name is unavailable.') : rt('重启面板后可同步姓名、群名和添加备注。', 'Restart the panel to sync names and add labels.'))}</p><button type="button" class="btn" id="feishu-contact-refresh" ${contactNamesSupported ? '' : 'disabled'}>${esc(rt('同步名称', 'Sync names'))}</button><p id="feishu-contact-sync-result" class="route-muted" role="status" aria-live="polite"></p>`;
  access.querySelector(':scope > summary').after(contactToolbar);
  const permissions = document.createElement('div'); permissions.className = 'gateway-permission-columns'; permissions.append(access, pairing);
  const power = canvas.querySelector('.gateway-power');
  const powerDetails = document.createElement('details'); powerDetails.className = 'gateway-runtime-settings';
  const powerSummary = document.createElement('summary'); powerSummary.textContent = rt('运行与启动设置', 'Runtime & startup'); power.before(powerDetails); powerDetails.append(powerSummary, power);
  const reference = side.firstElementChild;
  const referenceDetails = document.createElement('details'); referenceDetails.className = 'gateway-reference';
  const referenceSummary = document.createElement('summary'); referenceSummary.textContent = rt('查看常用指令', 'View command reference');
  reference.querySelector('h3').textContent = rt('从飞书继续工作', 'Continue from Feishu');
  const intro = document.createElement('p'); intro.className = 'route-muted'; intro.textContent = rt('连接机器人、配对账号后，在飞书发送消息即可开始。会话与本机面板同步。', 'Connect your bot and pair your account, then send a message in Feishu. Sessions stay in sync with this panel.');
  reference.querySelector('h3').after(intro);
  referenceDetails.append(referenceSummary, reference.querySelector('.gateway-command-list'), reference.lastElementChild); reference.append(referenceDetails);
  const engineGuide = document.createElement('section'); engineGuide.className = 'gateway-engine-guide';
  engineGuide.innerHTML = `<h4>${esc(rt('话题与引擎', 'Topics & engines'))}</h4><p class="route-muted">${esc(rt('每个私聊、群和话题独立绑定会话，可分别使用 Claude Code 或 Codex。同一话题内成员共用绑定，重启后保留。', 'Private chats, groups and topics have independent sessions and engines. Members of a topic share its binding, which survives restarts.'))}</p><dl><dt><code>/engine</code></dt><dd>${esc(rt('查看当前引擎与切换选项', 'View the engine and choices'))}</dd><dt><code>/codex</code></dt><dd>${esc(rt('切到 Codex，可在后面直接带问题', 'Use Codex, optionally followed by a prompt'))}</dd><dt><code>/claude</code></dt><dd>${esc(rt('切到 Claude，可在后面直接带问题', 'Use Claude, optionally followed by a prompt'))}</dd><dt><code>/new</code></dt><dd>${esc(rt('使用默认项目与默认引擎', 'Use the default project and engine'))}</dd><dt><code>/current</code></dt><dd>${esc(rt('查看当前位置的会话与引擎', 'View this session and engine'))}</dd></dl><p class="route-muted">${esc(rt('切换时各引擎分别接续上下文；/new codex 或 /new claude 强制新建。简洁模式同样支持引擎命令，并在回复末尾标注引擎；群内请 @机器人发送。', 'Each engine resumes its own context. /new codex or /new claude starts fresh. Simple mode supports engine commands and labels replies. @mention the bot in groups.'))}</p>`;
  if (!['claude', 'codex'].includes(c.defaultEngine)) { const notice = document.createElement('p'); notice.className = 'gateway-access-warning'; notice.textContent = rt('当前服务需要重启后才能使用下列新引擎命令。', 'Restart the service before using the new engine commands below.'); engineGuide.prepend(notice); }
  referenceDetails.before(engineGuide);
  const journey = document.createElement('div'); journey.className = 'gateway-journey';
  journey.innerHTML = [['01', rt('连接机器人', 'Connect bot'), rt('扫码创建或填写应用凭证', 'Scan or enter app credentials')], ['02', rt('设置权限', 'Set access'), rt('配对账号，选择允许的群', 'Pair users and allow groups')], ['03', rt('开始对话', 'Start chatting'), rt('发送消息，在这里查看记录', 'Send messages and inspect the log')]].map(([n, title, note]) => `<div><span class="gateway-step">${n}</span><span><strong>${esc(title)}</strong><small>${esc(note)}</small></span></div>`).join('');
  side.prepend(journey);
  const inbox = canvas.querySelector('.gateway-inbox');
  const help = canvas.querySelector('.gateway-setup'); help.open = false;
  const connectionPanel = document.createElement('section'); connectionPanel.append(columns, help);
  const accessPanel = document.createElement('section'); accessPanel.append(permissions);
  const messagesPanel = document.createElement('section'); messagesPanel.append(inbox);
  const tablist = document.createElement('div'); tablist.className = 'gateway-tabs'; tablist.setAttribute('role', 'tablist'); tablist.setAttribute('aria-label', rt('网关管理', 'Gateway management'));
  const panels = [['connection', rt('连接设置', 'Connection'), connectionPanel], ['access', rt('访问权限', 'Access'), accessPanel], ['messages', rt('消息记录', 'Messages'), messagesPanel]];
  const selectTab = id => {
    if (!panels.some(([key]) => key === id)) id = 'connection';
    panels.forEach(([key, , panel]) => { panel.hidden = key !== id; const tab = tablist.querySelector(`[data-gateway-tab="${key}"]`); tab.setAttribute('aria-selected', String(key === id)); tab.tabIndex = key === id ? 0 : -1; });
    localStorage.setItem('panel-gateway-tab', id);
  };
  panels.forEach(([id, label, panel]) => {
    panel.id = 'gateway-panel-' + id; panel.className = 'gateway-tab-panel'; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', 'gateway-tab-' + id);
    const button = document.createElement('button'); button.type = 'button'; button.dataset.gatewayTab = id; button.id = 'gateway-tab-' + id; button.textContent = label; button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', panel.id); button.onclick = () => selectTab(id); tablist.append(button);
  });
  tablist.onkeydown = e => {
    const buttons = Array.from(tablist.querySelectorAll('button')), index = buttons.indexOf(document.activeElement);
    const target = e.key === 'ArrowRight' ? buttons[(index + 1) % buttons.length] : e.key === 'ArrowLeft' ? buttons[(index - 1 + buttons.length) % buttons.length] : e.key === 'Home' ? buttons[0] : e.key === 'End' ? buttons.at(-1) : null;
    if (target) { e.preventDefault(); target.click(); target.focus(); }
  };
  status.after(tablist, connectionPanel, accessPanel, messagesPanel);
  const statusLabel = document.createElement('div'); statusLabel.className = 'gateway-eyebrow'; statusLabel.textContent = rt('机器人状态', 'BOT STATUS'); status.firstElementChild.prepend(statusLabel);
  const metrics = document.createElement('div'); metrics.className = 'gateway-overview-metrics';
  metrics.innerHTML = `<div><span>${esc(rt('服务', 'Service'))}</span><strong id="gateway-service-name"></strong></div><div><span>${esc(rt('已授权私聊', 'Allowed users'))}</span><strong id="gateway-allowed-count"></strong></div><div><span>${esc(rt('已接收消息', 'Received messages'))}</span><strong id="gateway-message-count"></strong></div>`;
  status.append(metrics);
  const accessNext = document.createElement('button'); accessNext.className = 'btn'; accessNext.type = 'button'; accessNext.textContent = rt('下一步：设置访问权限 →', 'Next: set access →'); accessNext.onclick = () => selectTab('access'); reference.append(accessNext);
  selectTab(localStorage.getItem('panel-gateway-tab') || 'connection');

  $('#feishu-domain').value = c.domain;
  $('#feishu-default-engine').value = c.defaultEngine || 'claude';
  $('#feishu-cli-brand').value = c.domain;
  let setupWasActive = ['starting', 'waiting', 'completing'].includes(cliSetup.phase), hasCredentials = c.hasSecret, recoverExisting = false, callbackReady = !!c.cardCallbacksReady;
  let autoStart = data.runtime.autoStart, owners = c.allowedUserIds.join('\n');
  const secretInput = $('#feishu-app-secret'), secretToggle = $('#feishu-secret-toggle');
  let secretDirty = false, loadedSavedSecret = false, secretRevision = 0;
  const hideSecret = () => {
    ++secretRevision;
    secretInput.type = 'password'; secretToggle.textContent = rt('显示', 'Show'); secretToggle.setAttribute('aria-pressed', 'false');
    if (loadedSavedSecret && !secretDirty) secretInput.value = '';
    loadedSavedSecret = false;
  };
  secretInput.addEventListener('input', () => { ++secretRevision; secretDirty = true; loadedSavedSecret = false; });
  secretToggle.onclick = async () => {
    if (secretInput.type === 'text') { hideSecret(); return; }
    secretToggle.disabled = true;
    const revision = ++secretRevision;
    try {
      if (!secretInput.value && hasCredentials && !secretDirty) {
        const result = await api('POST', 'feishu/secret', {});
        if (revision !== secretRevision || state.type !== 'feishu' || !secretInput.isConnected) return;
        if (!secretInput.value && !secretDirty) { secretInput.value = result.appSecret || ''; loadedSavedSecret = true; }
      }
      secretInput.type = 'text'; secretToggle.textContent = rt('隐藏', 'Hide'); secretToggle.setAttribute('aria-pressed', 'true');
    } catch (error) { toast(error.message, false); }
    finally { secretToggle.disabled = false; }
  };

  const paintSetup = setup => {
    if (!setup || !$('#feishu-cli-create')) return;
    const active = ['starting', 'waiting', 'completing'].includes(setup.phase);
    setupWasActive ||= active;
    recoverExisting = !!setup.canRecover && !hasCredentials;
    $('#feishu-cli-create').disabled = active;
    $('#feishu-cli-create').textContent = recoverExisting ? rt('连接已创建机器人', 'Connect the created bot') : setup.phase === 'complete' ? rt('重新扫码创建', 'Create another bot') : rt('扫码创建机器人', 'Create bot with QR code');
    $('#feishu-cli-brand').disabled = active;
    $('#feishu-cli-callbacks').hidden = !hasCredentials;
    $('#feishu-cli-callbacks').disabled = active || callbackReady;
    $('#feishu-cli-callbacks').textContent = callbackReady ? rt('卡片按钮已启用', 'Card buttons enabled') : rt('启用卡片按钮（扫码）', 'Enable card buttons (scan)');
    $('#feishu-cli-cancel').hidden = !['starting', 'waiting'].includes(setup.phase);
    const phases = { starting: rt('正在生成二维码…', 'Preparing QR code…'), waiting: rt('请用飞书或 Lark 扫码，并完成页面上的创建步骤。', 'Scan with Feishu or Lark and complete the setup steps.'), completing: rt('应用已创建，正在自动连接…', 'App created. Connecting…'), complete: rt('应用信息已自动保存，请继续配对你的账号。', 'App credentials saved. Pair your account next.'), cancelled: rt('已取消，可重新扫码创建。', 'Cancelled. You can try again.') };
    const callbackPhases = { starting: rt('正在生成现有机器人的补充授权二维码…', 'Preparing authorization for your existing bot…'), waiting: rt('请扫码授权当前机器人的应用配置权限，完成后将自动开通长连接卡片回调；不会新建机器人。', 'Scan to authorize configuration of the existing bot. Card callbacks will be enabled automatically.'), completing: rt('正在开通长连接卡片回调…', 'Enabling card callbacks…'), complete: rt('卡片按钮已配置，可回到飞书点击“切换到此会话”。', 'Card buttons configured. Return to Feishu and select a session.') };
    $('#feishu-cli-state').textContent = setup.error || (setup.purpose === 'callbacks' ? callbackPhases[setup.phase] : phases[setup.phase]) || phases[setup.phase] || '';
    const link = $('#feishu-cli-link'), image = $('#feishu-cli-qr-image');
    const validUrl = typeof setup.verificationUrl === 'string' && setup.verificationUrl.startsWith('https://');
    $('#feishu-cli-qr').hidden = !validUrl;
    if (validUrl) link.href = setup.verificationUrl; else link.removeAttribute('href');
    image.hidden = !setup.qrImage;
    if (setup.qrImage?.startsWith('data:image/png;base64,')) image.src = setup.qrImage; else image.removeAttribute('src');
    if (setupWasActive && setup.phase === 'complete') {
      setupWasActive = false;
      api('GET', 'feishu').then(result => {
        if (state.type !== 'feishu' || !$('#feishu-app-id')) return;
        $('#feishu-app-id').value = result.config.appId;
        $('#feishu-domain').value = result.config.domain;
        $('#feishu-enabled').checked = result.config.enabled;
        $('#feishu-app-secret').placeholder = rt('已保存，留空保持不变', 'Saved; leave blank to keep it');
      }).catch(e => toast(e.message, false));
    }
  };
  let contactsSignature = '', knownContacts = { users: [], groups: [] }, logCursor, logBusy = false;
  const ids = selector => new Set($(selector).value.split(/[\s,]+/).filter(Boolean));
  let accessSave = Promise.resolve(), accessRevision = 0;
  const saveAccess = () => {
    const revision = ++accessRevision;
    const input = { allowAllUsers: $('#feishu-all-users').checked, allowAllGroups: $('#feishu-all-groups').checked, allowedUserIds: [...ids('#feishu-users')], disabledUserIds: [...ids('#feishu-disabled-users')], allowedChatIds: [...ids('#feishu-chats')] };
    $('#feishu-access-result').textContent = rt('正在保存权限…', 'Saving access…');
    accessSave = accessSave.then(async () => {
      try {
        const result = await api('PUT', 'feishu', input);
        if (state.type !== 'feishu' || !$('#feishu-access-result') || revision !== accessRevision) return;
        owners = result.config.allowedUserIds.join('\n');
        paint(result);
        $('#feishu-access-result').textContent = rt('权限已保存，新消息立即生效', 'Access saved. Applies to new messages immediately.');
      } catch (error) {
        if (state.type === 'feishu' && $('#feishu-access-result') && revision === accessRevision) $('#feishu-access-result').textContent = rt('权限未保存：', 'Access not saved: ') + error.message + rt('。请重试或点击“保存配置”。', '. Retry or use Save configuration.');
      }
    });
    return accessSave;
  };
  const editContactLabel = item => {
    const dialog = document.createElement('dialog'); dialog.className = 'contact-label-dialog';
    dialog.innerHTML = `<form><h3>${esc(rt('备注名称', 'Contact label'))}</h3><p class="route-muted">${esc(item.name || item.id)}</p><label>${esc(rt('本机备注', 'Local label'))}<input maxlength="80" autocomplete="off" spellcheck="false" placeholder="${esc(rt('例如：张三、产品讨论群', 'e.g. Alex, Product team'))}"></label><p class="route-muted">${esc(rt('仅在此面板显示，不修改飞书名称。清空后恢复显示飞书名称。', 'Used only in this panel. Clear it to show the Feishu name again.'))}</p><p class="contact-label-error" role="alert"></p><footer><button class="btn" type="button">${esc(rt('取消', 'Cancel'))}</button><button class="btn primary" type="submit">${esc(rt('保存', 'Save'))}</button></footer></form>`;
    const input = dialog.querySelector('input'); input.value = item.alias || '';
    dialog.querySelector('button[type="button"]').onclick = () => dialog.close();
    dialog.addEventListener('close', () => dialog.remove());
    dialog.addEventListener('keydown', event => { if (event.key === 'Escape') event.stopPropagation(); });
    dialog.querySelector('form').onsubmit = async event => {
      event.preventDefault(); const button = dialog.querySelector('button[type="submit"]'); button.disabled = true;
      try { const result = await api('POST', 'feishu/contacts/label', { id: item.id, label: input.value }); if (state.type === 'feishu') { paint(result); await loadMessages(); } dialog.close(); }
      catch (error) { dialog.querySelector('.contact-label-error').textContent = error.message; }
      finally { button.disabled = false; }
    };
    document.body.append(dialog); dialog.showModal(); input.focus(); input.select();
  };
  const paintContacts = inbox => {
    if (inbox) knownContacts = inbox;
    const signature = JSON.stringify([knownContacts, $('#feishu-users').value, $('#feishu-chats').value, $('#feishu-disabled-users').value, $('#feishu-all-users').checked, $('#feishu-all-groups').checked]);
    if (signature === contactsSignature) return;
    contactsSignature = signature;
    for (const [kind, selector, hostId, allId] of [['users', '#feishu-users', '#feishu-known-users', '#feishu-all-users'], ['groups', '#feishu-chats', '#feishu-known-groups', '#feishu-all-groups']]) {
      const selected = ids(selector), entries = new Map((knownContacts[kind] || []).map(item => [item.id, item]));
      for (const id of new Set([...selected, ...(kind === 'users' ? ids('#feishu-disabled-users') : [])])) if (!entries.has(id)) entries.set(id, { id, name: '', count: 0 });
      const host = $(hostId); host.replaceChildren();
      if (!entries.size) { const empty = document.createElement('p'); empty.className = 'route-muted'; empty.textContent = kind === 'groups' ? rt('还没有收到群消息。把机器人加入群并 @它，群会自动出现在这里。', 'No group messages yet. Add the bot to a group and @mention it.') : rt('还没有收到用户消息。', 'No users discovered yet.'); host.append(empty); }
      for (const item of entries.values()) {
        const label = document.createElement('label'); label.className = 'gateway-contact';
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.dataset.contactId = item.id;
        checkbox.checked = (kind === 'users' && $(allId).checked) || selected.has(item.id); checkbox.disabled = kind === 'users' && ($(allId).checked || ids('#feishu-disabled-users').has(item.id)); checkbox.title = kind === 'users' ? rt('允许私聊', 'Allow private chat') : ''; 
        const info = document.createElement('span'), name = document.createElement('strong'), detail = document.createElement('small');
        name.textContent = item.displayName || item.alias || item.name || (kind === 'groups' ? rt('未获取群名', 'Unnamed group') : rt('未获取姓名', 'Unnamed user')) + ' · ' + item.id.slice(-6);
        const title = document.createElement('span'); title.className = 'gateway-contact-title';
        const source = document.createElement('span'); source.className = 'gateway-contact-source'; source.textContent = item.alias ? rt('备注', 'Label') : item.name ? rt('飞书', 'Feishu') : rt('名称待获取', 'Name unavailable'); title.append(name, source);
        const contactId = document.createElement('span'); contactId.className = 'gateway-contact-id'; contactId.textContent = item.id; contactId.title = item.id;
        const activity = document.createElement('span'); activity.className = 'gateway-contact-meta'; activity.textContent = [(item.count ? `${item.count} ${rt('条消息', 'messages')}` : ''), (item.mentionCount ? `@ ${item.mentionCount} ${rt('次', 'times')}` : ''), (kind === 'users' ? rt('勾选允许私聊', 'Select to allow private chat') : '')].filter(Boolean).join(' · ');
        detail.append(contactId, activity);
        if (item.alias && item.name && item.alias !== item.name) { const official = document.createElement('span'); official.className = 'gateway-contact-official'; official.textContent = rt('飞书名称：', 'Feishu name: ') + item.name; detail.prepend(official); }
        info.append(title, detail); label.append(checkbox, info); host.append(label);
        const actions = document.createElement('span'); actions.className = 'gateway-contact-actions';
        const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'btn'; edit.dataset.contactLabel = item.id; edit.textContent = item.alias ? rt('改备注', 'Edit label') : rt('备注', 'Label'); edit.disabled = !contactNamesSupported;
        edit.onclick = event => { event.preventDefault(); event.stopPropagation(); editContactLabel(item); }; actions.append(edit); label.append(actions);
        if (kind === 'users') {
          const disabled = ids('#feishu-disabled-users').has(item.id), block = document.createElement('button');
          block.type = 'button'; block.className = 'btn'; block.dataset.disableUser = item.id;
          block.textContent = disabled ? rt('解除禁用', 'Enable user') : rt('禁用', 'Disable');
          block.setAttribute('aria-pressed', String(disabled));
          if (disabled) { name.textContent += rt(' · 已禁用', ' · Disabled'); checkbox.checked = false; }
          block.onclick = event => { event.preventDefault(); const current = ids('#feishu-disabled-users'); if (disabled) current.delete(item.id); else current.add(item.id); $('#feishu-disabled-users').value = [...current].join('\n'); paintContacts(); saveAccess(); };
          actions.append(block);
        }
        checkbox.onchange = () => { const current = ids(selector); if (checkbox.checked) current.add(item.id); else current.delete(item.id); $(selector).value = [...current].join('\n'); saveAccess(); };
      }
    }
    for (const [selector, entries, placeholder] of [['#feishu-log-user', knownContacts.users || [], rt('所有用户', 'All users')], ['#feishu-log-chat', knownContacts.groups || [], rt('所有私聊和群', 'All chats')]]) {
      const select = $(selector), value = select.value; select.replaceChildren(new Option(placeholder, ''));
      for (const item of entries) { const name = item.displayName || item.alias || item.name; select.add(new Option(name ? `${name} · ${item.id}` : item.id, item.id)); }
      select.value = value;
    }
  };
  const loadMessages = async (reset = true) => {
    if (logBusy || state.type !== 'feishu') return;
    logBusy = true; $('#feishu-inbox-refresh').disabled = true;
    try {
      const q = new URLSearchParams(); if (!reset && logCursor !== undefined) q.set('before', logCursor);
      if ($('#feishu-log-user').value) q.set('userId', $('#feishu-log-user').value);
      if ($('#feishu-log-chat').value) q.set('chatId', $('#feishu-log-chat').value);
      const result = await api('GET', 'feishu/messages?' + q);
      if (state.type !== 'feishu' || !$('#feishu-inbox-items')) return;
      const host = $('#feishu-inbox-items'); if (reset) host.replaceChildren();
      for (const item of result.items) {
        const article = document.createElement('article'); article.className = 'gateway-inbox-message';
        const header = document.createElement('div'); header.className = 'gateway-inbox-meta';
        const sender = document.createElement('strong'); sender.textContent = item.senderName || item.senderId;
        const when = document.createElement('span'); when.textContent = new Date(item.receivedAt).toLocaleString();
        const access = document.createElement('span'); const labels = { allowed: rt('已放行', 'Allowed'), blocked_user: rt('私聊未放行', 'Private chat blocked'), disabled_user: rt('用户已禁用', 'User disabled'), blocked_group: rt('群未放行', 'Group blocked'), needs_mention: rt('未 @机器人', 'No @mention'), pairing: rt('配对请求', 'Pairing request') }; access.textContent = labels[item.access] || item.access;
        header.append(sender, when, access);
        const context = document.createElement('p'); context.className = 'route-muted'; context.textContent = `${item.chatType === 'group' ? item.chatName || rt('群聊', 'Group') : rt('私聊', 'Direct message')} · ${item.chatId}${item.threadId ? ' · ' + rt('话题', 'Topic') + ' ' + item.threadId : ''}`;
        const content = document.createElement('details'), summary = document.createElement('summary'), pre = document.createElement('pre');
        summary.textContent = item.content ? Array.from(item.content).slice(0, 120).join('').replace(/\s+/g, ' ') : rt('附件消息', 'Attachment message');
        pre.textContent = item.content + ((item.resources || []).length ? '\n\n' + JSON.stringify(item.resources, null, 2) : ''); content.append(summary, pre);
        article.append(header, context, content); host.append(article);
      }
      if (!host.childNodes.length) { const empty = document.createElement('p'); empty.className = 'route-muted'; empty.textContent = rt('还没有消息记录。新消息收到后可点击刷新查看。', 'No messages yet. Refresh after a new message arrives.'); host.append(empty); }
      logCursor = result.before; $('#feishu-inbox-more').hidden = !result.hasMore;
    } catch (e) { toast(e.message, false); }
    finally { logBusy = false; if ($('#feishu-inbox-refresh')) $('#feishu-inbox-refresh').disabled = false; }
  };
  const paint = d => {
    if (state.type !== 'feishu' || !$('#feishu-phase')) return;
    status.dataset.phase = d.phase;
    $('#gateway-service-name').textContent = d.config.domain === 'lark' ? 'Lark' : '飞书';
    $('#gateway-allowed-count').textContent = d.config.allowAllUsers ? rt('所有用户', 'All users') : String(d.config.allowedUserIds.length);
    $('#gateway-message-count').textContent = String(d.inbox?.messageCount || 0);
    hasCredentials = d.config.hasSecret; callbackReady = !!d.config.cardCallbacksReady;
    paintSetup(d.cliSetup);
    $('#feishu-pair').disabled = d.phase !== 'connected';
    const labels = { disabled: rt('未启用', 'Disabled'), connecting: rt('正在连接', 'Connecting'), connected: rt('已连接', 'Connected'), reconnecting: rt('正在重连', 'Reconnecting'), error: rt('连接失败', 'Connection failed') };
    $('#feishu-phase').textContent = (d.phase === 'connected' ? '● ' : '') + (labels[d.phase] || d.phase);
    $('#feishu-phase').className = 'route-badge' + (d.phase === 'connected' ? '' : ' is-muted');
    const connectionError = typeof d.lastError === 'string' && !d.lastError.includes('[object Object]') ? d.lastError : rt('连接异常，请查看本机服务日志。', 'Connection issue. Check the local service log.');
    $('#feishu-connection-note').textContent = d.phase !== 'connected' && d.lastError ? connectionError : (d.bot ? `${d.bot} · ${rt('长连接接入', 'Long connection')}` : rt('连接后，可在飞书接续 Claude Code 与 Codex 会话。', 'Connect to continue Claude Code and Codex sessions from Feishu.'));
    $('#feishu-runtime').title = d.runtime.claudeCli || '';
    $('#feishu-runtime').textContent = `${d.runtime.claudeVersion ? 'Claude Code ' + d.runtime.claudeVersion + ' · ' : ''}${d.runtime.keepAwake ? rt('Mac 保活中', 'Mac kept awake') : rt('未启用保活', 'Keep-awake off')} · ${d.runtime.autoStart ? rt('已配置登录启动', 'Login startup configured') : rt('未配置登录启动', 'Login startup off')}${d.runtime.backgroundService ? ' · ' + rt('后台服务运行中', 'Background service running') : ''}`;
    $('#feishu-paired-count').textContent = d.config.allowAllUsers ? rt('当前放行所有私聊用户（禁用账号除外）', 'All private-chat users allowed except disabled accounts') : `${rt('已授权账号：', 'Allowed accounts: ')}${d.config.allowedUserIds.length}`;
    if ($('#feishu-users').value === owners) { owners = d.config.allowedUserIds.join('\n'); $('#feishu-users').value = owners; }
    $('#feishu-inbox-count').textContent = `${d.inbox?.messageCount || 0} ${rt('条已保存', 'saved messages')}`;
    paintContacts(d.inbox);
  };
  paint(data);
  for (const selector of ['#feishu-all-users', '#feishu-all-groups', '#feishu-users', '#feishu-chats', '#feishu-disabled-users']) $(selector).addEventListener('change', () => { paintContacts(); saveAccess(); });
  $('#feishu-contact-refresh').onclick = async () => {
    const button = $('#feishu-contact-refresh'); button.disabled = true; $('#feishu-contact-sync-result').textContent = rt('正在同步名称…', 'Syncing names…');
    try { const result = await api('POST', 'feishu/contacts/refresh', {}); if (state.type !== 'feishu') return; paint(result); const summary = result.nameRefresh || {}; $('#feishu-contact-sync-result').textContent = rt(`已同步 ${summary.updated || 0} 项${summary.failed ? `；${summary.failed} 项暂未获取，可添加备注` : ''}`, `Synced ${summary.updated || 0}${summary.failed ? `; ${summary.failed} unavailable, use local labels` : ''}`); await loadMessages(); }
    catch (error) { if (state.type === 'feishu') $('#feishu-contact-sync-result').textContent = error.message; }
    finally { if (button.isConnected) button.disabled = false; }
  };
  $('#feishu-inbox-refresh').onclick = () => loadMessages();
  $('#feishu-inbox-more').onclick = () => loadMessages(false);
  $('#feishu-log-user').onchange = $('#feishu-log-chat').onchange = () => loadMessages();
  loadMessages();
  $('#feishu-cli-create').onclick = async () => {
    $('#feishu-cli-create').disabled = true;
    try { paintSetup(await api('POST', 'feishu/setup', { domain: $('#feishu-cli-brand').value, recover: recoverExisting })); }
    catch (e) { toast(e.message, false); $('#feishu-cli-create').disabled = false; }
  };
  $('#feishu-cli-callbacks').onclick = async () => {
    $('#feishu-cli-callbacks').disabled = true;
    try { paintSetup(await api('POST', 'feishu/setup', { repairCallbacks: true })); }
    catch (e) { toast(e.message, false); $('#feishu-cli-callbacks').disabled = false; }
  };
  $('#feishu-cli-cancel').onclick = async () => {
    try { paintSetup(await api('POST', 'feishu/setup', { cancel: true })); } catch (e) { toast(e.message, false); }
  };
  $('#feishu-project-pick').onclick = async () => { try { const result = await api('POST', 'choose-folder', {}); if (result.path) $('#feishu-project').value = result.path; } catch (e) { toast(e.message, false); } };
  $('#feishu-form').onsubmit = async e => {
    e.preventDefault(); const button = $('#feishu-save'); button.disabled = true; $('#feishu-save-result').textContent = rt('正在保存…', 'Saving…');
    try {
      await accessSave;
      const input = { allowAllUsers: $('#feishu-all-users').checked, allowAllGroups: $('#feishu-all-groups').checked, enabled: $('#feishu-enabled').checked, appId: $('#feishu-app-id').value, appSecret: secretDirty ? secretInput.value : '', domain: $('#feishu-domain').value, defaultProject: $('#feishu-project').value, defaultEngine: $('#feishu-default-engine').value, model: $('#feishu-model').value, keepAwake: $('#feishu-awake').checked, allowedUserIds: $('#feishu-users').value.split(/[\s,]+/).filter(Boolean), disabledUserIds: [...ids('#feishu-disabled-users')], allowedChatIds: $('#feishu-chats').value.split(/[\s,]+/).filter(Boolean) };
      if ($('#feishu-autostart').checked !== autoStart) input.autoStart = $('#feishu-autostart').checked;
      const result = await api('PUT', 'feishu', input); autoStart = result.runtime.autoStart; owners = result.config.allowedUserIds.join('\n'); paint(result); $('#feishu-save-result').textContent = rt('已保存', 'Saved');
      $('#feishu-app-secret').placeholder = result.config.hasSecret ? rt('已保存，留空保持不变', 'Saved; leave blank to keep it') : '';
    } catch (error) { $('#feishu-save-result').textContent = error.message; }
    finally { secretInput.value = ''; secretDirty = false; hideSecret(); button.disabled = false; }
  };
  $('#feishu-pair').onclick = async () => { try { const result = await api('POST', 'feishu/pairing', {}); $('#feishu-pair-result').hidden = false; $('#feishu-pair-command').value = result.command; } catch (e) { toast(e.message, false); } };
  $('#feishu-copy-pair').onclick = async () => { try { await navigator.clipboard.writeText($('#feishu-pair-command').value); toast(rt('已复制', 'Copied')); } catch { $('#feishu-pair-command').select(); } };
  feishuStatusTimer = setInterval(async () => { if (state.type !== 'feishu') { stopFeishuPolling(); return; } try { paint(await api('GET', 'feishu')); } catch {} }, 3000);
}
