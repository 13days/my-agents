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
    const machines = workspaces.machines || [], projects = workspaces.config.projects || [];
    const machineName = id => machines.find(machine => machine.id === id)?.label || id;
    const defaultMachine = data.defaultMachine || workspaces.config.defaultMachine || workspaces.selfId;
    const supportsRouting = typeof config.worktree === 'boolean';
    const commands = [
      ['/sessions', '查找最近的会话，可在命令后加关键词', 'Find recent sessions, optionally by keyword'],
      ['/use 1', '接续刚才列表中的第一个会话', 'Resume the first session in the list'],
      ['/status', '查看当前会话和任务进度', 'Check the current task'],
      ['/new', '另开会话，可在命令后加上任务', 'Start a session, optionally with a task'],
      ['/whoami', '查看自己的 UserID 和身份', 'Check your UserID and role'],
    ];
    $('#render').innerHTML = imHeader(data) + `<header class="channel-status chart"><h2>${t('企业微信智能机器人', 'WeCom intelligent bot')}</h2><span role="status" data-phase></span>
      ${data.receiver ? '<small>'+t('接收消息的电脑', 'Message receiver')+' · '+esc(machineName(data.receiver))+'</small>' : ''}<span data-connection-error role="status"></span></header>
      <div class="gateway-columns"><section class="channel-setup"><form id="wecom-form" class="channel-form">
        <fieldset><legend>${t('连接机器人', 'Connect your bot')}</legend>
        <p>${t('在企业微信创建智能机器人，选择 API 模式 → 长连接，填入 Bot ID 和 Secret。', 'Create an intelligent bot in WeCom, select API mode → Long connection and enter the credentials.')}</p>
        <div class="channel-fields"><label>Bot ID<input name="botId" required maxlength="256" autocomplete="off" spellcheck="false" value="${esc(config.botId)}"></label>
        <label>Secret<input name="secret" type="password" maxlength="2048" autocomplete="new-password" placeholder="${config.hasSecret ? t('已保存，留空沿用', 'Saved · leave blank to keep') : ''}" ${config.hasSecret ? '' : 'required'}></label></div></fieldset>
        <fieldset><legend>${t('新对话在哪里执行', 'Where new conversations run')}</legend>
        ${supportsRouting ? `<div class="channel-fields"><label>${t('默认执行机器', 'Execution machine')}<select name="machineId"></select></label>
        <label>${t('项目文件夹', 'Project folder')}<select name="workspaceId"></select></label></div>
        <div class="wecom-directory"><span data-folder-path></span><button type="button" class="btn" data-folder>${t('选择文件夹', 'Choose folder')}</button></div>` : '<p role="status">'+t('接收消息的电脑更新后，可在此设置机器、目录、模型和独立工作区。', 'Update the message receiver to configure machines, folders, models and worktrees.')+'</p>'}
        <div class="channel-fields"><label>${t('引擎', 'Engine')}<select name="engine">${(data.engines || ENGINES).map(item => '<option value="'+esc(item.id)+'">'+esc(item.label)+'</option>').join('')}</select></label>
        ${supportsRouting ? `<label>${t('模型', 'Model')}<select name="model"></select></label>` : `<label>${t('项目文件夹', 'Project folder')}<select name="workspaceId"><option value="">${t('默认目录', 'Default folder')}</option>${projects.map(item => '<option value="'+esc(item.id)+'">'+esc(item.name)+'</option>').join('')}</select></label>`}</div>
        ${supportsRouting ? `<small data-model-note role="status"></small><label class="wecom-check"><input name="worktree" type="checkbox" ${config.worktree ? 'checked' : ''}>${t('新对话使用独立 Git 工作区', 'Use an isolated Git worktree for new conversations')}</label>` : ''}
        <p>${t('已有会话沿用原来的执行设置。独立工作区从当前 Git 提交创建，普通文件夹直接使用原目录。', 'Existing conversations keep their settings. Worktrees start at the current Git commit. Plain folders are used directly.')}</p></fieldset>
        <fieldset><legend>${t('谁可以运行任务', 'Who can run tasks')}</legend>
        <p data-owner></p><label>${t('其他成员的 UserID', 'Additional member UserIDs')}<textarea rows="2" name="allowedUsers" spellcheck="false" placeholder="${t('每行一个 UserID', 'One UserID per line')}">${esc(config.allowedUsers.join('\n'))}</textarea></label>
        <p>${t('首位发消息的人自动成为 Owner。其他成员可先私聊发送 /whoami，再把 UserID 添加到这里。', 'The first sender becomes the owner. Other members can DM /whoami to get their UserID.')}</p>
        <label class="wecom-check"><input name="ownerSessionCatalog" type="checkbox" ${config.ownerSessionCatalog ? 'checked' : ''} ${data.ownerUserId ? '' : 'disabled'}>${t('允许已配对的 Owner 在私聊中查找并接手面板和终端会话', 'Let the paired owner find and resume panel and terminal sessions in a DM')}</label></fieldset>
        <footer><button type="submit" class="btn primary">${config.enabled ? t('保存设置', 'Save settings') : t('保存并连接', 'Save and connect')}</button>
        ${config.enabled ? '<button type="button" class="btn" data-disable>'+t('断开连接', 'Disconnect')+'</button>' : ''}<span data-result role="status"></span></footer>
      </form></section><aside class="gateway-side wecom-side"><section class="chart"><h3>${t('在企微里使用', 'Use it in WeCom')}</h3>
        <p>${t('私聊直接发任务，群里 @机器人。发文字、语音或引用消息都可以继续对话。工具授权在网页「对话」处理。', 'Send a task in a DM or mention the bot in a group. Text, voice and quoted messages continue the conversation. Review tool approvals in Conversations.')}</p>
        <div class="gateway-command-list">${commands.map(([cmd,zh,en]) => '<code>'+cmd+'</code><span>'+t(zh,en)+'</span>').join('')}</div></section>
        <section class="chart"><h3>${t('最近收信与回复', 'Recent deliveries')}</h3><div data-activity></div></section>
        ${supportsRouting ? `<section class="chart" data-runtime><h3>${t('运行与启动', 'Runtime and startup')}</h3><p role="status">${t('正在读取运行设置…', 'Loading runtime settings…')}</p></section>` : ''}
      </aside></div>`;
    bindIMChannelControls();
    const form = $('#wecom-form'), section = $('#render');
    const valid = () => active() && form.isConnected;
    form.elements.engine.value = config.engine;
    let cwd = config.cwd || '';
    if (supportsRouting) {
      const e = form.elements, effective = () => e.machineId.value || defaultMachine;
      const machine = () => machines.find(item => item.id === effective());
      const machineSelect = e.machineId;
      machineSelect.add(new Option(rt('跟随新任务默认机器', 'Use default machine')+' · '+machineName(defaultMachine), ''));
      machines.forEach(item => machineSelect.add(new Option((item.label || item.id) + (item.online === false ? rt(' · 离线',' · Offline') : ''), item.id)));
      if (config.machineId && !machines.some(item => item.id === config.machineId)) machineSelect.add(new Option(config.machineId + rt(' · 未连接',' · Disconnected'), config.machineId));
      machineSelect.value = config.machineId;
      const folder = form.querySelector('[data-folder]'), pathText = form.querySelector('[data-folder-path]');
      const paintProject = () => {
        const selected = projects.find(item => item.id === e.workspaceId.value);
        pathText.textContent = cwd || selected?.paths[effective()] || (selected ? rt('此机器缺少项目目录映射', 'Project path missing on this machine') : machine()?.defaultDirectory || rt('机器默认目录', 'Machine default folder'));
        folder.disabled = !machine() || machine().online === false;
      };
      function listProjects(value) {
        const select = e.workspaceId;
        select.replaceChildren(new Option(rt('机器默认目录', 'Machine default folder'), ''));
        projects.filter(item => item.paths[effective()] || item.id === value).forEach(item => select.add(new Option(item.name, item.id)));
        if (cwd) select.add(new Option(rt('自选目录', 'Custom folder'), '__custom__'));
        select.value = cwd ? '__custom__' : value || '';
        paintProject();
      }
      listProjects(config.workspaceId);
      e.workspaceId.onchange = () => { if (e.workspaceId.value !== '__custom__') cwd = ''; listProjects(e.workspaceId.value); };
      folder.onclick = async () => {
        const host = machine(); if (!host) return;
        const path = await chooseMachineDirectory(host, {initial: cwd || projects.find(item => item.id === e.workspaceId.value)?.paths[host.id] || host.defaultDirectory});
        if (!valid() || effective() !== host.id || !path) return;
        machineSelect.value = host.id; cwd = path; listProjects('');
      };
      let revision = 0;
      async function loadModels(saved = '') {
        const current = ++revision, select = e.model, note = form.querySelector('[data-model-note]');
        select.replaceChildren(new Option(rt('跟随引擎默认模型', 'Use engine default'), ''));
        if (saved) { select.add(new Option(saved, saved)); select.value = saved; }
        note.textContent = rt('正在读取可用模型…', 'Loading available models…');
        try {
          const result = await api('GET', 'wecom/models?'+new URLSearchParams({engine:e.engine.value,machineId:effective()}));
          if (!valid() || current !== revision) return;
          for (const item of result.models) if (item.id !== saved) select.add(new Option(item.name && item.name !== item.id ? item.name+' · '+item.id : item.id, item.id));
          note.textContent = saved && !result.models.some(item => item.id === saved) ? rt('已保存的模型当前不可用，请重新选择。', 'The saved model is currently unavailable. Choose another.') : '';
        } catch (error) { if (valid() && current === revision) note.textContent = error.message; }
      }
      e.engine.onchange = () => loadModels();
      machineSelect.onchange = () => {
        const current = e.workspaceId.value;
        cwd = ''; listProjects(projects.find(p => p.id === current)?.paths[effective()] ? current : '');
        loadModels();
      };
      loadModels(config.model);
      bindWecomRuntime(section.querySelector('[data-runtime]'), machineName, valid);
    } else form.elements.workspaceId.value = config.workspaceId;
    function updateCatalogOption(ownerId) {
      const option = form.elements.ownerSessionCatalog;
      option.disabled = !ownerId || form.elements.botId.value.trim() !== config.botId;
      if (option.disabled) option.checked = false;
    }
    let ownerId = data.ownerUserId;
    form.elements.botId.oninput = () => updateCatalogOption(ownerId);
    function paint(status) {
      ownerId = status.ownerUserId;
      updateCatalogOption(ownerId);
      const phase = rt(...(phaseLabels[status.phase] || phaseLabels.error));
      section.querySelector('[data-phase]').textContent = phase;
      section.querySelector('[data-phase]').dataset.online = String(status.phase === 'connected');
      const badge = document.querySelector('[data-im-channel="wecom"] .im-channel-state');
      if (badge) badge.textContent = phase;
      section.querySelector('[data-owner]').textContent = status.ownerUserId ? 'Owner · ' + status.ownerUserId : rt('等待首位发消息的成员', 'Waiting for the first sender');
      const stages = { received: ['已收信', 'Received'], restricted: ['成员无执行权限', 'Member access restricted'],
        submitted: ['已提交任务，等待回复', 'Task submitted, awaiting reply'], replied: ['企微已确认回复', 'Reply accepted by WeCom'],
        reply_failed: ['回复投递失败', 'Reply delivery failed'] };
      const log = section.querySelector('[data-activity]');
      const receipts = status.receipts || (status.activity ? [status.activity] : []);
      if (receipts.length) {
        log.innerHTML = '<ul class="wecom-receipts">'+receipts.map(row => '<li><strong>'+esc([row.sender, row.chatType === 'group' ? rt('群聊', 'Group') : rt('私聊', 'DM')].filter(Boolean).join(' · '))+'</strong><time>'+esc(new Date(row.receivedAt).toLocaleString())+'</time><small>'+esc([rt(...(stages[row.stage] || stages.received)), row.machineId && machineName(row.machineId), row.engine, row.errorCode].filter(Boolean).join(' · '))+'</small></li>').join('')+'</ul>';
      } else log.textContent = status.lastMessageAt ? rt('最近收信', 'Last received')+' · '+new Date(status.lastMessageAt).toLocaleString() : rt('尚未收到消息。私聊发送 /whoami 测试连接。', 'No messages yet. DM /whoami to test the connection.');
      section.querySelector('[data-connection-error]').textContent = status.lastError || '';
      if (status.phase === 'error') form.querySelector('[type=submit]').textContent = rt('保存并重新连接', 'Save and reconnect');
    }
    paint(data);
    async function save(input) {
      const controls = form.querySelectorAll('footer button'), result = form.querySelector('[data-result]');
      controls.forEach(button => button.disabled = true); result.textContent = rt('正在保存…', 'Saving…');
      try { await api('PUT', 'wecom', input); if (active()) await renderIMAccess(); }
      catch (error) { if (active()) result.textContent = error.message; }
      finally { controls.forEach(button => button.disabled = false); }
    }
    form.onsubmit = event => {
      event.preventDefault();
      const input = Object.fromEntries(new FormData(form));
      if (supportsRouting) {
        input.cwd = cwd;
        if (input.workspaceId === '__custom__') input.workspaceId = '';
        input.worktree = form.elements.worktree.checked;
      }
      input.ownerSessionCatalog = form.elements.ownerSessionCatalog.checked;
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

async function bindWecomRuntime(section, machineName, valid) {
  const message = section.querySelector('[role=status]');
  const label = (text, key, checked) => '<label class="wecom-check"><input type="checkbox" name="'+key+'" '+(checked ? 'checked' : '')+'>'+esc(text)+'</label>';
  try {
    let current = await api('GET', 'im-runtime');
    if (!valid()) return;
    const form = document.createElement('form');
    form.className = 'channel-form';
    const shared = ' · '+machineName(current.receiver);
    form.innerHTML = label(rt('Claude Code 原终端自动接收', 'Accept messages in Claude Code terminals') + shared, 'nativeAutoAccept', current.nativeAutoAccept)
      + '<p>'+esc(rt('这是接收消息电脑上的用户级设置，也会影响该用户的其他 Claude Code 终端。', 'This user-level setting also applies to other Claude Code terminals on the receiver.'))+'</p>'
      + (current.keepAwakeSupported ? label(rt('防止 Mac 闲置睡眠', 'Prevent idle Mac sleep') + shared, 'keepAwake', current.keepAwake) : '')
      + (current.autoStartSupported ? label(rt('登录后自动启动面板', 'Start the panel at login')+' · '+machineName(current.local), 'autoStart', current.autoStart) : '')
      + '<button class="btn" type="submit" disabled>'+esc(rt('保存运行设置', 'Save runtime settings'))+'</button>';
    section.insertBefore(form, message);
    message.textContent = current.nativeError || '';
    const save = form.querySelector('button');
    const changes = () => Object.fromEntries([...form.querySelectorAll('input')].filter(input => input.checked !== current[input.name]).map(input => [input.name, input.checked]));
    form.onchange = () => { save.disabled = !Object.keys(changes()).length; };
    form.onsubmit = async event => {
      event.preventDefault(); save.disabled = true;
      try {
        current = await api('PUT', 'im-runtime', changes());
        if (valid()) message.textContent = current.nativeError || rt('运行设置已保存', 'Runtime settings saved');
      } catch (error) { if (valid()) message.textContent = error.message; }
      finally { if (valid()) form.onchange(); }
    };
  } catch (error) { if (valid()) message.textContent = error.message; }
}
