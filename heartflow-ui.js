/* Heartflow uses the panel's authenticated API and rendering helpers. */
let heartflowView = 'home', heartflowSelected = '', heartflowData = null, heartflowPulseTimer = null, heartflowRenderVersion = 0;
const hfLabels = { superseded:'已被后续决定替代', in_progress:'已在原会话发起', feedback:'纠正判断', pending:'待确认', deferred:'暂缓', approved:'已批准', ignored:'已忽略', merged:'已合并', queued:'等待投递', dispatching:'投递中', accepted:'已接收', running:'执行中', completed:'已完成', failed:'失败', unknown:'结果待核对', blocked:'需重新确认', complete:'标记完成', save:'修改', approve:'批准', ignore:'忽略', defer:'暂缓', split:'拆分', merge:'合并' };
const hfTime = n => n ? new Date(n).toLocaleString() : '—';
const hfState = s => `<span class="hf-state hf-${esc(s)}">${esc(hfLabels[s] || s)}</span>`;
function hfCoverage(data) {
  const automatic=data.config.discoveryMode==='recent';
  const chats=new Set(Object.values(data.messages).filter(m=>m.createdAt>=data.config.since).map(m=>m.chatId));
  return automatic?`自动发现私聊与群聊 · 已读 ${chats.size} 个聊天`:`仅监听手选的 ${data.config.chats.length} 个聊天`;
}
function hfUsage(data) {
  const u=data.runtime.usage;
  if(!u)return '<p class="hf-reason">用量统计将在服务重载后启用。</p>';
  const modes={suggest:'话题分析',followup:'后续决定',verify:'执行核对'};
  return `${u.paused?'<p class="hf-error" role="status">今日分析预算不足，模型调用已暂停；消息仍在接收。可提高预算或等待次日恢复。</p>':''}<div class="hf-toolbar" aria-label="助理模型用量"><strong>今日 Token ${u.used.toLocaleString()} / ${u.limit.toLocaleString()}</strong><span>剩余 ${u.remaining.toLocaleString()}</span>${u.reserved?`<span>预留 ${u.reserved.toLocaleString()}</span>`:''}<span>已存 ${Object.keys(data.topicMemories||{}).length} 份话题摘要</span><span>${u.calls} 次模型调用 · 输入 ${u.inputTokens.toLocaleString()} / 输出 ${u.outputTokens.toLocaleString()}</span><a href="#" data-hf-budget-settings>预算设置</a></div><p class="hf-reason">${Object.entries(u.byMode).map(([k,v])=>`${modes[k]||k} ${v.tokens.toLocaleString()}`).join(' · ')}${u.estimatedTokens?` · 含 ${u.estimatedTokens.toLocaleString()} 估算 Token（请求未返回用量）`:''} · 按 UTC 日重置（北京时间 08:00）；从本功能启用后累计。</p>`;
}
function hfAnalysisControl(data){
  const on=!!data.config.modelEnabled,u=data.runtime.usage;
  return `<div class="hf-analysis-control"><div><strong>自动分析</strong><span>${on?'后台分析消息，会消耗 Token':'已关闭 · 消息继续接收'}</span></div><button type="button" role="switch" aria-label="自动分析" aria-checked="${on}" data-hf-analysis-toggle class="hf-switch"><span></span></button>${u?`<small>今日 ${u.used.toLocaleString()} / ${u.limit.toLocaleString()} Token <a href="#" data-hf-budget-settings>调整预算</a></small>`:''}<small>${!on&&data.runtime.analyzing?'当前请求可能仍在结束，不再发起后续自动分析。':'手动生成建议、确认前核对仍会消耗 Token；已批准任务继续执行。'}</small></div>`;
}
let hfAnalysisSaving=false, hfAnalysisRevision=0;
async function hfToggleAnalysis(button){
  if(hfAnalysisSaving)return;hfAnalysisSaving=true;hfAnalysisRevision++;button.disabled=true;
  try{
    const enabled=button.getAttribute('aria-checked')!=='true';
    await api('POST','heartflow/config',{modelEnabled:enabled});
    heartflowData.config.modelEnabled=enabled;
    const control=$('#hf-analysis-control');if(control)control.innerHTML=hfAnalysisControl(heartflowData);
    const checkbox=$('#hf-model-enabled');if(checkbox)checkbox.checked=enabled;
    const status=$('#hf-live-status');if(status)status.innerHTML=hfProgress(heartflowData);
  }catch(error){const notice=$('#hf-notice');if(notice)notice.textContent='自动分析设置未保存：'+error.message;button.disabled=false;}
  finally{hfAnalysisSaving=false;}
}
function hfProgress(data) {
  const ps=Object.values(data.proposals),ds=Object.values(data.deliveries),messages=Object.values(data.messages);
  const covered=new Set(ps.flatMap(p=>p.messageIds));
  const backlog=messages.filter(m=>!m.deleted&&m.createdAt>=data.config.since&&data.cursor['analyzed:'+m.id]!==m.revision&&!covered.has(m.id)).length;
  const pending=ps.filter(p=>['pending','deferred'].includes(p.state)).length;
  const running=ds.filter(d=>['queued','dispatching','accepted','running'].includes(d.state)).length;
  const completed=ps.filter(p=>p.state==='completed').length;
  const status=!data.config.enabled?'已暂停':data.source.authRequired?'等待飞书重新授权':data.source.error?'同步异常':data.runtime.polling?'正在读取消息':data.runtime.analyzing?'正在分析消息':!data.config.modelEnabled?'自动分析已关闭':data.runtime.usage?.paused?'等待预算恢复':'正在关注你的工作';
  const metrics=[['pending','待你确认',pending,'查看建议，决定下一步'],['messages','已读取消息',messages.length.toLocaleString(),`${backlog} 条等待分析`],['activity','正在执行',running,'已确认行动的执行进展'],['home','已完成事项',completed,'含你确认及后续对话确认']];
  return `<div class="hf-status"><span class="hf-dot ${data.config.enabled&&!data.source.error?'on':''}"></span><strong>${status}</strong><span>${hfCoverage(data)}</span><span>最近同步 ${esc(hfTime(data.source.lastSync))}</span></div>
    <div class="hf-metrics">${metrics.map(([id,title,value,note])=>`<button class="hf-metric" data-hf-jump="${id}"><span>${title}</span><strong>${value}</strong><small>${note}</small></button>`).join('')}</div>
    ${data.source.authRequired ? '<div class="hf-alert" role="status"><strong>个人飞书授权已失效</strong><span>在运行助理的机器上执行 <code>bytedcli feishu login --force-oauth --scope offline_access,search:message,im:chat:read,im:message:readonly,im:message.group_msg:get_as_user,im:message.p2p_msg:get_as_user,im:message.reactions:read</code>，用原账号确认后从上次进度继续。</span><button type="button" class="btn" data-hf-retry>已授权，恢复同步</button></div>' : ''}
    ${[['消息同步',!data.source.authRequired && data.source.error],['建议分析',data.source.analysisError],['表情回应',data.source.reactionError],['通知发送',data.source.noticeError]].filter(([,error])=>error).map(([title,error])=>`<div class="hf-alert" role="status"><strong>${title}需要关注</strong><span>${esc(error)}</span><button class="btn" data-hf-jump="settings">查看设置</button></div>`).join('')}
    <div class="hf-usage-strip">${hfUsage(data)}</div>`;
}
const hfViews=[['home','工作概览','查看关注内容与最新决策'],['pending','待我确认','核对建议，再决定是否执行'],['messages','消息记录','查看助理已读取的原始消息'],['activity','执行记录','追踪已确认行动的执行结果'],['matters','事项','管理消息与任务之间的关联'],['learning','反馈与学习','查看并管理你对助理的纠正'],['settings','设置','消息范围、分析预算与通知']];
function hfRenderContent(data){
  document.querySelector('.hf').dataset.view=heartflowView;
  const title=hfViews.find(v=>v[0]===heartflowView)||hfViews[0];
  $('#hf-view-heading').textContent=title[1];$('#hf-view-description').textContent=title[2];
  document.querySelectorAll('[data-hf-tab]').forEach(b=>{const active=b.dataset.hfTab===heartflowView;b.classList.toggle('active',active);if(active)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
  ({home:hfHome,pending:hfPending,messages:hfMessages,matters:hfMatters,activity:hfActivity,learning:hfLearning,settings:hfSettings}[heartflowView]||hfHome)(data);
}
async function renderHeartflow(useCache=false) {
  const renderVersion=++heartflowRenderVersion;
  clearInterval(heartflowPulseTimer);
  $('#empty').style.display='none';$('#metabar').style.display='none';$('#render').style.display='block';$('#render').classList.add('wide');
  const root=$('#render'); if(!heartflowData)root.innerHTML='<p role="status">正在加载助理…</p>';
  try {
    const data=useCache&&heartflowData?heartflowData:await api('GET','heartflow');if(state.type!=='heartflow'||renderVersion!==heartflowRenderVersion)return;heartflowData=data;
    const pending=Object.values(data.proposals).filter(p=>['pending','deferred'].includes(p.state)).length;
    root.innerHTML=`<section class="hf"><header class="hf-header"><div><div class="hf-eyebrow">工作 / 助理</div><h1>助理工作台</h1><p>查看消息，理解进展，把需要你决定的事放在一起。</p></div><div class="hf-header-actions"><a class="btn" href="/connections">管理消息渠道</a><button class="btn" id="hf-refresh">刷新</button></div></header>
      <div id="hf-analysis-control">${hfAnalysisControl(data)}</div><nav class="hf-tabs" aria-label="助理导航">${hfViews.map(([id,title])=>`<button class="hf-nav-item ${heartflowView===id?'active':''}" data-hf-tab="${id}" ${heartflowView===id?'aria-current="page"':''}>${title}${id==='pending'?`<span class="hf-nav-count">${pending}</span>`:''}</button>`).join('')}</nav><div id="hf-live-status">${hfProgress(data)}</div><div class="hf-view-header"><div><h2 id="hf-view-heading"></h2><p id="hf-view-description"></p></div><p id="hf-live-update" role="status"></p></div><div id="hf-notice" role="status"></div><div id="hf-content"></div></section>`;
    root.onclick=e=>{
      const retry=e.target.closest('[data-hf-retry]');if(retry){hfDo(retry,()=>api('POST','heartflow/sync',{}));return;}
      const toggle=e.target.closest('[data-hf-analysis-toggle]');if(toggle){hfToggleAnalysis(toggle);return;}
      const target=e.target.closest('[data-hf-tab],[data-hf-jump],[data-hf-budget-settings]');
      if(target){e.preventDefault();heartflowView=target.dataset.hfTab||target.dataset.hfJump||'settings';hfRenderContent(heartflowData);}
    };
    root.querySelector('#hf-refresh').onclick=()=>renderHeartflow();
    hfRenderContent(data);
    let checking=false;
    heartflowPulseTimer=setInterval(async()=>{
      if(state.type!=='heartflow'){clearInterval(heartflowPulseTimer);return;}
      if(checking || document.hidden)return;checking=true;
      try{
        const analysisRevision=hfAnalysisRevision;
        const update=await api('GET','heartflow?revision='+encodeURIComponent(heartflowData.revision||''));
        const latest=update.unchanged?{...heartflowData,runtime:update.runtime}:update;
        if(hfAnalysisSaving||analysisRevision!==hfAnalysisRevision)return;
        if(state.type!=='heartflow'||renderVersion!==heartflowRenderVersion||!$('#hf-live-status'))return;
        if(!hfAnalysisSaving){$('#hf-live-status').innerHTML=hfProgress(latest);$('#hf-analysis-control').innerHTML=hfAnalysisControl(latest);}
        const badge=document.querySelector('.hf-nav-count');if(badge)badge.textContent=Object.values(latest.proposals).filter(p=>['pending','deferred'].includes(p.state)).length;
        if(heartflowView==='home'&&!$('#hf-content').querySelector('details[open], textarea:focus')&&!Array.from($('#hf-content').querySelectorAll('textarea')).some(el=>el.value.trim()))hfHome(latest);
        heartflowData=latest;
        const changed=Object.values(latest.proposals).some(p=>p.version!==data.proposals[p.id]?.version);
        $('#hf-live-update').textContent=changed?'有新建议或来源更新，请点刷新查看。当前编辑内容已保留。':'状态已更新 · '+hfTime(Date.now());
      }catch(error){if(state.type==='heartflow' && $('#hf-live-update'))$('#hf-live-update').textContent='状态刷新失败：'+error.message;}
      finally{checking=false;}
    },10000);
  }catch(e){if(state.type==='heartflow')root.innerHTML=`<p role="alert">助理加载失败：${esc(e.message)}</p>`;}
}
async function hfDo(button,fn) {
  if(button)button.disabled=true;
  const notice=$('#hf-notice'); if(notice)notice.textContent='正在处理…';
  try {await fn();if(state.type==='heartflow')await renderHeartflow();}
  catch(e){const n=$('#hf-notice');if(n){n.textContent=e.message;n.className='hf-error';}if(button)button.disabled=false;}
}
function hfHome(data) {
  const proposals=Object.values(data.proposals).sort((a,b)=>b.updatedAt-a.updatedAt);
  const deliveries=Object.values(data.deliveries);
  const evidence=p=>[...(p.topic?.evidence||[]),...(p.resolutions||[]).flatMap(r=>r.evidence||[])];
  const sources=p=>[...new Set([...p.messageIds,...evidence(p).filter(e=>e.source==='feishu').map(e=>e.id)])].map(id=>data.messages[id]).filter(Boolean);
  const covered=new Set(proposals.flatMap(p=>sources(p).map(m=>m.id)));
  const unlinked=Object.values(data.messages).filter(m=>!covered.has(m.id));
  const analyzed=m=>data.cursor['analyzed:'+m.id]===m.revision;
  const latest=p=>(p.resolutions||[]).map(r=>r.reason).join('；')||p.topic?.summary||p.summary;
  const sourceDetails=rows=>`<details><summary>查看 ${rows.length} 条原消息</summary>${rows.map(m=>hfMessage(m)).join('')}</details>`;
  const inspected=proposals.map(p=>{
    const rows=sources(p),people=[...new Set(rows.map(m=>m.senderName||m.senderId).filter(Boolean))],chats=[...new Set(rows.map(m=>m.chatName||m.chatId))];
    return `<article class="hf-card hf-topic-brief" id="hf-topic-${esc(p.id)}"><small>${esc(chats.join(' · '))}</small><h3>${esc(p.title)}</h3><p class="hf-brief-meta">${rows.length} 条消息 · ${people.length} 位参与者</p><p class="hf-reason">${esc(people.join('、'))}</p><p class="hf-brief-summary">${esc(latest(p))}</p><small>判断更新 ${esc(hfTime(p.updatedAt))}</small><p><a href="#hf-decision-${encodeURIComponent(p.id)}">查看判断与行动 →</a></p>${sourceDetails(rows)}</article>`;
  }).join('');
  const groups=new Map();for(const m of unlinked){if(!groups.has(m.chatId))groups.set(m.chatId,[]);groups.get(m.chatId).push(m);}
  const rest=[...groups.values()].map(rows=>`<article class="hf-card"><h3>${esc(rows[0].chatName||rows[0].chatId)}</h3><p>已读取 ${rows.length} 条尚未关联话题的消息</p><p>${rows.filter(analyzed).length} 条已分析、未生成建议 · ${rows.filter(m=>!analyzed(m)).length} 条待分析</p><small>这些消息没有逐条记录判断原因，不能据此认定它们无关。</small>${sourceDetails(rows.sort((a,b)=>b.createdAt-a.createdAt).slice(0,30))}</article>`).join('');
  const decisions=proposals.map(p=>{
    const ds=deliveries.filter(d=>d.proposalId===p.id),checks=data.checks.filter(c=>c.proposalId===p.id),last=checks.at(-1);
    const decision={pending:'建议已整理，等你确认',deferred:'你已暂缓，尚未批准剩余行动',ignored:p.exclusion?'交由他人处理，无需你跟进':'你已忽略此建议',superseded:'原建议已被后续决定替代',completed:p.completion?(p.completion.source==='user'?'你已确认完成':'后续对话确认完成'):'原会话报告已完成',in_progress:'已在原会话发起',merged:'已合并到其他建议',approved:'你已批准行动'}[p.state]||p.state;
    const ev=evidence(p);
    return `<article class="hf-card hf-decision-brief" id="hf-decision-${esc(p.id)}"><header><span>${esc(p.title)}</span>${hfState(p.state)}<small>${esc(hfTime(p.updatedAt))}</small></header><div class="hf-decision-body"><div class="hf-toolbar">${hfState(p.state)}<small>${esc(hfTime(p.updatedAt))}</small></div><h3>${esc(p.title)}</h3><p><strong>判断：</strong>${esc(decision)}</p><p>${esc(p.exclusion?.reason||p.completion?.reason||latest(p)||p.reason)}</p>${p.completion?.evidence?.map(e=>`<p class="hf-reason">完成依据：${esc(e.senderName||e.senderId)} · ${esc(e.quote)}</p>`).join('')||''}${last?`<p class="hf-reason">你的反馈：${esc(hfLabels[last.decision]||last.decision)}${last.reason?' · '+esc(last.reason):''}</p>`:''}<h4>执行情况</h4>${ds.length?ds.map(d=>`<div class="hf-execution">${hfState(d.state)}<p>${esc(d.action.prompt)}</p>${d.result?`<p>${esc(d.result)}</p>`:''}${d.error?`<p class="hf-error">${esc(d.error)}</p>`:''}${d.sessionId||d.action.sessionId?`<a href="/sessions/${encodeURIComponent(d.sessionId||d.action.sessionId)}">查看执行会话</a>`:''}</div>`).join(''):'<p>助理未投递执行任务。</p>'}${(p.resolutions||[]).map(r=>`<p>${esc(hfLabels[r.status]||r.status)} ${r.sessionId?`<a href="/sessions/${encodeURIComponent(r.sessionId)}">核对原会话</a>`:''}</p>`).join('')}<p><a href="#hf-topic-${encodeURIComponent(p.id)}">← 查看关注的话题</a></p>${ev.length?`<details><summary>判断依据 · ${ev.length} 条引用</summary>${ev.map(e=>`<p>${esc(e.senderName||e.senderId||e.role||'原会话')} · ${esc(hfTime(e.timestamp))}</p><pre>${esc(e.quote)}</pre>`).join('')}</details>`:`<p class="hf-reason">依据：${esc(p.reason||'未记录具体判断依据')}</p>`}${['pending','deferred'].includes(p.state)?`<button class="btn primary" data-hf-review="${esc(p.id)}">查看 / 修改并确认</button>`:''}<details><summary>纠正这个判断</summary><label>你的纠正<textarea data-hf-correction="${esc(p.id)}" rows="2" placeholder="例如：取消的是另一个需求，这项仍需跟进"></textarea></label><button class="btn" data-hf-feedback-save="${esc(p.id)}">保存反馈</button><small>作为后续判断参考；不会自动执行或恢复已撤销的任务。</small></details></div></article>`;
  }).join('');
  $('#hf-content').innerHTML=`<p class="hf-channel-link">消息来源：飞书 / Lark · ${hfCoverage(data)} <a href="/connections">管理连接 →</a></p><div class="hf-home"><section aria-labelledby="hf-observed-heading"><h2 id="hf-observed-heading"><span class="hf-section-index">01</span> 我查看了什么</h2><p class="hf-reason">${hfCoverage(data)} · 直接监听： ${esc(data.config.chats.map(c=>c.name||c.id).join('、')||'尚未配置聊天')}</p>${inspected||'<p class="hf-empty">还没有整理出话题。读取消息后，会在这里展示关注内容和最新进展。</p>'}${rest?`<details><summary>其他已读取内容 · ${unlinked.length} 条</summary>${rest}</details>`:''}</section><section aria-labelledby="hf-decisions-heading"><h2 id="hf-decisions-heading"><span class="hf-section-index">02</span> 我的决策与执行</h2><p class="hf-reason">区分助理判断、你的确认和实际执行结果。</p>${decisions||'<p class="hf-empty">暂无判断与行动。已读取内容可在左侧核对，尚未产生建议不代表没有工作。</p>'}${unlinked.some(analyzed)?`<article class="hf-card"><h3>已分析，未生成行动建议</h3><p>${unlinked.filter(analyzed).length} 条未关联消息已完成分析；没有投递执行任务。</p><p class="hf-reason">历史记录未提供逐条原因，可到原始消息查看或手动建立建议。</p></article>`:''}</section></div>`;
  $('#hf-content').querySelectorAll('a[href^="#hf-decision-"]').forEach(a=>a.onclick=()=>{const target=document.getElementById(decodeURIComponent(a.hash.slice(1)));if(target)target.open=true;});
  $('#hf-content').querySelectorAll('[data-hf-review]').forEach(b=>b.onclick=()=>{heartflowSelected=b.dataset.hfReview;heartflowView='pending';hfRenderContent(heartflowData);});
  $('#hf-content').querySelectorAll('[data-hf-feedback-save]').forEach(b=>b.onclick=()=>hfDo(b,()=>{const id=b.dataset.hfFeedbackSave,input=Array.from($('#hf-content').querySelectorAll('[data-hf-correction]')).find(el=>el.dataset.hfCorrection===id);if(!input.value.trim())throw new Error('请填写需要纠正的内容');return api('POST','heartflow/feedback/'+encodeURIComponent(id),{version:data.proposals[id].version,reason:input.value.trim()});}));
}
function hfMessage(m, selectable=false, data=null) {
  if(!m)return '';
  const links=data?Object.values(data.proposals).filter(p=>p.messageIds.includes(m.id)):[];
  const outcome=links.map(p=>`${hfTopic(p)}<p>${hfState(p.state)} ${esc(p.title)}${p.resolutions?.length?' · '+esc(p.resolutions.map(r=>r.reason).join('；')):''}</p>`).join('');
  return `<article class="hf-source">${selectable?`<input type="checkbox" data-hf-msg="${esc(m.id)}" aria-label="选择来源消息">`:''}<strong>${esc(m.chatName)}</strong><small>${esc(m.senderName && m.senderName!==m.senderId ? m.senderName : '姓名未解析 · '+m.senderId)} · ${esc(hfTime(m.createdAt))}</small><p>${esc(m.text)}</p>${outcome}${(m.reactions||[]).map(r=>`<small>${esc(r.reaction_type?.emoji_type||'')} · ${esc(r.operator?.operator_id||'')}</small>`).join('')}${m.deleted?'<b>消息已撤回</b>':''}<small>${esc(m.id)}${m.parentId?' · 回复 '+esc(m.parentId):''}</small></article>`;
}
function hfPending(data) {
  const ps=Object.values(data.proposals).filter(p=>['pending','deferred'].includes(p.state)).sort((a,b)=>b.updatedAt-a.updatedAt);
  if(!ps.some(p=>p.id===heartflowSelected))heartflowSelected=ps[0]?.id || '';
  $('#hf-content').innerHTML=`<div class="hf-toolbar"><button class="btn" id="hf-analyze">生成新建议</button><button class="btn" id="hf-merge">合并选中建议</button><span>整理后重新确认；只执行选中的行动。</span></div><div class="hf-grid"><div class="hf-list">${ps.map(p=>`<div class="hf-list-item ${p.id===heartflowSelected?'selected':''}"><input type="checkbox" data-hf-proposal="${p.id}" aria-label="选择建议 ${esc(p.title)}"><button data-hf-select="${p.id}"><strong>${esc(p.title)}</strong><small>${p.messageIds.length} 条消息 · ${p.actions.length} 项行动</small>${hfState(p.state)}</button></div>`).join('')||'<div class="hf-empty">暂无待确认建议。到接入设置选择聊天，然后同步并分析。</div>'}</div><div id="hf-detail"></div></div>`;
  $('#hf-analyze').onclick=e=>hfDo(e.target,()=>api('POST','heartflow/analyze',{}));
  $('#hf-merge').onclick=e=>hfDo(e.target,()=>{const ids=[...document.querySelectorAll('[data-hf-proposal]:checked')].map(x=>x.dataset.hfProposal);if(ids.length<2)throw new Error('请至少选择两项建议');return api('POST','heartflow/organize',{proposals:ids.map(id=>({id,version:data.proposals[id].version}))});});
  document.querySelectorAll('[data-hf-select]').forEach(b=>b.onclick=()=>{heartflowSelected=b.dataset.hfSelect;hfPending(data);});
  const p=data.proposals[heartflowSelected];if(p)hfDetail(p,data);
}
function hfTopic(p) {
  if(!p.topic)return '';
  const labels={discussing:'讨论中',decided:'已形成决定',changed:'范围已变化',cancelled:'已撤销',reported_complete:'群内反馈已完成'};
  return `<section class="hf-card"><strong>话题最新状态：${esc(labels[p.topic.status]||p.topic.status)}</strong><p>${esc(p.topic.summary)}</p><details><summary>查看判断依据</summary>${p.topic.evidence.map(e=>`<p>${esc(e.senderName||e.senderId)} · ${esc(hfTime(e.timestamp))}</p><pre>${esc(e.quote)}</pre>`).join('')}</details>${p.sourceChanged?'<p class="hf-error">请根据最新决定核对并保存行动范围。</p>':''}</section>`;
}
function hfDetail(p,data) {
  const actions=JSON.parse(JSON.stringify(p.actions));
  $('#hf-detail').innerHTML=`<div class="hf-card"><div class="hf-toolbar">${hfState(p.state)}<span>版本 ${p.version} · ${p.model?'模型 '+esc(p.model):'人工整理'}</span></div>${p.sourceChanged?'<p class="hf-error">来源有更新，请重新核对摘要与执行范围。</p>':''}
    ${p.completion?`<p>${esc(p.completion.reason)}</p>`:''}${hfTopic(p)}<label>事项建议<input id="hf-title" value="${esc(p.title)}" maxlength="160"></label><label>汇总<textarea id="hf-summary" rows="3">${esc(p.summary)}</textarea></label><p class="hf-reason">推荐依据：${esc(p.reason||'人工整理')}</p>
    <label>关联事项（可多选）<select id="hf-matters" multiple size="3">${Object.values(data.matters).map(m=>`<option value="${m.id}" ${p.matterIds.includes(m.id)?'selected':''}>${esc(m.title)}</option>`).join('')}</select></label><button class="btn" id="hf-create-matter">以此标题创建事项并关联</button>
    <h3>行动与目标会话</h3><div id="hf-actions"></div><button class="btn" id="hf-add-action">＋ 增加行动</button>
    <label>你的补充 / 处理原因<input id="hf-feedback" placeholder="例如：应归到个人 Tag，会话不要新建"></label>
    <div class="hf-toolbar"><button class="btn primary" id="hf-approve">确认选中行动并执行</button><button class="btn" id="hf-save">保存修改</button><button class="btn" id="hf-defer">暂缓</button><button class="btn" id="hf-ignore">忽略</button><button class="btn" id="hf-complete">标记完成</button></div>
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
  for(const decision of ['approve','save','defer','ignore','complete'])$('#hf-'+decision).onclick=e=>hfDo(e.target,()=>api('POST','heartflow/review/'+p.id,{version:p.version,decision,draft:draft(),reason:$('#hf-feedback').value,actionIds:[...document.querySelectorAll('[data-approve-action]:checked')].map(x=>x.dataset.approveAction)}));
  $('#hf-create-matter').onclick=e=>hfDo(e.target,async()=>{const input=draft();const m=await api('POST','heartflow/matters',{title:input.title,description:input.summary});input.matterIds.push(m.id);await api('POST','heartflow/review/'+p.id,{version:p.version,decision:'save',draft:input,reason:'创建并关联事项'});});
  $('#hf-split').onclick=e=>hfDo(e.target,()=>api('POST','heartflow/organize',{proposals:[{id:p.id,version:p.version}],splitIds:[...document.querySelectorAll('[data-hf-msg]:checked')].map(x=>x.dataset.hfMsg)}));
}
function hfMessages(data) {
  const rows=Object.values(data.messages).sort((a,b)=>b.createdAt-a.createdAt).slice(0,200);
  $('#hf-content').innerHTML=`<div class="hf-toolbar"><button class="btn" id="hf-sync">同步消息</button><button class="btn" id="hf-manual">从选中消息建立建议</button><span>最近 200 条；原始消息只作为资料，未经确认不会执行。</span></div>${rows.map(m=>hfMessage(m,true,data)).join('')||'<p class="hf-empty">还没有消息，请先选择聊天并同步。</p>'}`;
  $('#hf-sync').onclick=e=>hfDo(e.target,()=>api('POST','heartflow/sync',{}));
  $('#hf-manual').onclick=e=>hfDo(e.target,async()=>{const messageIds=[...document.querySelectorAll('[data-hf-msg]:checked')].map(x=>x.dataset.hfMsg);if(!messageIds.length)throw new Error('请选择消息');const p=await api('POST','heartflow/drafts',{title:data.messages[messageIds[0]].chatName+' · 待办',summary:messageIds.map(id=>data.messages[id].text).join('\n').slice(0,12000),messageIds,matterIds:[],actions:[]});heartflowSelected=p.id;heartflowView='pending';});
}
function hfMatters(data) {
  $('#hf-content').innerHTML=`<div class="hf-toolbar"><input id="hf-matter-title" placeholder="新事项名称"><button class="btn" id="hf-matter-add">建立事项</button></div>${Object.values(data.matters).map(m=>{const ps=Object.values(data.proposals).filter(p=>p.matterIds.includes(m.id));const ds=Object.values(data.deliveries).filter(d=>ps.some(p=>p.id===d.proposalId));return `<article class="hf-card"><h3>${esc(m.title)}</h3><p>${esc(m.description)}</p><p>${new Set(ps.flatMap(p=>p.messageIds)).size} 条来源消息 · ${ps.length} 项建议 · ${new Set(ds.map(d=>d.sessionId||d.action.sessionId).filter(Boolean)).size} 个执行会话</p>${ps.map(p=>`<p>${hfState(p.state)} ${esc(p.title)}</p>`).join('')}${ds.map(d=>`<p>${hfState(d.state)} ${esc(d.action.prompt.slice(0,150))}</p>`).join('')}</article>`;}).join('')||'<p class="hf-empty">可在建议详情创建事项；同一建议允许关联多个事项。</p>'}`;
  $('#hf-matter-add').onclick=e=>hfDo(e.target,()=>api('POST','heartflow/matters',{title:$('#hf-matter-title').value}));
}
function hfActivity(data) {
  $('#hf-content').innerHTML=`<div class="hf-toolbar"><button class="btn" id="hf-reconcile">核对执行状态</button><span>结果不明的行动不会自动重发。</span></div>${Object.values(data.deliveries).reverse().map(d=>`<article class="hf-card">${hfState(d.state)} <small>${esc(hfTime(d.updatedAt))}</small><h3>${esc(data.proposals[d.proposalId]?.title||'行动')}</h3><p>${esc(d.action.prompt)}</p><small>${esc(d.action.machineId)} · ${esc(d.action.cwd)} · 建议版本 ${d.version}</small>${d.error?`<p class="hf-error">${esc(d.error)}</p>`:''}${d.sessionId||d.action.sessionId?`<p><a href="/sessions/${encodeURIComponent(d.sessionId||d.action.sessionId)}">查看执行会话</a></p>`:''}</article>`).join('')||'<p class="hf-empty">还没有批准的行动。</p>'}`;
  $('#hf-content').insertAdjacentHTML('beforeend',Object.values(data.proposals).filter(p=>p.resolutions?.length).map(p=>`<article class="hf-card">${hfState(p.state)}<h3>${esc(p.title)}</h3>${p.resolutions.map(r=>`<p>${esc(r.reason)}</p>${r.sessionId?`<a href="/sessions/${encodeURIComponent(r.sessionId)}">查看原会话</a>`:''}<pre>${esc(r.evidence.map(e=>(e.source==='feishu'?(e.senderName||e.senderId)+' · '+hfTime(e.timestamp)+'\n':'')+e.quote).join('\n'))}</pre>`).join('')}</article>`).join(''));
  $('#hf-reconcile').onclick=e=>hfDo(e.target,()=>api('POST','heartflow/reconcile',{}));
}
function hfLearning(data) {
  $('#hf-content').innerHTML=`<div class="hf-card"><h3>从你的反馈学习</h3><p>同一聊天的历史纠正会作为后续模型推荐的参考。关闭参考不会删除审计记录。批准次数不会自动扩大执行权限。</p></div>${data.checks.slice().reverse().map(c=>`<article class="hf-card"><div class="hf-toolbar"><strong>${esc(hfLabels[c.decision]||c.decision)}</strong><small>${esc(hfTime(c.at))}</small><label><input type="checkbox" data-learning="${c.id}" ${c.learning?'checked':''}> 用于后续推荐</label></div><p>${esc(c.reason||'未填写原因')}</p><details><summary>查看 check 前后内容</summary><div class="hf-diff"><div><h4>推荐 / 修改前</h4><pre>${esc(JSON.stringify(c.before,null,2))}</pre></div><div><h4>你的选择 / 修改后</h4><pre>${esc(JSON.stringify(c.after,null,2))}</pre></div></div></details></article>`).join('')||'<p class="hf-empty">首次确认、修改、改派、拆分或忽略后，记录会出现在这里。</p>'}`;
  document.querySelectorAll('[data-learning]').forEach(el=>el.onchange=()=>hfDo(el,()=>api('POST','heartflow/learning/'+el.dataset.learning,{enabled:el.checked})));
}
function hfSettings(data) {
  const chats=JSON.parse(JSON.stringify(data.config.chats));
  $('#hf-content').innerHTML=`<div class="hf-card"><h3>飞书个人消息</h3><p>使用你的飞书用户授权读取消息。自动发现会检索读取起点之后、当前授权可访问的私聊和群聊；受搜索索引延迟影响，不代表实时覆盖全部消息。</p><label>消息读取范围<select id="hf-discovery-mode"><option value="recent" ${data.config.discoveryMode==='recent'?'selected':''}>自动发现近期私聊与群聊</option><option value="selected" ${data.config.discoveryMode!=='recent'?'selected':''}>仅手动选择的聊天</option></select></label><p class="hf-reason">新消息与历史补读分开推进；只读取、分析和提出建议，行动仍需确认。下方手选聊天会额外直接拉取，减少搜索延迟。</p><button class="btn" id="hf-identity">检查用户授权</button><div id="hf-identity-result"></div><div class="hf-toolbar"><input id="hf-chat-query" placeholder="搜索群聊名称"><button class="btn" id="hf-chat-search">搜索聊天</button></div><div id="hf-chat-results"></div><div class="hf-toolbar"><input id="hf-chat-id" placeholder="或输入私聊 / 群聊 chat_id（oc_…）"><button class="btn" id="hf-chat-add">加入监听范围</button></div><div id="hf-chat-chosen"></div>
    <label><input id="hf-enabled" type="checkbox" ${data.config.enabled?'checked':''}> 自动同步消息</label><label><input id="hf-model-enabled" type="checkbox" ${data.config.modelEnabled?'checked':''}> 同步后调用模型生成建议（不自动执行）</label><div class="hf-fields"><label>同步间隔（秒）<input id="hf-interval" type="number" min="30" max="3600" value="${data.config.intervalSeconds}"></label><label>分析模型<input id="hf-model" value="${esc(data.config.model)}" placeholder="使用账号池默认 Codex 模型"></label></div><label>首次读取起点<input id="hf-since" type="datetime-local" value="${new Date(data.config.since-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16)}"></label><h3>分析用量与预算</h3><label>每日 Token 上限（输入 + 输出）<input id="hf-daily-budget" type="number" min="0" max="10000000" step="10000" value="${data.config.dailyTokenBudget??500000}"></label><label>后台核对间隔（秒）<input id="hf-check-interval" type="number" min="60" max="3600" value="${data.config.checkIntervalSeconds??600}"></label><p class="hf-reason">达到预算后继续收消息，暂停模型分析与确认前核对。确认执行前会重新核对原文，不跳过预算。正常对话和已批准任务不计入此预算。UTC 每日重置，用量缺失时按预留上限估算。</p><h3>飞书确认卡片</h3><label><input id="hf-notify" type="checkbox" ${data.config.notifyEnabled?'checked':''}> 向已配对的机器人私聊发送建议卡片</label><label>机器人配对用户 ID<input id="hf-notify-user" value="${esc(data.config.notifyUserId||'')}" placeholder="IM 接入中的 ou_…，可能与个人消息授权的 ID 不同"></label><label>你可访问的面板地址<input id="hf-panel-url" value="${esc(data.config.panelUrl||'')}" placeholder="用于卡片打开详情，不填写令牌"></label><button class="btn primary" id="hf-settings-save">保存所有设置</button><p class="hf-reason">消息、check 和投递记录保存在节点 ${esc(data.coordinator)}。该节点离线时暂停调度；其他节点不会接管未确认的行动。</p></div>`;
  const settingsCard=$('#hf-content > .hf-card');settingsCard.classList.add('hf-settings-grid');
  let settingsSection;
  for(const child of [...settingsCard.childNodes]){
    if(child.nodeName==='H3'){settingsSection=document.createElement('section');settingsSection.className='hf-settings-section';settingsCard.append(settingsSection);}
    if(settingsSection)settingsSection.append(child);
  }
  const draw=()=>{$('#hf-chat-chosen').innerHTML=chats.map(c=>`<div class="hf-toolbar"><span>${esc(c.name)} <small>${esc(c.id)}</small></span><button class="btn" data-chat-remove="${esc(c.id)}">移除</button></div>`).join('')||'<p>尚未选择聊天。</p>';document.querySelectorAll('[data-chat-remove]').forEach(b=>b.onclick=()=>{chats.splice(chats.findIndex(c=>c.id===b.dataset.chatRemove),1);draw();});};draw();
  $('#hf-chat-add').onclick=()=>{const id=$('#hf-chat-id').value.trim();if(!/^oc_[\w-]+$/.test(id)){$('#hf-notice').textContent='请输入有效 chat_id';return;}if(!chats.some(c=>c.id===id))chats.push({id,name:id});draw();};
  $('#hf-identity').onclick=async e=>{e.target.disabled=true;try{const who=await api('GET','heartflow/identity');$('#hf-identity-result').textContent='当前用户：'+(who.user?.name||'未知');}catch(e){$('#hf-identity-result').textContent=e.message;}finally{e.target.disabled=false;}};
  $('#hf-chat-search').onclick=async e=>{e.target.disabled=true;const el=$('#hf-chat-results');try{const r=await api('GET','heartflow/chats?q='+encodeURIComponent($('#hf-chat-query').value));const rows=r.items||r.chats||r.data?.items||[];el.innerHTML=rows.map((c,i)=>`<button class="hf-session" data-chat-index="${i}">${esc(c.name||c.chat_name||c.chat_id)}</button>`).join('')||'没有搜索结果';el.querySelectorAll('[data-chat-index]').forEach(b=>b.onclick=()=>{const c=rows[+b.dataset.chatIndex],id=c.chat_id||c.id;if(id&&!chats.some(c=>c.id===id))chats.push({id,name:c.name||c.chat_name||id});draw();});}catch(e){el.textContent=e.message;}finally{e.target.disabled=false;}};
  $('#hf-settings-save').onclick=e=>hfDo(e.target,()=>api('POST','heartflow/config',{dailyTokenBudget:Number($('#hf-daily-budget').value),checkIntervalSeconds:Number($('#hf-check-interval').value),discoveryMode:$('#hf-discovery-mode').value,notifyEnabled:$('#hf-notify').checked,notifyUserId:$('#hf-notify-user').value,panelUrl:$('#hf-panel-url').value,enabled:$('#hf-enabled').checked,modelEnabled:$('#hf-model-enabled').checked,model:$('#hf-model').value,intervalSeconds:Number($('#hf-interval').value),chats,...(Math.abs(new Date($('#hf-since').value).getTime()-data.config.since)>60000?{since:new Date($('#hf-since').value).getTime()}: {})}));
}
