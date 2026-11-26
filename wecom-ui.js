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
        <label>${t('允许的成员 UserID', 'Allowed member UserIDs')}<textarea rows="2" name="allowedUsers" spellcheck="false" placeholder="${t('每行一个 UserID', 'One UserID per line')}">${esc(config.allowedUsers.join('\n'))}</textarea></label>
        <p>${t('先连接，再让成员私聊机器人获取自己的 UserID。添加并保存后，该成员就能私聊或在群里 @机器人执行文字任务。名单为空时无人能运行任务。', 'Connect first. Each member can message the bot privately to get their UserID. Once saved here, they can send tasks privately or mention the bot in a group. An empty list allows nobody to run tasks.')}</p></fieldset>
        <fieldset><legend>${t('新对话使用', 'New conversation defaults')}</legend><div class="channel-fields">
        <label>${t('引擎', 'Engine')}<select name="engine"><option value="codex">Codex</option><option value="claude">Claude Code</option></select></label>
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
      section.querySelector('[data-activity]').textContent = status.lastMessageAt
        ? rt('最近收信', 'Last received') + ' · ' + new Date(status.lastMessageAt).toLocaleString()
        : rt('尚无获授权成员的消息', 'No messages from authorized members yet');
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
