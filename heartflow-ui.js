/* Heartflow uses the panel's authenticated API and rendering helpers. */
let heartflowView = 'pending', heartflowSelected = '', heartflowData = null, heartflowPulseTimer = null;
const hfLabels = { superseded:'已被后续决定替代', in_progress:'已在原会话发起', pending:'待确认', deferred:'暂缓', approved:'已批准', ignored:'已忽略', merged:'已合并', queued:'等待投递', dispatching:'投递中', accepted:'已接收', running:'执行中', completed:'已完成', failed:'失败', unknown:'结果待核对', blocked:'需重新确认', save:'修改', approve:'批准', ignore:'忽略', defer:'暂缓', split:'拆分', merge:'合并' };
const hfTime = n => n ? new Date(n).toLocaleString() : '—';
const hfState = s => `<span class="hf-state hf-${esc(s)}">${esc(hfLabels[s] || s)}</span>`;
function hfProgress(data) {
  const pending=Object.values(data.proposals).filter(p=>p.state==='pending').length;
  return `<div class="hf-status"><span class="hf-dot ${data.config.enabled?'on':''}"></span>${!data.config.enabled?'监听已暂停':data.runtime.polling?'正在同步消息':data.source.error?'同步异常':data.source.lastSync?'等待下次同步':'等待首次同步'} · 用户身份 · ${data.config.chats.length} 个选定聊天 · 协调节点 ${esc(data.coordinator)}<span>最近同步 ${esc(hfTime(data.source.lastSync))}</span></div>
      ${data.source.error?`<p class="hf-error" role="alert">消息读取：${esc(data.source.error)}</p>`:''}${data.source.noticeError?`<p class="hf-error">${esc(data.source.noticeError)}</p>`:''}${data.source.analysisError?`<p class="hf-error" role="alert">建议分析：${esc(data.source.analysisError)}</p>`:''}
      <div class="hf-toolbar" aria-label="心流工作状态"><span>已读取 ${Object.keys(data.messages).length} 条消息</span><span>${data.runtime.analyzing?'正在分析':data.source.lastAnalysis?'最近分析 '+esc(hfTime(data.source.lastAnalysis)):'尚未完成分析'}</span><span>待确认 ${pending}</span><span>等待投递 ${Object.values(data.deliveries).filter(d=>d.state==='queued').length}</span><span>执行中 ${Object.values(data.deliveries).filter(d=>['dispatching','accepted','running'].includes(d.state)).length}</span><span>已完成 ${Object.values(data.deliveries).filter(d=>d.state==='completed').length}</span></div>${data.source.analysisRetryAt>Date.now()?`<p class="hf-reason">分析失败后已退避，预计 ${esc(hfTime(data.source.analysisRetryAt))} 后重试。</p>`:''}`;
}
async function renderHeartflow() {
  clearInterval(heartflowPulseTimer);
  $('#empty').style.display='none';$('#metabar').style.display='none';$('#render').style.display='block';$('#render').classList.add('wide');
  const root=$('#render'); root.innerHTML='<p role="status">正在加载心流…</p>';
  try {
    const data=await api('GET','heartflow');if(state.type!=='heartflow')return;heartflowData=data;
    const pending=Object.values(data.proposals).filter(p=>p.state==='pending').length;
    root.innerHTML=`<section class="hf"><header class="hf-header"><div><div class="hf-eyebrow">AMBIENT WORKSPACE</div><h1>心流 <span>${pending} 项待 check</span></h1><p>消息聚成事项，确认后交给正确的会话。</p></div><button class="btn" id="hf-refresh">刷新</button></header>
      <div id="hf-live-status">${hfProgress(data)}</div><p id="hf-live-update" role="status"></p><nav class="hf-tabs">${[['pending','待确认'],['messages','消息'],['matters','事项'],['activity','执行动态'],['learning','Check 与学习'],['settings','接入设置']].map(([id,title])=>`<button class="btn ${heartflowView===id?'active':''}" data-hf-tab="${id}">${title}</button>`).join('')}</nav><div id="hf-notice" role="status"></div><div id="hf-content"></div></section>`;
    root.querySelector('#hf-refresh').onclick=()=>renderHeartflow();
    root.querySelectorAll('[data-hf-tab]').forEach(b=>b.onclick=()=>{heartflowView=b.dataset.hfTab;renderHeartflow();});
    if(heartflowView==='pending')hfPending(data);
    else if(heartflowView==='messages')hfMessages(data);
    else if(heartflowView==='matters')hfMatters(data);
    else if(heartflowView==='activity')hfActivity(data);
    else if(heartflowView==='learning')hfLearning(data);
    else hfSettings(data);
    let checking=false;
    heartflowPulseTimer=setInterval(async()=>{
      if(state.type!=='heartflow'){clearInterval(heartflowPulseTimer);return;}
      if(checking || document.hidden)return;checking=true;
      try{
        const latest=await api('GET','heartflow');
        if(state.type!=='heartflow' || !$('#hf-live-status'))return;
        $('#hf-live-status').innerHTML=hfProgress(latest);
        const changed=Object.values(latest.proposals).some(p=>p.version!==data.proposals[p.id]?.version);
        $('#hf-live-update').textContent=changed?'有新建议或来源更新，请点刷新查看。当前编辑内容已保留。':'状态已更新 · '+hfTime(Date.now());
      }catch(error){if(state.type==='heartflow' && $('#hf-live-update'))$('#hf-live-update').textContent='状态刷新失败：'+error.message;}
      finally{checking=false;}
    },10000);
  }catch(e){if(state.type==='heartflow')root.innerHTML=`<p role="alert">心流加载失败：${esc(e.message)}</p>`;}
}
async function hfDo(button,fn) {
  if(button)button.disabled=true;
  const notice=$('#hf-notice'); if(notice)notice.textContent='正在处理…';
  try {await fn();if(state.type==='heartflow')await renderHeartflow();}
  catch(e){const n=$('#hf-notice');if(n){n.textContent=e.message;n.className='hf-error';}if(button)button.disabled=false;}
}
function hfMessage(m, selectable=false) {
  if(!m)return '';
  return `<article class="hf-source">${selectable?`<input type="checkbox" data-hf-msg="${esc(m.id)}" aria-label="选择来源消息">`:''}<strong>${esc(m.chatName)}</strong><small>${esc(m.senderName)} · ${esc(hfTime(m.createdAt))}</small><p>${esc(m.text)}</p>${m.deleted?'<b>消息已撤回</b>':''}<small>${esc(m.id)}${m.parentId?' · 回复 '+esc(m.parentId):''}</small></article>`;
}
function hfPending(data) {
  const ps=Object.values(data.proposals).filter(p=>['pending','deferred'].includes(p.state)).sort((a,b)=>b.updatedAt-a.updatedAt);
  if(!ps.some(p=>p.id===heartflowSelected))heartflowSelected=ps[0]?.id || '';
  $('#hf-content').innerHTML=`<div class="hf-toolbar"><button class="btn" id="hf-analyze">生成新建议</button><button class="btn" id="hf-merge">合并选中建议</button><span>整理后重新 check；只执行选中的行动。</span></div><div class="hf-grid"><div class="hf-list">${ps.map(p=>`<div class="hf-list-item ${p.id===heartflowSelected?'selected':''}"><input type="checkbox" data-hf-proposal="${p.id}" aria-label="选择建议 ${esc(p.title)}"><button data-hf-select="${p.id}"><strong>${esc(p.title)}</strong><small>${p.messageIds.length} 条消息 · ${p.actions.length} 项行动</small>${hfState(p.state)}</button></div>`).join('')||'<div class="hf-empty">暂无待确认建议。到接入设置选择聊天，然后同步并分析。</div>'}</div><div id="hf-detail"></div></div>`;
  $('#hf-analyze').onclick=e=>hfDo(e.target,()=>api('POST','heartflow/analyze',{}));
  $('#hf-merge').onclick=e=>hfDo(e.target,()=>{const ids=[...document.querySelectorAll('[data-hf-proposal]:checked')].map(x=>x.dataset.hfProposal);if(ids.length<2)throw new Error('请至少选择两项建议');return api('POST','heartflow/organize',{proposals:ids.map(id=>({id,version:data.proposals[id].version}))});});
  document.querySelectorAll('[data-hf-select]').forEach(b=>b.onclick=()=>{heartflowSelected=b.dataset.hfSelect;hfPending(data);});
  const p=data.proposals[heartflowSelected];if(p)hfDetail(p,data);
}
function hfDetail(p,data) {
  const actions=JSON.parse(JSON.stringify(p.actions));
  $('#hf-detail').innerHTML=`<div class="hf-card"><div class="hf-toolbar">${hfState(p.state)}<span>版本 ${p.version} · ${p.model?'模型 '+esc(p.model):'人工整理'}</span></div>${p.sourceChanged?'<p class="hf-error">来源有更新，请重新核对摘要与执行范围。</p>':''}
    <label>事项建议<input id="hf-title" value="${esc(p.title)}" maxlength="160"></label><label>汇总<textarea id="hf-summary" rows="3">${esc(p.summary)}</textarea></label><p class="hf-reason">推荐依据：${esc(p.reason||'人工整理')}</p>
    <label>关联事项（可多选）<select id="hf-matters" multiple size="3">${Object.values(data.matters).map(m=>`<option value="${m.id}" ${p.matterIds.includes(m.id)?'selected':''}>${esc(m.title)}</option>`).join('')}</select></label><button class="btn" id="hf-create-matter">以此标题创建事项并关联</button>
    <h3>行动与目标会话</h3><div id="hf-actions"></div><button class="btn" id="hf-add-action">＋ 增加行动</button>
    <label>Check 说明 / 忽略原因<input id="hf-feedback" placeholder="例如：应归到个人 Tag，会话不要新建"></label>
    <div class="hf-toolbar"><button class="btn primary" id="hf-approve">确认选中行动并执行</button><button class="btn" id="hf-save">保存修改</button><button class="btn" id="hf-defer">暂缓</button><button class="btn" id="hf-ignore">忽略</button></div>
    <details open><summary>来源消息 · 可选择部分消息拆分</summary>${p.messageIds.map(id=>hfMessage(data.messages[id],true)).join('')}<button class="btn" id="hf-split">拆出选中消息</button></details></div>`;
  const readActions=()=>{document.querySelectorAll('[data-hf-action]').forEach(el=>{const a=actions.find(a=>a.id===el.dataset.hfAction);a.prompt=el.querySelector('textarea').value;a.cwd=el.querySelector('[data-cwd]').value;a.machineId=el.querySelector('[data-machine]').value;a.engine=el.querySelector('[data-engine]').value;});};
  const drawActions=()=>{
    $('#hf-actions').innerHTML=actions.map(a=>`<div class="hf-action" data-hf-action="${a.id}"><div class="hf-toolbar"><label><input type="checkbox" data-approve-action="${a.id}" checked> 批准此行动</label><button class="btn" data-remove="${a.id}">移除</button></div><div class="hf-target">${a.sessionId?'续接会话：'+esc(a.sessionTitle||a.sessionId):'新建任务'}</div><div class="hf-toolbar"><input data-query placeholder="搜索会话名称、项目或分支"><button class="btn" data-search>选择已有会话</button><button class="btn" data-new>改为新任务</button></div><div data-results></div><div class="hf-fields"><label>引擎<select data-engine ${a.sessionId?'disabled':''}><option value="codex" ${a.engine==='codex'?'selected':''}>Codex</option><option value="claude" ${a.engine==='claude'?'selected':''}>Claude</option></select></label><label>机器<input data-machine ${a.sessionId?'readonly':''} value="${esc(a.machineId)}" placeholder="节点 ID"></label><label>目录<input data-cwd ${a.sessionId?'readonly':''} value="${esc(a.cwd)}" placeholder="执行项目的绝对目录"></label></div><label>批准的执行内容<textarea rows="4">${esc(a.prompt)}</textarea></label></div>`).join('')||'<p class="hf-empty">暂未确定行动。可以先保存资料，或增加行动并选择会话。</p>';
    document.querySelectorAll('[data-hf-action]').forEach(el=>{
      const a=actions.find(x=>x.id===el.dataset.hfAction);
      el.querySelector('[data-remove]').onclick=()=>{readActions();actions.splice(actions.indexOf(a),1);drawActions();};
      el.querySelector('[data-new]').onclick=()=>{readActions();a.sessionId='';drawActions();};
      el.querySelector('[data-search]').onclick=async e=>{
        const b=e.target;b.disabled=true;const target=el.querySelector('[data-results]');target.textContent='正在搜索…';
        try{const d=await api('GET','heartflow/sessions?q='+encodeURIComponent(el.querySelector('[data-query]').value));target.innerHTML=(d.sessions||[]).slice(0,30).map((s,i)=>`<button class="hf-session" data-index="${i}"><strong>${esc(s.title||s.id)}</strong><small>${esc(s.engine)} · ${esc(s.machineId)} · ${esc(s.project)} ${s.running?'· 运行中，追加排队':''}</small></button>`).join('')||'没有匹配会话';target.querySelectorAll('[data-index]').forEach(btn=>btn.onclick=()=>{readActions();const s=d.sessions[Number(btn.dataset.index)];Object.assign(a,{sessionId:s.id,sessionTitle:s.title,engine:s.engine,machineId:s.machineId,cwd:s.project});drawActions();});}catch(e){target.textContent=e.message;}finally{b.disabled=false;}
      };
    });
  };
  drawActions();
  $('#hf-add-action').onclick=()=>{readActions();actions.push({id:crypto.randomUUID(),sessionId:'',engine:'codex',machineId:data.coordinator,cwd:'',prompt:''});drawActions();};
  const draft=()=>{readActions();return {title:$('#hf-title').value,summary:$('#hf-summary').value,reason:p.reason,messageIds:p.messageIds,matterIds:[...$('#hf-matters').selectedOptions].map(x=>x.value),actions};};
  for(const decision of ['approve','save','defer','ignore'])$('#hf-'+decision).onclick=e=>hfDo(e.target,()=>api('POST','heartflow/review/'+p.id,{version:p.version,decision,draft:draft(),reason:$('#hf-feedback').value,actionIds:[...document.querySelectorAll('[data-approve-action]:checked')].map(x=>x.dataset.approveAction)}));
  $('#hf-create-matter').onclick=e=>hfDo(e.target,async()=>{const input=draft();const m=await api('POST','heartflow/matters',{title:input.title,description:input.summary});input.matterIds.push(m.id);await api('POST','heartflow/review/'+p.id,{version:p.version,decision:'save',draft:input,reason:'创建并关联事项'});});
  $('#hf-split').onclick=e=>hfDo(e.target,()=>api('POST','heartflow/organize',{proposals:[{id:p.id,version:p.version}],splitIds:[...document.querySelectorAll('[data-hf-msg]:checked')].map(x=>x.dataset.hfMsg)}));
}
function hfMessages(data) {
  const rows=Object.values(data.messages).sort((a,b)=>b.createdAt-a.createdAt).slice(0,200);
  $('#hf-content').innerHTML=`<div class="hf-toolbar"><button class="btn" id="hf-sync">同步消息</button><button class="btn" id="hf-manual">从选中消息建立建议</button><span>最近 200 条；原始消息只作为资料，未经确认不会执行。</span></div>${rows.map(m=>hfMessage(m,true)).join('')||'<p class="hf-empty">还没有消息，请先选择聊天并同步。</p>'}`;
  $('#hf-sync').onclick=e=>hfDo(e.target,()=>api('POST','heartflow/sync',{}));
  $('#hf-manual').onclick=e=>hfDo(e.target,async()=>{const messageIds=[...document.querySelectorAll('[data-hf-msg]:checked')].map(x=>x.dataset.hfMsg);if(!messageIds.length)throw new Error('请选择消息');const p=await api('POST','heartflow/drafts',{title:data.messages[messageIds[0]].chatName+' · 待办',summary:messageIds.map(id=>data.messages[id].text).join('\n').slice(0,12000),messageIds,matterIds:[],actions:[]});heartflowSelected=p.id;heartflowView='pending';});
}
function hfMatters(data) {
  $('#hf-content').innerHTML=`<div class="hf-toolbar"><input id="hf-matter-title" placeholder="新事项名称"><button class="btn" id="hf-matter-add">建立事项</button></div>${Object.values(data.matters).map(m=>{const ps=Object.values(data.proposals).filter(p=>p.matterIds.includes(m.id));const ds=Object.values(data.deliveries).filter(d=>ps.some(p=>p.id===d.proposalId));return `<article class="hf-card"><h3>${esc(m.title)}</h3><p>${esc(m.description)}</p><p>${new Set(ps.flatMap(p=>p.messageIds)).size} 条来源消息 · ${ps.length} 项建议 · ${new Set(ds.map(d=>d.sessionId||d.action.sessionId).filter(Boolean)).size} 个执行会话</p>${ps.map(p=>`<p>${hfState(p.state)} ${esc(p.title)}</p>`).join('')}${ds.map(d=>`<p>${hfState(d.state)} ${esc(d.action.prompt.slice(0,150))}</p>`).join('')}</article>`;}).join('')||'<p class="hf-empty">可在建议详情创建事项；同一建议允许关联多个事项。</p>'}`;
  $('#hf-matter-add').onclick=e=>hfDo(e.target,()=>api('POST','heartflow/matters',{title:$('#hf-matter-title').value}));
}
function hfActivity(data) {
  $('#hf-content').innerHTML=`<div class="hf-toolbar"><button class="btn" id="hf-reconcile">核对执行状态</button><span>结果不明的行动不会自动重发。</span></div>${Object.values(data.deliveries).reverse().map(d=>`<article class="hf-card">${hfState(d.state)} <small>${esc(hfTime(d.updatedAt))}</small><h3>${esc(data.proposals[d.proposalId]?.title||'行动')}</h3><p>${esc(d.action.prompt)}</p><small>${esc(d.action.machineId)} · ${esc(d.action.cwd)} · 建议版本 ${d.version}</small>${d.error?`<p class="hf-error">${esc(d.error)}</p>`:''}${d.sessionId||d.action.sessionId?`<p><a href="/sessions/${encodeURIComponent(d.sessionId||d.action.sessionId)}">查看执行会话</a></p>`:''}</article>`).join('')||'<p class="hf-empty">还没有批准的行动。</p>'}`;
  $('#hf-content').insertAdjacentHTML('beforeend',Object.values(data.proposals).filter(p=>p.resolutions?.length).map(p=>`<article class="hf-card">${hfState(p.state)}<h3>${esc(p.title)}</h3>${p.resolutions.map(r=>`<p>${esc(r.reason)}</p><a href="/sessions/${encodeURIComponent(r.sessionId)}">查看原会话</a><pre>${esc(r.evidence.map(e=>e.quote).join('\n'))}</pre>`).join('')}</article>`).join(''));
  $('#hf-reconcile').onclick=e=>hfDo(e.target,()=>api('POST','heartflow/reconcile',{}));
}
function hfLearning(data) {
  $('#hf-content').innerHTML=`<div class="hf-card"><h3>从你的 check 学习</h3><p>同一聊天的历史纠正会作为后续模型推荐的参考。关闭参考不会删除审计记录。批准次数不会自动扩大执行权限。</p></div>${data.checks.slice().reverse().map(c=>`<article class="hf-card"><div class="hf-toolbar"><strong>${esc(hfLabels[c.decision]||c.decision)}</strong><small>${esc(hfTime(c.at))}</small><label><input type="checkbox" data-learning="${c.id}" ${c.learning?'checked':''}> 用于后续推荐</label></div><p>${esc(c.reason||'未填写原因')}</p><details><summary>查看 check 前后内容</summary><div class="hf-diff"><div><h4>推荐 / 修改前</h4><pre>${esc(JSON.stringify(c.before,null,2))}</pre></div><div><h4>你的选择 / 修改后</h4><pre>${esc(JSON.stringify(c.after,null,2))}</pre></div></div></details></article>`).join('')||'<p class="hf-empty">首次确认、修改、改派、拆分或忽略后，记录会出现在这里。</p>'}`;
  document.querySelectorAll('[data-learning]').forEach(el=>el.onchange=()=>hfDo(el,()=>api('POST','heartflow/learning/'+el.dataset.learning,{enabled:el.checked})));
}
function hfSettings(data) {
  const chats=JSON.parse(JSON.stringify(data.config.chats));
  $('#hf-content').innerHTML=`<div class="hf-card"><h3>飞书个人消息</h3><p>使用当前协调节点的 bytedcli 用户授权读取选定聊天，包含授权范围内的群聊和私聊。机器人消息权限不能代替个人授权。</p><button class="btn" id="hf-identity">检查用户授权</button><div id="hf-identity-result"></div><div class="hf-toolbar"><input id="hf-chat-query" placeholder="搜索群聊名称"><button class="btn" id="hf-chat-search">搜索聊天</button></div><div id="hf-chat-results"></div><div class="hf-toolbar"><input id="hf-chat-id" placeholder="或输入私聊 / 群聊 chat_id（oc_…）"><button class="btn" id="hf-chat-add">加入监听范围</button></div><div id="hf-chat-chosen"></div>
    <label><input id="hf-enabled" type="checkbox" ${data.config.enabled?'checked':''}> 自动同步选定聊天</label><label><input id="hf-model-enabled" type="checkbox" ${data.config.modelEnabled?'checked':''}> 同步后调用模型生成建议（不自动执行）</label><div class="hf-fields"><label>同步间隔（秒）<input id="hf-interval" type="number" min="30" max="3600" value="${data.config.intervalSeconds}"></label><label>分析模型<input id="hf-model" value="${esc(data.config.model)}" placeholder="使用账号池默认 Codex 模型"></label></div><label>首次读取起点<input id="hf-since" type="datetime-local" value="${new Date(data.config.since-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16)}"></label><h3>飞书确认卡片</h3><label><input id="hf-notify" type="checkbox" ${data.config.notifyEnabled?'checked':''}> 向已配对的机器人私聊发送建议卡片</label><label>机器人配对用户 ID<input id="hf-notify-user" value="${esc(data.config.notifyUserId||'')}" placeholder="IM 接入中的 ou_…，可能与个人消息授权的 ID 不同"></label><label>你可访问的面板地址<input id="hf-panel-url" value="${esc(data.config.panelUrl||'')}" placeholder="用于卡片打开详情，不填写令牌"></label><button class="btn primary" id="hf-settings-save">保存设置</button><p class="hf-reason">消息、check 和投递记录保存在节点 ${esc(data.coordinator)}。该节点离线时暂停调度；其他节点不会接管未确认的行动。</p></div>`;
  const draw=()=>{$('#hf-chat-chosen').innerHTML=chats.map(c=>`<div class="hf-toolbar"><span>${esc(c.name)} <small>${esc(c.id)}</small></span><button class="btn" data-chat-remove="${esc(c.id)}">移除</button></div>`).join('')||'<p>尚未选择聊天。</p>';document.querySelectorAll('[data-chat-remove]').forEach(b=>b.onclick=()=>{chats.splice(chats.findIndex(c=>c.id===b.dataset.chatRemove),1);draw();});};draw();
  $('#hf-chat-add').onclick=()=>{const id=$('#hf-chat-id').value.trim();if(!/^oc_[\w-]+$/.test(id)){$('#hf-notice').textContent='请输入有效 chat_id';return;}if(!chats.some(c=>c.id===id))chats.push({id,name:id});draw();};
  $('#hf-identity').onclick=async e=>{e.target.disabled=true;try{const who=await api('GET','heartflow/identity');$('#hf-identity-result').textContent='当前用户：'+(who.user?.name||'未知');}catch(e){$('#hf-identity-result').textContent=e.message;}finally{e.target.disabled=false;}};
  $('#hf-chat-search').onclick=async e=>{e.target.disabled=true;const el=$('#hf-chat-results');try{const r=await api('GET','heartflow/chats?q='+encodeURIComponent($('#hf-chat-query').value));const rows=r.items||r.chats||r.data?.items||[];el.innerHTML=rows.map((c,i)=>`<button class="hf-session" data-chat-index="${i}">${esc(c.name||c.chat_name||c.chat_id)}</button>`).join('')||'没有搜索结果';el.querySelectorAll('[data-chat-index]').forEach(b=>b.onclick=()=>{const c=rows[+b.dataset.chatIndex],id=c.chat_id||c.id;if(id&&!chats.some(c=>c.id===id))chats.push({id,name:c.name||c.chat_name||id});draw();});}catch(e){el.textContent=e.message;}finally{e.target.disabled=false;}};
  $('#hf-settings-save').onclick=e=>hfDo(e.target,()=>api('POST','heartflow/config',{notifyEnabled:$('#hf-notify').checked,notifyUserId:$('#hf-notify-user').value,panelUrl:$('#hf-panel-url').value,enabled:$('#hf-enabled').checked,modelEnabled:$('#hf-model-enabled').checked,model:$('#hf-model').value,intervalSeconds:Number($('#hf-interval').value),chats,...(Math.abs(new Date($('#hf-since').value).getTime()-data.config.since)>60000?{since:new Date($('#hf-since').value).getTime()}: {})}));
}
