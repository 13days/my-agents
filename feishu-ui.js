let feishuStatusTimer = null;
// Older services don't report defaultEngine; then engine settings stay read-only until the panel restarts.
function feishuEngineSupported(c) { return typeof c.defaultEngine === 'string' && !!c.defaultEngine; }
function feishuEngineOptions(c) {
  const engines = ENGINES.map(engine => [engine.id, engine.label]);
  if (feishuEngineSupported(c) && !hasEngine(c.defaultEngine)) engines.push([c.defaultEngine, engineLabel(c.defaultEngine)]);
  return engines.map(([id, label]) => `<option value="${esc(id)}">${esc(label)}</option>`).join('');
}
function stopFeishuPolling() { clearInterval(feishuStatusTimer); feishuStatusTimer = null; }
async function renderFeishuGateway(revision = ++imRenderRevision) {
  stopFeishuPolling();
  const activeView = () => isFeishuView() && revision === imRenderRevision;
  let data;
  try { data = await api('GET', 'feishu'); } catch (e) { if (activeView() && revision === imRenderRevision) imChannelError(e.message); return; }
  if (!activeView() || revision !== imRenderRevision) return;
  const contactNamesSupported = !!data.capabilities?.contactNames;
  const shortcuts = new Set(['/help', '/new', '/sessions', '/current', '/queue', '/stop']);
  const commands = feishuHelp(ENGINES.map(engine => engine.id), { copy: rt }).flatMap(group => group.rows).filter(([command]) => shortcuts.has(command));
  const c = data.config, cliSetup = data.cliSetup || { available: false, phase: 'idle' };
  $('#empty').style.display = 'none'; $('#metabar').style.display = 'none'; $('#render').classList.add('wide'); $('#render').style.display = 'block';
  $('#title').firstChild.textContent = rt('IM 接入', 'IM connections'); $('#fpath').textContent = '';
  $('#editBtn').disabled = $('#delBtn').disabled = true;
  $('#render').innerHTML = `${imHeader(data)}
    <div class="gateway-status chart"><div><span id="feishu-phase" class="route-badge"></span><p id="feishu-connection-note" class="route-muted"></p></div><div class="gateway-runtime" id="feishu-runtime"></div></div>
    <div class="gateway-columns"><section class="chart"><h3>${esc(rt('连接机器人', 'Connect your bot'))}</h3>
      ${(data.bots || []).length ? `<div class="gateway-bots"><p class="route-muted">${esc(rt('同时监听的机器人', 'Bots listening'))}</p>${data.bots.map(bot => `<div class="gateway-bot" data-bot="${esc(bot.appId)}"><span class="status-dot" style="background:${bot.phase === 'connected' ? 'var(--green)' : 'var(--danger)'}"></span><code>${esc(bot.appId)}</code><span class="route-muted">${esc(bot.primary ? rt('主机器人', 'Primary') : rt('附加', 'Additional'))} · ${esc(bot.phase === 'connected' ? rt('已连接', 'Connected') : bot.lastError || bot.phase)} · ${esc(rt('授权用户 ', 'Users ') + bot.users)}</span>${bot.primary ? '' : `<button type="button" class="btn danger" data-remove-bot="${esc(bot.appId)}">${esc(rt('移除', 'Remove'))}</button>`}</div>`).join('')}</div>` : ''}
      <section id="feishu-cli-setup" class="gateway-cli-setup">
        <p class="route-muted">${esc(rt('用飞书扫一次码：自动创建机器人、开通卡片按钮、配对你的账号，并发给你一条欢迎消息。', 'Scan once: creates the bot, enables card buttons, pairs your account and sends you a welcome message.'))}</p>
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
        <div class="gateway-form-row"><label>${esc(rt('服务', 'Service'))}<select id="feishu-domain"><option value="feishu">飞书</option><option value="lark">Lark</option></select></label><label>${esc(rt('默认启动引擎', 'Default engine'))}<select id="feishu-default-engine" ${feishuEngineSupported(c) ? '' : 'disabled'}>${feishuEngineOptions(c)}</select></label></div>
        <p class="gateway-engine-hint route-muted">${esc(feishuEngineSupported(c) ? rt('新话题首次发送消息，或 /new 未指定引擎时，使用此默认值。已有话题继续使用各自绑定的引擎。', 'Used for the first message in an unbound topic and /new without an engine. Existing topics retain their engine.') : rt('当前运行的服务尚未加载引擎设置，请重启面板后使用默认引擎和 /engine 命令。', 'Restart the panel service to enable default-engine settings and /engine commands.'))}</p>
        <label>${esc(rt('默认执行机器', 'Default execution machine'))}<select id="feishu-default-machine"><option value="">${esc(rt('跟随新任务默认执行机器', 'Use the default machine for new tasks'))}</option>${(data.execution?.machines || []).map(machine => `<option value="${esc(machine.id)}">${esc(machine.label)} (${esc(machine.id)})</option>`).join('') || `<option value="local">${esc(rt('当前机器', 'This machine'))}</option>`}</select><small>${esc(rt('默认项目的目录属于这台机器，切换 IM 主节点时不会改变。', 'The default project belongs to this machine, independent of the IM leader.'))}</small></label><label>${esc(rt('Claude Code 模型（选填）', 'Claude Code model (optional)'))}<input id="feishu-model" value="${esc(c.model)}" placeholder="${esc(rt('沿用 Claude Code 默认模型', 'Use Claude Code default'))}"></label>
        <label>${esc(rt('默认项目', 'Default project'))}<div class="gateway-project"><input id="feishu-project" value="${esc(c.defaultProject)}" placeholder="${esc(rt('填写所选执行机器上的目录，或在飞书用 /new 选择', 'Enter a directory on the execution machine, or use /new in IM'))}"><button type="button" class="btn" id="feishu-project-pick">${esc(rt('选择文件夹', 'Choose folder'))}</button></div></label>
        <label class="gateway-check"><input type="checkbox" id="feishu-worktree" ${c.worktree !== false ? 'checked' : ''}>${esc(rt('新会话使用独立 Git worktree，避免并发任务修改同一目录', 'Use an isolated Git worktree for new sessions'))}</label><p class="route-muted">${esc(rt('从当前提交创建分支，未提交改动不带入；已有会话继续原目录。普通文件夹使用原目录。', 'Branches from the current commit without uncommitted changes. Existing sessions and non-Git folders retain their directory.'))}</p>
        <section id="feishu-access" class="gateway-access-card">
          <div class="gateway-permission-columns">
            <section class="chart gateway-policy" aria-labelledby="feishu-group-heading">
              <h3 id="feishu-group-heading">${esc(rt('群聊', 'Group chats'))}</h3>
              <p class="gateway-rule" id="feishu-group-rule" aria-live="polite"></p>
              <label class="gateway-check"><input type="checkbox" id="feishu-paired-groups" ${c.pairedInGroups !== false ? 'checked' : ''}>${esc(rt('允许已授权账号在任意群使用', 'Allow authorized accounts in any group'))}</label>
              <label class="gateway-check"><input type="checkbox" id="feishu-all-groups" ${c.allowAllGroups ? 'checked' : ''}>${esc(rt('允许所有群的成员使用', 'Allow members of every group'))}</label>
              <p class="route-muted">${esc(rt('多人群须直接 @机器人。只有一位真人时，获准使用的人可直接发消息。群主也遵循同一规则。', 'In groups, mention the bot directly. An authorized user can send without a mention when they are the only human. Group owners follow the same rules.'))}</p>
              ${c.appId ? `<p class="route-muted">${esc(rt('单人群免 @ 需要已发布的群消息和群信息读取权限。', 'To reply without a mention, the published app needs group message and chat information permissions.'))} <a href="${c.domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'}/app/${encodeURIComponent(c.appId)}/auth" target="_blank" rel="noreferrer">${esc(rt('查看飞书权限', 'View app permissions'))}</a></p>` : ''}
              <h4>${esc(rt('向全群开放的详细卡片', 'Groups with detailed cards'))}</h4>
              <p class="route-muted">${esc(rt('勾选一个群，群内成员都可使用机器人和会话按钮。其他获准的群使用文字回复。', 'Select a group to give its members access and enable session controls. Other eligible groups receive text replies.'))}</p>
              <div id="feishu-known-groups" class="gateway-contact-list"></div>
            </section>
            <section class="chart gateway-policy" aria-labelledby="feishu-dm-heading">
              <h3 id="feishu-dm-heading">${esc(rt('私聊与账号授权', 'Direct messages and accounts'))}</h3>
              <p class="gateway-rule" id="feishu-dm-rule" aria-live="polite"></p>
              <label class="gateway-check"><input type="checkbox" id="feishu-all-users" ${c.allowAllUsers ? 'checked' : ''}>${esc(rt('允许所有人私聊，无需配对', 'Allow anyone to message the bot directly'))}</label>
              <h4>${esc(rt('授权账号', 'Authorized accounts'))}</h4>
              <p class="route-muted">${esc(rt('配对或勾选即可授权。禁用账号会同时阻止私聊和群聊。', 'Pair an account or select it below to authorize it. Disabling an account blocks both direct and group chats.'))}</p>
              <div id="feishu-known-users" class="gateway-contact-list"></div>
            </section>
          </div>
          <div class="gateway-contact-toolbar"><button type="button" class="btn" id="feishu-contact-refresh" ${contactNamesSupported ? '' : 'disabled'}>${esc(rt('同步飞书名称', 'Sync Feishu names'))}</button><p id="feishu-contact-sync-result" class="route-muted" role="status"></p><p id="feishu-access-result" class="route-muted" role="status">${esc(rt('勾选后自动保存，对新消息生效。', 'Selections save automatically and apply to new messages.'))}</p><button type="button" class="btn" id="feishu-access-retry" hidden>${esc(rt('重新保存', 'Retry save'))}</button></div>
          <details class="gateway-access"><summary>${esc(rt('手动添加或检查 ID（可选）', 'Edit IDs manually (optional)'))}</summary><label>${esc(rt('允许的用户 Open ID', 'Allowed user Open IDs'))}<textarea id="feishu-users" rows="3">${esc(c.allowedUserIds.join('\n'))}</textarea></label><label>${esc(rt('禁用的用户 Open ID', 'Disabled user Open IDs'))}<textarea id="feishu-disabled-users" rows="2">${esc((c.disabledUserIds || []).join('\n'))}</textarea></label><label>${esc(rt('允许的群 Chat ID', 'Allowed group chat IDs'))}<textarea id="feishu-chats" rows="2">${esc(c.allowedChatIds.join('\n'))}</textarea></label></details>
        </section>
        <label class="gateway-check"><input type="checkbox" id="feishu-native-auto-accept" ${c.nativeAutoAccept ? 'checked' : ''}>${esc(rt('原终端自动接收消息，无需回电脑确认', 'Accept messages in the original terminal without desktop confirmation'))}</label>
        <p class="route-muted">${esc(rt('启用 Claude Code 用户级跨会话自动接收；其他本机跨会话消息也会自动接收。飞书用户和群授权仍按上方配置检查；不更改原窗口的工具权限。关闭后还原面板改动前的接收设置。', 'Enables the Claude Code user-level cross-session receive policy, including other local peer messages. Feishu access rules and terminal tool permissions still apply. Turning this off restores the prior receive setting.'))}</p>
        ${data.runtime.nativeInbox?.error ? `<p class="gateway-access-warning">${esc(data.runtime.nativeInbox.error)}</p>` : ''}
        <div class="gateway-power"><label class="gateway-check gateway-online"><input type="checkbox" id="feishu-online" ${c.keepAwake && data.runtime.autoStart ? 'checked' : ''} ${data.runtime.supported ? '' : 'disabled'}><span><strong>${esc(rt('保持在线', 'Stay online'))}</strong> · ${esc(rt('防止 Mac 睡眠，并在登录后自动启动面板', 'Keep the Mac awake and start the panel at login'))}</span></label><div hidden><label class="gateway-check"><input type="checkbox" id="feishu-awake" ${c.keepAwake ? 'checked' : ''} ${data.runtime.supported ? '' : 'disabled'}>${esc(rt('防止 Mac 闲置睡眠（合盖仍可能睡眠）', 'Prevent idle sleep (closing the lid may still force sleep)'))}</label><label class="gateway-check"><input type="checkbox" id="feishu-autostart" ${data.runtime.autoStart ? 'checked' : ''} ${data.runtime.supported ? '' : 'disabled'}>${esc(rt('登录后自动启动（下次登录生效）', 'Start automatically at login (effective next login)'))}</label></div><p class="route-muted">${esc(rt('需保持网络与供电。合盖、手动睡眠或关机时无法保证在线。飞书任务默认跳过 Claude Code 工具权限确认。', 'Keep the network and power connected. Closing the lid, forcing sleep or shutting down can take the gateway offline. Tasks skip Claude Code tool permission prompts by default.'))}</p></div>
        <div class="gateway-form-footer"><span id="feishu-save-result" role="status"></span><button class="btn primary" type="submit" id="feishu-save">${esc(rt('保存配置', 'Save configuration'))}</button></div>
      </form></section>
      <div class="gateway-side"><section class="gateway-pair-card"><h4>${esc(rt('通过配对命令授权', 'Authorize with a pairing command'))}</h4><p class="route-muted">${esc(rt('生成一次性命令，让要授权的人在飞书私聊中发给机器人。', 'Generate a one-time command for the person to send to the bot in a direct message.'))}</p><button type="button" class="btn" id="feishu-pair">${esc(rt('生成配对命令', 'Generate pairing command'))}</button><div id="feishu-pair-result" hidden><input id="feishu-pair-command" readonly aria-label="Pairing command"><button class="btn" id="feishu-copy-pair">${esc(rt('复制', 'Copy'))}</button><p class="route-muted">${esc(rt('10 分钟有效；使用一次或重启 Panel 后失效。', 'Expires after 10 minutes, one use, or a Panel restart.'))}</p></div><p class="route-muted" id="feishu-paired-count"></p></section>
      <section class="chart"><h3>${esc(rt('在飞书里使用', 'Use it in Feishu'))}</h3><div class="gateway-command-list">${commands.map(([command, hint]) => `<code>${esc(command)}</code><span>${esc(hint)}</span>`).join('')}</div><p class="route-muted">${esc(rt('私聊和各个群话题分别绑定会话。发送 /help 可打开「找会话」「新建任务」，以及当前聊天可使用的命令。', 'DMs and group topics keep separate sessions. Send /help for Find session, New task and commands available in this chat.'))}</p></section></div></div>
    <section class="chart gateway-inbox"><div class="route-heading"><h3>${esc(rt('收到的消息', 'Received messages'))}</h3><span id="feishu-inbox-count" class="route-muted"></span><button class="btn" type="button" id="feishu-inbox-refresh">${esc(rt('刷新记录', 'Refresh log'))}</button></div>
      <p class="route-muted">${esc(rt('在本机完整保存飞书实际推送给机器人的消息、发送人和群信息，包括被权限拦截的消息。不会补采历史聊天；内容仅在此 Mac 保存。', 'Stores complete messages actually delivered to the bot on this Mac, including blocked messages. It does not fetch past chat history.'))}</p>
      <div class="gateway-inbox-filters"><select id="feishu-log-user" aria-label="${esc(rt('按用户筛选消息', 'Filter messages by user'))}"></select><select id="feishu-log-chat" aria-label="${esc(rt('按群筛选消息', 'Filter messages by group'))}"></select></div>
      <div id="feishu-inbox-items"></div><button class="btn" type="button" id="feishu-inbox-more" hidden>${esc(rt('加载更早消息', 'Load earlier messages'))}</button>
    </section>
    <details class="chart gateway-setup" ${c.appId || cliSetup.available ? '' : 'open'}><summary>${esc(rt('首次接入：飞书应用配置', 'First-time app setup'))}</summary><ol><li>${esc(rt('在飞书开放平台创建企业自建应用，开启机器人能力，填写上面的 App ID 和 Secret。', 'Create a custom app in the developer console, enable the bot feature, and enter its App ID and Secret above.'))} <a href="https://open.feishu.cn/app" target="_blank" rel="noreferrer">${esc(rt('打开飞书开放平台', 'Open developer console'))}</a></li><li>${esc(rt('开通 im:message:send_as_bot、im:message.p2p_msg:readonly、im:message.reactions:write_only 权限；群聊 @ 需要 im:message.group_at_msg:readonly，免 @ 还需开通 im:message.group_msg 和 im:chat:read 并发布。', 'Enable im:message:send_as_bot im:message.p2p_msg:readonly and im:message.reactions:write_only; add im:message.group_at_msg:readonly for mentions. Unmentioned group messages also require im:message.group_msg and im:chat:read in the published app.'))}</li><li>${esc(rt('事件配置选择“长连接”，订阅 im.message.receive_v1；回调配置也选择“长连接”，添加 card.action.trigger。', 'Choose long connection for events and subscribe to im.message.receive_v1. Also choose long connection under callbacks and add card.action.trigger.'))}</li><li>${esc(rt('发布应用版本，确认你在应用可用范围内；保存启用网关后完成配对。', 'Publish the app, include yourself in its availability scope, then enable the gateway and pair your account.'))}</li></ol><p class="route-muted">${esc(rt('Mac 主动连接飞书，不需要公网 IP、端口映射或共享云存储。会话记录仍以这台 Mac 上的 Panel 为准。', 'The Mac connects outbound to Feishu. No public IP, port forwarding or shared cloud store is required. Session records remain on this Mac.'))}</p><p id="feishu-sdk-hint" class="route-muted" ${data.sdkAvailable ? 'hidden' : ''}>${esc(rt('源码运行需先安装可选依赖：npm install', 'For source checkouts, install the optional dependency first: npm install'))}</p></details>`;
  bindIMChannelControls();
  const online = $('#feishu-online');
  if (online) online.onchange = () => { $('#feishu-awake').checked = online.checked; $('#feishu-autostart').checked = online.checked; $('#feishu-form').requestSubmit(); };
  document.querySelectorAll('[data-remove-bot]').forEach(button => button.onclick = async () => {
    if (!confirm(rt('停止监听并移除这个附加机器人？飞书里的应用本身不会被删除。', 'Stop listening and remove this bot? The Feishu app itself is kept.'))) return;
    try { await api('DELETE', 'feishu/bots/' + encodeURIComponent(button.dataset.removeBot)); toast(rt("已移除", "Removed")); renderFeishuGateway(); } catch (error) { toast(error.message); }
  });
  // Keep the existing form controls and handlers; organize them into focused pages.
  const canvas = $('#render');
  const status = canvas.querySelector('.gateway-status');
  const columns = canvas.querySelector('.gateway-columns');
  const connection = columns.firstElementChild;
  connection.classList.add('gateway-connection-card');
  connection.querySelector('h3').innerHTML = `<span class="gateway-step">01</span>${esc(rt('连接机器人', 'Connect your bot'))}`;
  const side = columns.querySelector('.gateway-side');
  const pairing = side.firstElementChild;
  const access = $('#feishu-access');
  $('#feishu-known-users').after(pairing);
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
  engineGuide.innerHTML = `<h4>${esc(rt('话题与引擎', 'Topics & engines'))}</h4><p class="route-muted">${esc(rt(`每个私聊、群和话题独立绑定会话，可分别使用 ${ENGINES.map(engine => engine.label).join(' 或 ')}。同一话题内成员共用绑定，重启后保留。`, 'Private chats, groups and topics have independent sessions and engines. Members of a topic share its binding, which survives restarts.'))}</p><dl><dt><code>/engine</code></dt><dd>${esc(rt('查看当前引擎与切换选项', 'View the engine and choices'))}</dd><dt><code>/codex</code></dt><dd>${esc(rt('切到 Codex，可在后面直接带问题', 'Use Codex, optionally followed by a prompt'))}</dd><dt><code>/claude</code></dt><dd>${esc(rt('切到 Claude，可在后面直接带问题', 'Use Claude, optionally followed by a prompt'))}</dd><dt><code>/new</code></dt><dd>${esc(rt('使用默认项目与默认引擎', 'Use the default project and engine'))}</dd><dt><code>/current</code></dt><dd>${esc(rt('查看当前位置的会话与引擎', 'View this session and engine'))}</dd></dl><p class="route-muted">${esc(rt('切换时各引擎分别接续上下文；/new codex 或 /new claude 强制新建。简洁模式同样支持引擎命令，并在回复末尾标注引擎；群内请 @机器人发送。', 'Each engine resumes its own context. /new codex or /new claude starts fresh. Simple mode supports engine commands and labels replies. @mention the bot in groups.'))}</p>`;
  if (!feishuEngineSupported(c)) { const notice = document.createElement('p'); notice.className = 'gateway-access-warning'; notice.textContent = rt('当前服务需要重启后才能使用下列新引擎命令。', 'Restart the service before using the new engine commands below.'); engineGuide.prepend(notice); }
  referenceDetails.before(engineGuide);
  const journey = document.createElement('div'); journey.className = 'gateway-journey';
  journey.innerHTML = [['01', rt('连接机器人', 'Connect bot'), rt('扫码创建或填写应用凭证', 'Scan or enter app credentials')], ['02', rt('设置权限', 'Set access'), rt('配对账号，选择允许的群', 'Pair users and allow groups')], ['03', rt('开始对话', 'Start chatting'), rt('发送消息，在这里查看记录', 'Send messages and inspect the log')]].map(([n, title, note]) => `<div><span class="gateway-step">${n}</span><span><strong>${esc(title)}</strong><small>${esc(note)}</small></span></div>`).join('');
  side.prepend(journey);
  const inbox = canvas.querySelector('.gateway-inbox');
  const help = canvas.querySelector('.gateway-setup'); help.open = false;
  const connectionPanel = document.createElement('section'); connectionPanel.append(columns, help);
  const accessPanel = document.createElement('section'); accessPanel.append(access);
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
  $('#feishu-default-engine').value = c.defaultEngine || ENGINE_DEFAULT;
  $('#feishu-default-machine').value = c.defaultMachine || '';
  $('#feishu-cli-brand').value = c.domain;
  const selectedMachine = () => {
    const id = $('#feishu-default-machine').value || data.execution?.defaultMachine || data.execution?.selfId || 'local';
    return data.execution?.machines?.find(item => item.id === id) || { id, label: id };
  };
  const syncProjectPicker = () => { $('#feishu-project-pick').disabled = selectedMachine().online === false; };
  $('#feishu-default-machine').onchange = async () => {
    syncProjectPicker();
    const id = $('#feishu-default-machine').value;
    $('#feishu-project').value = '';
    if (!id) return;
    try { const spaces = await api('GET', 'workspaces'); if ($('#feishu-default-machine')?.value === id) $('#feishu-project').value = spaces.machines.find(machine => machine.id === id)?.defaultDirectory || ''; } catch (error) { toast(error.message, false); }
  }; syncProjectPicker();
  let setupWasActive = ['starting', 'waiting', 'completing'].includes(cliSetup.phase), hasCredentials = c.hasSecret, recoverExisting = false, callbackReady = !!c.cardCallbacksReady;
  let autoStart = data.runtime.autoStart;
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
        if (revision !== secretRevision || !activeView() || !secretInput.isConnected) return;
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
    $('#feishu-cli-create').textContent = recoverExisting ? rt('连接已创建机器人', 'Connect the created bot') : hasCredentials || setup.phase === 'complete' ? rt('＋ 扫码添加机器人', 'Add a bot with QR code') : rt('扫码创建机器人', 'Create bot with QR code');
    $('#feishu-cli-brand').disabled = active;
    $('#feishu-cli-callbacks').hidden = !hasCredentials;
    $('#feishu-cli-callbacks').disabled = active || callbackReady;
    $('#feishu-cli-callbacks').textContent = callbackReady ? rt('卡片按钮已启用', 'Card buttons enabled') : rt('启用卡片按钮（扫码）', 'Enable card buttons (scan)');
    $('#feishu-cli-cancel').hidden = !['starting', 'waiting'].includes(setup.phase);
    const phases = { starting: rt('正在生成二维码…', 'Preparing QR code…'), waiting: rt('请用飞书或 Lark 扫码，并完成页面上的创建步骤。', 'Scan with Feishu or Lark and complete the setup steps.'), completing: rt('应用已创建，正在自动连接…', 'App created. Connecting…'), complete: setup.owner ? rt(`接入完成：已自动配对你的账号${setup.callbacks ? '并开通卡片按钮' : ''}${setup.welcomed ? '，欢迎消息已发到你的飞书' : ''}。`, 'Done: your account is paired and the bot has messaged you in Feishu.') : rt('应用已创建并连接。未能识别扫码账号，请在下方生成配对码，私聊机器人发送。', 'App connected. Pair your account below.'), cancelled: rt('已取消，可重新扫码创建。', 'Cancelled. You can try again.') };
    const callbackPhases = { starting: rt('正在生成现有机器人的补充授权二维码…', 'Preparing authorization for your existing bot…'), waiting: setup.afterCreate ? rt('机器人已创建并配对，还差最后一步：再扫一次码开通卡片按钮（不会新建机器人）。', 'Bot created and paired. One more scan enables its card buttons.') : rt('请扫码授权当前机器人的应用配置权限，完成后将自动开通长连接卡片回调；不会新建机器人。', 'Scan to authorize configuration of the existing bot. Card callbacks will be enabled automatically.'), completing: rt('正在开通长连接卡片回调…', 'Enabling card callbacks…'), complete: rt('卡片按钮已配置，可回到飞书点击“切换到此会话”。', 'Card buttons configured. Return to Feishu and select a session.') };
    $('#feishu-cli-state').textContent = setup.error || (setup.purpose === 'callbacks' ? callbackPhases[setup.phase] : phases[setup.phase]) || phases[setup.phase] || '';
    const link = $('#feishu-cli-link'), image = $('#feishu-cli-qr-image');
    const validUrl = typeof setup.verificationUrl === 'string' && setup.verificationUrl.startsWith('https://');
    $('#feishu-cli-qr').hidden = !validUrl;
    if (validUrl) link.href = setup.verificationUrl; else link.removeAttribute('href');
    // The page draws the QR code itself (vendor/qr.js), so no CLI is required.
    let qr = ''; try { if (validUrl && window.QR) qr = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(QR.svg(setup.verificationUrl, { size: 240 })); } catch {}
    image.hidden = !qr;
    if (qr) image.src = qr; else image.removeAttribute('src');
    if (setupWasActive && setup.phase === 'complete') {
      setupWasActive = false;
      api('GET', 'feishu').then(result => {
        if (!activeView() || !$('#feishu-app-id')) return;
        $('#feishu-app-id').value = result.config.appId;
        $('#feishu-domain').value = result.config.domain;
        $('#feishu-enabled').checked = result.config.enabled;
        $('#feishu-app-secret').placeholder = rt('已保存，留空保持不变', 'Saved; leave blank to keep it');
      }).catch(e => toast(e.message, false));
    }
  };
  let contactsSignature = '', knownContacts = { users: [], groups: [] }, logCursor, logBusy = false;
  const ids = selector => new Set($(selector).value.split(/[\s,]+/).filter(Boolean));
  let accessSave = Promise.resolve(), accessRevision = 0, accessUnsaved = false;
  const accessFields = { allowAllUsers: '#feishu-all-users', allowAllGroups: '#feishu-all-groups', pairedInGroups: '#feishu-paired-groups', allowedUserIds: '#feishu-users', disabledUserIds: '#feishu-disabled-users', allowedChatIds: '#feishu-chats' };
  const accessInput = () => Object.fromEntries(Object.entries(accessFields).map(([key, selector]) =>
    [key, $(selector).type === 'checkbox' ? $(selector).checked : [...ids(selector)]]));
  let lastAccess = accessInput();
  const saveAccess = () => {
    const revision = ++accessRevision;
    const input = accessInput();
    accessUnsaved = true;
    $('#feishu-access-retry').hidden = true;
    $('#feishu-access-result').textContent = rt('正在保存权限…', 'Saving access…');
    accessSave = accessSave.then(async () => {
      try {
        const result = await api('PUT', 'feishu', input);
        if (!activeView() || !$('#feishu-access-result') || revision !== accessRevision) return;
        lastAccess = input; accessUnsaved = false;
        paint(result);
        $('#feishu-access-result').textContent = rt('权限已保存，新消息立即生效', 'Access saved. Applies to new messages immediately.');
      } catch (error) {
        if (activeView() && $('#feishu-access-result') && revision === accessRevision) {
          $('#feishu-access-result').textContent = rt('权限未保存：', 'Access not saved: ') + error.message;
          $('#feishu-access-retry').hidden = false;
        }
      }
    });
    return accessSave;
  };
  $('#feishu-access-retry').onclick = saveAccess;
  const editContactLabel = item => {
    const dialog = document.createElement('dialog'); dialog.className = 'contact-label-dialog';
    dialog.innerHTML = `<form><h3>${esc(rt('备注名称', 'Contact label'))}</h3><p class="route-muted">${esc(item.name || item.id)}</p><label>${esc(rt('本机备注', 'Local label'))}<input maxlength="80" autocomplete="off" spellcheck="false" placeholder="${esc(rt('例如：张三、产品讨论群', 'e.g. Alex, Product team'))}"></label><p class="route-muted">${esc(rt('仅在此面板显示，不修改飞书名称。清空后恢复显示飞书名称。', 'Used only in this panel. Clear it to show the Feishu name again.'))}</p><p class="contact-label-error" role="alert"></p><footer><button class="btn" type="button">${esc(rt('取消', 'Cancel'))}</button><button class="btn primary" type="submit">${esc(rt('保存', 'Save'))}</button></footer></form>`;
    const input = dialog.querySelector('input'); input.value = item.alias || '';
    dialog.querySelector('button[type="button"]').onclick = () => dialog.close();
    dialog.addEventListener('close', () => dialog.remove());
    dialog.addEventListener('keydown', event => { if (event.key === 'Escape') event.stopPropagation(); });
    dialog.querySelector('form').onsubmit = async event => {
      event.preventDefault(); const button = dialog.querySelector('button[type="submit"]'); button.disabled = true;
      try { const result = await api('POST', 'feishu/contacts/label', { id: item.id, label: input.value }); if (activeView()) { paint(result); await loadMessages(); } dialog.close(); }
      catch (error) { dialog.querySelector('.contact-label-error').textContent = error.message; }
      finally { button.disabled = false; }
    };
    document.body.append(dialog); dialog.showModal(); input.focus(); input.select();
  };
  const paintContacts = inbox => {
    if (inbox) knownContacts = inbox;
    const allGroups = $('#feishu-all-groups').checked, pairedGroups = $('#feishu-paired-groups').checked;
    const allUsers = $('#feishu-all-users').checked, disabled = ids('#feishu-disabled-users');
    const hasGroups = ids('#feishu-chats').size > 0;
    const groupRule = allGroups ? rt('机器人加入的所有群，成员都可以使用。', 'Members of every group the bot has joined can use it.')
      : pairedGroups ? rt('已授权账号可在机器人加入的任意群使用，无需逐群勾选。其他成员仅可在下方勾选的群使用。', 'Authorized accounts can use the bot in any group it has joined. Other members can use it in the selected groups below.')
      : hasGroups ? rt('仅下方勾选的群允许成员使用。', 'Only members of the groups selected below can use the bot in a group.')
      : rt('当前没有向成员开放的群。', 'Group access is currently closed.');
    $('#feishu-group-rule').textContent = groupRule;
    $('#feishu-dm-rule').textContent = allUsers ? rt('所有未禁用的账号都可私聊；跨群权限单独按授权名单判断。', 'Anyone except disabled accounts can send a direct message. Account-based group access uses the authorization list.')
      : rt('只有已授权且未禁用的账号可以私聊机器人。', 'Only authorized accounts that are not disabled can send direct messages.');
    const signature = JSON.stringify([knownContacts, $('#feishu-users').value, $('#feishu-chats').value, $('#feishu-disabled-users').value, $('#feishu-all-users').checked, $('#feishu-all-groups').checked, pairedGroups]);
    if (signature === contactsSignature) return;
    contactsSignature = signature;
    for (const [kind, selector, hostId] of [['users', '#feishu-users', '#feishu-known-users'], ['groups', '#feishu-chats', '#feishu-known-groups']]) {
      const selected = ids(selector), entries = new Map((knownContacts[kind] || []).map(item => [item.id, item]));
      for (const id of new Set([...selected, ...(kind === 'users' ? ids('#feishu-disabled-users') : [])])) if (!entries.has(id)) entries.set(id, { id, name: '', count: 0 });
      const host = $(hostId); host.replaceChildren();
      if (!entries.size) { const empty = document.createElement('p'); empty.className = 'route-muted'; empty.textContent = kind === 'groups' ? rt('还没有收到群消息。把机器人加入群并 @它，群会自动出现在这里。', 'No group messages yet. Add the bot to a group and @mention it.') : rt('还没有收到用户消息。', 'No users discovered yet.'); host.append(empty); }
      for (const item of entries.values()) {
        const label = document.createElement('label'); label.className = 'gateway-contact';
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.dataset.contactId = item.id;
        const blocked = kind === 'users' && disabled.has(item.id);
        checkbox.checked = selected.has(item.id) && !blocked;
        checkbox.disabled = blocked;
        checkbox.setAttribute('aria-label', (kind === 'users' ? rt('授权账号', 'Authorize account') : rt('向全群开放详细卡片', 'Allow this group and enable detailed cards')) + ' ' + (item.displayName || item.name || item.id));
        const info = document.createElement('span'), name = document.createElement('strong'), detail = document.createElement('small');
        name.textContent = item.displayName || item.alias || item.name || (kind === 'groups' ? rt('未获取群名', 'Unnamed group') : rt('未获取姓名', 'Unnamed user')) + ' · ' + item.id.slice(-6);
        const title = document.createElement('span'); title.className = 'gateway-contact-title';
        title.append(name);
        if (item.alias) { const source = document.createElement('span'); source.className = 'gateway-contact-source'; source.textContent = rt('备注', 'Label'); title.append(source); }
        const activity = document.createElement('span'); activity.className = 'gateway-contact-meta';
        const scope = kind === 'groups' ? (checkbox.checked ? rt('全群可用 · 详细卡片', 'All members · Detailed cards') : allGroups ? rt('全群可用 · 文字回复', 'All members · Text replies') : pairedGroups ? rt('限已授权账号', 'Authorized accounts only') : rt('未开放', 'Closed'))
          : blocked ? rt('已禁用', 'Disabled') : checkbox.checked ? rt('已授权', 'Authorized') : allUsers ? rt('可私聊 · 未单独授权', 'Direct messages allowed · Not individually authorized') : rt('未授权', 'Not authorized');
        activity.textContent = [scope, item.count ? `${item.count} ${rt('条消息', 'messages')}` : ''].filter(Boolean).join(' · ');
        name.title = item.id;
        detail.append(activity);
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
          block.onclick = event => { event.preventDefault(); const current = ids('#feishu-disabled-users'); if (disabled) current.delete(item.id); else current.add(item.id); $('#feishu-disabled-users').value = [...current].join('\n'); paintContacts(); saveAccess(); };
          actions.append(block);
        }
        checkbox.onchange = () => { const current = ids(selector); if (checkbox.checked) current.add(item.id); else current.delete(item.id); $(selector).value = [...current].join('\n'); paintContacts(); saveAccess(); };
      }
    }
    for (const [selector, entries, placeholder] of [['#feishu-log-user', knownContacts.users || [], rt('所有用户', 'All users')], ['#feishu-log-chat', knownContacts.groups || [], rt('所有私聊和群', 'All chats')]]) {
      const select = $(selector), value = select.value; select.replaceChildren(new Option(placeholder, ''));
      for (const item of entries) { const name = item.displayName || item.alias || item.name; select.add(new Option(name ? `${name} · ${item.id}` : item.id, item.id)); }
      select.value = value;
    }
  };
  const loadMessages = async (reset = true) => {
    if (logBusy || !activeView()) return;
    logBusy = true; $('#feishu-inbox-refresh').disabled = true;
    try {
      const q = new URLSearchParams(); if (!reset && logCursor !== undefined) q.set('before', logCursor);
      if ($('#feishu-log-user').value) q.set('userId', $('#feishu-log-user').value);
      if ($('#feishu-log-chat').value) q.set('chatId', $('#feishu-log-chat').value);
      const result = await api('GET', 'feishu/messages?' + q);
      if (!activeView() || !$('#feishu-inbox-items')) return;
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
    if (!activeView() || !$('#feishu-phase')) return;
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
    const leaderNote = d.cluster?.leader ? `${rt('IM 主节点', 'IM leader')}：${d.cluster.label || d.cluster.leader} · ` : '';
    $('#feishu-connection-note').textContent = leaderNote + (d.phase !== 'connected' && d.lastError ? connectionError : (d.bot ? `${d.bot} · ${rt('长连接接入', 'Long connection')}` : rt(`连接后，可在飞书接续 ${ENGINES.map(engine => engine.label).join(' 与 ')} 会话。`, `Connect to continue ${ENGINES.map(engine => engine.label).join(' and ')} sessions from Feishu.`)));
    $('#feishu-runtime').title = d.runtime.claudeCli || '';
    $('#feishu-runtime').textContent = `${d.runtime.claudeVersion ? 'Claude Code ' + d.runtime.claudeVersion + ' · ' : ''}${d.runtime.keepAwake ? (d.runtime.lidSleepDisabled ? rt('Mac 保活中（含合盖）', 'Mac kept awake, lid included') : rt('Mac 保活中（合盖仍会睡眠：终端运行 sudo pmset -a disablesleep 1 可关闭）', 'Mac kept awake (closing the lid still sleeps)')) : rt('未启用保活', 'Keep-awake off')} · ${d.runtime.autoStart ? rt('已配置登录启动', 'Login startup configured') : rt('未配置登录启动', 'Login startup off')}${d.runtime.backgroundService ? ' · ' + rt('后台服务运行中', 'Background service running') : ''}`;
    const blocked = new Set(d.config.disabledUserIds || []);
    $('#feishu-paired-count').textContent = rt('已授权账号 ', 'Authorized accounts: ') + d.config.allowedUserIds.filter(id => !blocked.has(id)).length;
    if (!accessUnsaved) {
      const current = accessInput();
      for (const [key, selector] of Object.entries(accessFields)) {
        if (JSON.stringify(current[key]) !== JSON.stringify(lastAccess[key]) || document.activeElement === $(selector)) continue;
        const input = $(selector);
        if (input.type === 'checkbox') input.checked = key === 'pairedInGroups' ? d.config[key] !== false : !!d.config[key];
        else input.value = (d.config[key] || []).join('\n');
        lastAccess[key] = input.type === 'checkbox' ? input.checked : [...ids(selector)];
      }
    }
    $('#feishu-inbox-count').textContent = `${d.inbox?.messageCount || 0} ${rt('条已保存', 'saved messages')}`;
    paintContacts(d.inbox);
  };
  paint(data);
  for (const selector of ['#feishu-paired-groups', '#feishu-all-users', '#feishu-all-groups', '#feishu-users', '#feishu-chats', '#feishu-disabled-users']) $(selector).addEventListener('change', () => { paintContacts(); saveAccess(); });
  $('#feishu-contact-refresh').onclick = async () => {
    const button = $('#feishu-contact-refresh'); button.disabled = true; $('#feishu-contact-sync-result').textContent = rt('正在同步名称…', 'Syncing names…');
    try { const result = await api('POST', 'feishu/contacts/refresh', {}); if (!activeView()) return; paint(result); const summary = result.nameRefresh || {}; $('#feishu-contact-sync-result').textContent = rt(`已同步 ${summary.updated || 0} 项${summary.failed ? `；${summary.failed} 项暂未获取，可添加备注` : ''}`, `Synced ${summary.updated || 0}${summary.failed ? `; ${summary.failed} unavailable, use local labels` : ''}`); await loadMessages(); }
    catch (error) { if (activeView()) $('#feishu-contact-sync-result').textContent = error.message; }
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
  $('#feishu-project-pick').onclick = async () => { try { const path = await chooseMachineDirectory(selectedMachine(), { initial: $('#feishu-project').value }); if (path) $('#feishu-project').value = path; } catch (e) { toast(e.message, false); } };
  $('#feishu-form').onsubmit = async e => {
    e.preventDefault(); const button = $('#feishu-save'); button.disabled = true; $('#feishu-save-result').textContent = rt('正在保存…', 'Saving…');
    try {
      await accessSave;
      const input = { worktree: $('#feishu-worktree').checked, allowAllUsers: $('#feishu-all-users').checked, allowAllGroups: $('#feishu-all-groups').checked, pairedInGroups: $('#feishu-paired-groups').checked, enabled: $('#feishu-enabled').checked, appId: $('#feishu-app-id').value, appSecret: secretDirty ? secretInput.value : '', domain: $('#feishu-domain').value, defaultProject: $('#feishu-project').value, defaultMachine: $('#feishu-default-machine').value, defaultEngine: $('#feishu-default-engine').value, model: $('#feishu-model').value, keepAwake: $('#feishu-awake').checked, nativeAutoAccept: $('#feishu-native-auto-accept').checked, allowedUserIds: $('#feishu-users').value.split(/[\s,]+/).filter(Boolean), disabledUserIds: [...ids('#feishu-disabled-users')], allowedChatIds: $('#feishu-chats').value.split(/[\s,]+/).filter(Boolean) };
      if ($('#feishu-autostart').checked !== autoStart) input.autoStart = $('#feishu-autostart').checked;
      const result = await api('PUT', 'feishu', input); autoStart = result.runtime.autoStart; lastAccess = accessInput(); accessUnsaved = false; paint(result); $('#feishu-save-result').textContent = rt('已保存', 'Saved');
      $('#feishu-app-secret').placeholder = result.config.hasSecret ? rt('已保存，留空保持不变', 'Saved; leave blank to keep it') : '';
    } catch (error) { $('#feishu-save-result').textContent = error.message; }
    finally { secretInput.value = ''; secretDirty = false; hideSecret(); button.disabled = false; }
  };
  $('#feishu-pair').onclick = async () => { try { const result = await api('POST', 'feishu/pairing', {}); $('#feishu-pair-result').hidden = false; $('#feishu-pair-command').value = result.command; } catch (e) { toast(e.message, false); } };
  $('#feishu-copy-pair').onclick = async () => { try { await navigator.clipboard.writeText($('#feishu-pair-command').value); toast(rt('已复制', 'Copied')); } catch { $('#feishu-pair-command').select(); } };
  feishuStatusTimer = setInterval(async () => { if (!activeView()) { stopFeishuPolling(); return; } const revision = accessRevision; try { const status = await api('GET', 'feishu'); if (revision === accessRevision) paint(status); } catch {} }, 3000);
}
