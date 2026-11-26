// Enterprise WeChat's intelligent bot owns its credentials and connection state.
async function renderWecom(revision) {
  const active = () => revision === imRenderRevision && state.type === 'im' && imSelectedChannel === 'wecom';
  const t = (zh, en) => esc(rt(zh, en));
  const phaseLabels = {
    disabled: ['未启用', 'Off'], connecting: ['正在认证', 'Authenticating'],
    connected: ['已连接', 'Connected'], reconnecting: ['正在重连', 'Reconnecting'], error: ['需要处理', 'Action needed'],
  };
  $('#render').innerHTML = imHeader() + '<p role="status" class="route-muted">' + t('正在读取企业微信连接…', 'Loading WeCom connection…') + '</p>';
  bindIMChannelControls();
  try {
    const [data, workspaces] = await Promise.all([api('GET', 'wecom'), api('GET', 'workspaces')]);
    if (!active()) return;
    const config = data.config;
    $('#render').innerHTML = imHeader(data) + `<section class="channel-setup">
      <header class="channel-status"><h2>${t('企业微信智能机器人', 'WeCom intelligent bot')}</h2><span role="status" data-phase></span></header>
      <p data-activity class="route-muted"></p><p data-connection-error role="status"></p>
      <form id="wecom-form" class="channel-form">
        <fieldset><legend>${t('机器人连接', 'Bot connection')}</legend>
        <p>${t('在企业微信创建智能机器人，选择 API 模式 → 长连接，把 Bot ID 和 Secret 填在这里。面板会主动连接企业微信，无需公网回调地址。', 'Create an intelligent bot in WeCom, choose API mode → Long connection, then enter its Bot ID and Secret. The panel connects outbound without a public callback URL.')}</p>
        <div class="channel-fields"><label>Bot ID<input name="botId" required maxlength="256" autocomplete="off" spellcheck="false" value="${esc(config.botId)}"></label>
        <label>Secret<input name="secret" type="password" maxlength="2048" autocomplete="new-password" placeholder="${config.hasSecret ? t('已保存，留空沿用', 'Saved · leave blank to keep') : ''}" ${config.hasSecret ? '' : 'required'}></label></div></fieldset>
        <fieldset><legend>${t('谁可以运行任务', 'Who can run tasks')}</legend>
        <p data-owner></p><label>${t('其他可运行任务的成员 UserID', 'Additional member UserIDs')}<textarea rows="2" name="allowedUsers" spellcheck="false" placeholder="${t('每行一个 UserID', 'One UserID per line')}">${esc(config.allowedUsers.join('\n'))}</textarea></label>
        <p>${t('首位发消息的人自动成为 Owner，可以直接私聊或在群里 @机器人执行任务。其他成员可私聊获取 UserID，再添加到这里。', 'The first sender becomes the owner and can DM the bot or mention it in a group. Other members can DM for their UserID and be added here.')}</p></fieldset>
        <fieldset><legend>${t('新对话使用', 'New conversation defaults')}</legend><div class="channel-fields">
        <label>${t('引擎', 'Engine')}<select name="engine">${(data.engines || [{id:'codex',label:'Codex'},{id:'claude',label:'Claude Code'}]).map(item => '<option value="'+esc(item.id)+'">'+esc(item.label)+'</option>').join('')}</select></label>
        <label>${t('项目文件夹', 'Project folder')}<select name="workspaceId"><option value="">${t('默认目录', 'Default folder')}</option>${workspaces.config.projects.map(item => '<option value="'+esc(item.id)+'">'+esc(item.name)+'</option>').join('')}</select></label></div>
        <p>${t('同一位成员在同一聊天中会继续原对话。发送 /new 开始新对话。工具授权在网页「对话」处理。', 'Messages from the same member in the same chat continue their conversation. Send /new to start over. Handle tool approvals in Conversations on the web.')}</p></fieldset>
        <footer><button type="submit" class="btn primary">${config.enabled ? t('保存设置', 'Save settings') : t('保存并连接', 'Save and connect')}</button>
        ${config.enabled ? '<button type="button" class="btn" data-disable>'+t('断开连接', 'Disconnect')+'</button>' : ''}<span data-result role="status"></span></footer>
      </form></section>`;
    bindIMChannelControls();
    const form = $('#wecom-form'), section = form.closest('section');
    form.elements.engine.value = config.engine; form.elements.workspaceId.value = config.workspaceId;
    function paint(status) {
      const phase = rt(...(phaseLabels[status.phase] || phaseLabels.error));
      section.querySelector('[data-phase]').textContent = phase;
      section.querySelector('[data-phase]').dataset.online = String(status.phase === 'connected');
      const badge = document.querySelector('[data-im-channel="wecom"] .im-channel-state');
      if (badge) badge.textContent = phase;
      section.querySelector('[data-owner]').textContent = status.ownerUserId ? 'Owner · ' + status.ownerUserId : rt('等待首位发消息的成员', 'Waiting for the first sender');
      const stages = { received: ['已收信', 'Received'], restricted: ['成员无执行权限', 'Member access restricted'],
        submitted: ['已提交任务，等待回复', 'Task submitted, awaiting reply'], replied: ['企微已确认回复', 'Reply accepted by WeCom'],
        reply_failed: ['回复投递失败', 'Reply delivery failed'] };
      const activity = status.activity;
      section.querySelector('[data-activity]').textContent = activity
        ? [new Date(activity.receivedAt).toLocaleString(), activity.chatType === 'group' ? rt('群聊', 'Group') : rt('私聊', 'DM'),
           rt(...(stages[activity.stage] || stages.received)), activity.machineId && (rt('执行机器', 'Execution machine') + ' · ' + (workspaces.machines?.find(item => item.id === activity.machineId)?.label || activity.machineId)), activity.engine, activity.errorCode].filter(Boolean).join(' · ')
        : status.lastMessageAt
        ? rt('最近收信（旧版未记录回复回执）', 'Last received (reply receipt unavailable)') + ' · ' + new Date(status.lastMessageAt).toLocaleString()
        : rt('尚未收到消息。私聊发送 /whoami 测试连接。', 'No messages yet. DM /whoami to test.');
      section.querySelector('[data-connection-error]').textContent = status.lastError || '';
      if (status.phase === 'error') form.querySelector('[type=submit]').textContent = rt('保存并重新连接', 'Save and reconnect');
    }
    paint(data);
    async function save(input) {
      const controls = form.querySelectorAll('button'), result = form.querySelector('[data-result]');
      controls.forEach(button => button.disabled = true); result.textContent = rt('正在保存…', 'Saving…');
      try { await api('PUT', 'wecom', input); if (active()) await renderIMAccess(); }
      catch (error) { if (active()) result.textContent = error.message; }
      finally { controls.forEach(button => button.disabled = false); }
    }
    form.onsubmit = event => {
      event.preventDefault();
      const input = Object.fromEntries(new FormData(form));
      input.allowedUsers = input.allowedUsers.split(/[\s,，]+/).filter(Boolean);
      save({...input, enabled:true});
    };
    const disconnect = form.querySelector('[data-disable]');
    if (disconnect) disconnect.onclick = () => save({enabled:false});
    const poll = async () => {
      if (!active() || !form.isConnected) return;
      try { const status = await api('GET', 'wecom'); if (active() && form.isConnected) paint(status); }
      catch (error) { if (active()) section.querySelector('[data-connection-error]').textContent = error.message; }
      if (active() && form.isConnected) setTimeout(poll, 3500);
    };
    setTimeout(poll, 3500);
  } catch (error) {
    if (active()) imChannelError(error.message);
  }
}
