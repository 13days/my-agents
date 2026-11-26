const { normalizeMessage, needsPersonalLogin } = require('./heartflow-feishu');
function createHeartflow({store,source,analyze,sessions,dispatch,observe=()=>null,notify=null,notifyResult=null,history=null,now=Date.now}) {
  let polling=false,analyzing=false,dispatching=false,notifying=false,checking=false,timer;
  store.recover();
  analyze=require('./heartflow-budget').trackedAnalysis({store,analyze,now});
  const backgroundAnalyze=(...args)=>{const c=store.snapshot().config;if(!c.enabled||!c.modelEnabled)throw Object.assign(new Error('自动分析已关闭'),{code:'ANALYSIS_PAUSED'});return analyze(...args);};
  const errorText=e=>String(e.message||e).slice(0,1000);
  async function sync({ automatic = false } = {}) {
    const { source: status } = store.snapshot();
    if (automatic && status.authRequired && now() < status.authRetryAt) return {authRequired:true};
    if(polling)return {busy:true};polling=true;
    let needsIdentity = status.authRequired;
    try{
      const config=store.snapshot().config;
      if(!config.chats.length && config.discoveryMode!=='recent')throw new Error('先选择需要监听的聊天');
      if (!config.selfId || needsIdentity) {
        const who = await source.identity();
        if (!who.user?.open_id) throw new Error('无法确认当前飞书用户身份');
        if (config.selfId && config.selfId !== who.user.open_id) throw new Error('飞书授权用户与原账号不同，请重新授权原账号');
        store.configure({selfId:who.user.open_id});
        needsIdentity = false;
      }
      const syncErrors=[];
      if(config.discoveryMode==='recent')try{await require('./heartflow-discovery').discoverMessages({store,source,now});}catch(e){if(needsPersonalLogin(e))throw e;syncErrors.push(e);}
      for(const chat of config.chats){
        try{
        let snapshot=store.snapshot(),cursor=snapshot.cursor[chat.id]||{},page=cursor.page||'',upper=cursor.upper||now(),floor=cursor.floor||Math.max(config.since,(cursor.watermark||config.since)-5*60000),finished=false;
        // Bounded pages per tick; persist continuation instead of dropping burst messages.
        for(let i=0;i<4;i++){
          const result=await source.page(chat.id,page),rows=result.messages||[];
          store.ingest(rows.filter(m=>Number(m.create_time)>=floor && Number(m.create_time)<=upper && m.msg_type!=='system').map(normalizeMessage));
          const older=rows.some(m=>Number(m.create_time)<floor);
          if(!result.has_more||older){finished=true;break;}page=result.page_token;if(!page)throw new Error('飞书分页游标缺失');
        }
        store.transaction(s=>{s.cursor[chat.id]=finished?{watermark:upper}:{page,upper,floor,watermark:cursor.watermark};});
        }catch(e){if(needsPersonalLogin(e))throw e;syncErrors.push(new Error(`${chat.id}: ${errorText(e)}`));}
      }
      const snapshot=store.snapshot();
      const parents=[...new Set(Object.values(snapshot.messages).filter(m=>require('./heartflow-discovery').inScope(m,config)&&m.createdAt>=config.since).map(m=>m.parentId).filter(id=>id&&!snapshot.messages[id]))].slice(0,30);
      if(parents.length && source.messages){const refs=await source.messages(parents);store.ingest((refs.messages||refs.items||[]).filter(m=>require('./heartflow-discovery').inScope({chatId:m.chat_id},config)).map(normalizeMessage));}
      const missing=Object.values(store.snapshot().messages).filter(m=>require('./heartflow-discovery').inScope(m,config)&&!m.identityEnriched).slice(-30);
      if(missing.length&&source.messages){const refs=await source.messages(missing.map(m=>m.id));store.ingest((refs.messages||refs.items||[]).map(normalizeMessage));}
      await require('./heartflow-completion').refresh({store,source,now});
      if(syncErrors.length)throw new AggregateError(syncErrors,syncErrors.map(errorText).join('; '));
      store.transaction(s=>{s.source={...s.source,ok:true,lastSync:now(),error:'',authRequired:false,authRetryAt:0};});
      return {ok:true};
    }catch(e){
      const authRequired = needsPersonalLogin(e) || !!needsIdentity;
      store.transaction(s=>{s.source={...s.source,ok:false,error:errorText(e),authRequired,authRetryAt:authRequired ? now()+6*3600000 : 0};});
      throw e;
    }finally{polling=false;}
  }
  async function followups(id,force=false,automatic=false) {
    const snapshot=store.snapshot();
    let checked=0;
    for(const p of Object.values(snapshot.proposals).filter(p=>(['pending','deferred'].includes(p.state)||(p.state==='completed'&&p.completion?.source==='conversation'))&&(!id||p.id===id)).sort((a,b)=>(a.lastFollowupCheck||0)-(b.lastFollowupCheck||0)).slice(0,50)){
      if(!force&&checked>=2)break;
      const result=await require('./heartflow-followup').inspectFollowup(p,snapshot,automatic?backgroundAnalyze:analyze,force,now());
      if(!result)continue;checked++;
      store.transaction(s=>{const current=s.proposals[p.id];if(current.version!==p.version)return;
        if(JSON.stringify(require('./heartflow-followup').relatedMessages(current,s).map(m=>[m.id,m.revision]))!==JSON.stringify(result.messages.map(m=>[m.id,m.revision])))throw new Error('群聊消息已变化，请重新核对');
        const contextChanged=current.followupFingerprint!==result.fingerprint;
        current.followupFingerprint=result.fingerprint;current.lastFollowupCheck=now();
        const topicChanged=contextChanged&&result.topic&&JSON.stringify(result.topic)!==JSON.stringify(current.topic);
        if(topicChanged){current.topic=result.topic;current.version++;current.updatedAt=now();if(['changed','cancelled'].includes(result.topic.status))current.sourceChanged=true;}
        if(current.state==='completed'){
          const lastEvidence=Math.max(...(current.completion?.evidence||[]).map(e=>s.messages[e.id]?.createdAt||0));
          if(!result.reopen?.evidence.some(e=>s.messages[e.id]?.createdAt>lastEvidence))return;
          current.previousCompletion=current.completion;delete current.completion;
          current.actions=current.completionActions||[];delete current.completionActions;current.state='pending';current.sourceChanged=true;
          current.version++;current.updatedAt=now();return;
        }
        if(result.exclusion){
          current.exclusion={...result.exclusion,at:now()};current.state='ignored';
          current.version++;current.updatedAt=now();current.sourceChanged=false;return;
        }
        if(result.completion){
          current.completion={...result.completion,at:now()};
          current.completionActions=current.actions;current.actions=[];
          current.messageIds=[...new Set([...current.messageIds,...result.completion.evidence.map(e=>e.id)])];
          current.state='completed';current.version++;current.updatedAt=now();current.sourceChanged=false;return;
        }
        if(!result.resolutions.length)return;
        current.resolutions=[...(current.resolutions||[]),...result.resolutions];
        current.resolvedActions=[...(current.resolvedActions||[]),...current.actions.filter(a=>result.resolutions.some(r=>r.actionId===a.id))];
        current.actions=current.actions.filter(a=>!result.resolutions.some(r=>r.actionId===a.id));
        current.messageIds=[...new Set([...current.messageIds,...result.resolutions.flatMap(r=>r.evidence.map(e=>e.id))])].slice(-30);
        for(const r of result.resolutions)for(const e of r.evidence)s.cursor['analyzed:'+e.id]=s.messages[e.id].revision;
        current.version++;current.updatedAt=now();current.sourceChanged=false;
        if(!current.actions.length)current.state='superseded';
      });
    }
  }
  async function verify(id,force=false,automatic=false) {
    if(!history)return;
    if(checking)throw new Error('正在核对执行记录，请稍后重试');
    checking=true;
    try {
      const snapshot=store.snapshot();
      let checked=0;
      for(const p of Object.values(snapshot.proposals).filter(p=>['pending','deferred'].includes(p.state)&&(!id||p.id===id)).sort((a,b)=>(a.lastHistoryCheck||0)-(b.lastHistoryCheck||0)).slice(0,50)){
        if(!force&&checked>=2)break;
        const result=await require('./heartflow-history').inspectProposal(p,snapshot,history,automatic?backgroundAnalyze:analyze,force,now());
        if(!result)continue;checked++;
        store.transaction(s=>{const current=s.proposals[p.id];if(current.version!==p.version)return;
          if(p.messageIds.some(id=>s.messages[id]?.revision!==snapshot.messages[id]?.revision))throw new Error('来源已变化，请重新核对');
          current.historyFingerprint=result.fingerprint;current.lastHistoryCheck=now();
          if(!result.resolutions.length)return;
          current.resolutions=[...(current.resolutions||[]),...result.resolutions];
          current.resolvedActions=[...(current.resolvedActions||[]),...current.actions.filter(a=>result.resolutions.some(r=>r.actionId===a.id))];
          current.actions=current.actions.filter(a=>!result.resolutions.some(r=>r.actionId===a.id));
          current.version++;current.updatedAt=now();
          if(!current.actions.length)current.state=result.resolutions.some(r=>r.status==='superseded')?'superseded':result.resolutions.some(r=>r.status==='in_progress')?'in_progress':'completed';
        });
      }
    }finally{checking=false;}
  }
  async function suggest({automatic=false}={}) {
    if(analyzing)return {busy:true};analyzing=true;
    try{
      await followups(undefined,false,automatic);
      await verify(undefined,false,automatic);
      const s=store.snapshot(),covered=new Set(Object.values(s.proposals).flatMap(p=>p.messageIds));
      const unread=Object.values(s.messages).filter(m=>require('./heartflow-discovery').inScope(m,s.config) && !m.deleted && m.createdAt>=s.config.since && (!covered.has(m.id)||Object.values(s.proposals).some(p=>p.sourceChanged&&p.messageIds.includes(m.id))) && s.cursor['analyzed:'+m.id]!==m.revision).sort((a,b)=>a.createdAt-b.createdAt);
      const messages=require('./heartflow-compact').batchMessages(unread,s);
      if(!messages.length){store.transaction(next=>{next.source.lastAnalysis=now();next.source.analysisError='';});return {created:0};}
      const catalog=(await sessions()).slice(0,100),candidates=catalog.map(x=>({id:x.id,title:x.title,engine:x.engine,machineId:x.machineId,cwd:x.project,latestPrompt:x.latestPrompt?.slice(0,600),running:x.running}));
      const support=require('./heartflow-context').topicContext(messages,s).filter(m=>!messages.some(x=>x.id===m.id));
      const context=require('./heartflow-compact').suggestionContext(s,messages,support,candidates);
      const supportingMessages=context.supportingMessages,pending=context.pending;
      const result=await (automatic?backgroundAnalyze:analyze)(context,s.config.model);let created=0;
      const latest=store.snapshot();if([...messages,...supportingMessages,...context.topicMemories.flatMap(m=>m.refs)].some(m=>latest.messages[m.id]?.revision!==m.revision))throw new Error('分析期间来源消息已更新，将在下次重新分析');
      for(const draft of result.suggestions){
        if(draft.responsibility==='delegated_others')continue;
        if((draft.messageIds||[]).some(id=>messages.some(m=>m.id===id&&!m.textComplete)))continue;
        if(!Array.isArray(draft.messageIds)||!draft.messageIds.length||draft.messageIds.some(id=>![...messages,...supportingMessages].some(m=>m.id===id)) || !draft.messageIds.some(id=>messages.some(m=>m.id===id)))continue;
        if((draft.matterIds||[]).some(id=>!s.matters[id]))continue;
        if(draft.relatedProposalId && pending.some(p=>p.id===draft.relatedProposalId)){
          const previous=s.proposals[draft.relatedProposalId];
          const merged=store.transaction(next=>{const p=next.proposals[previous.id];if(p.version!==previous.version || !['pending','deferred'].includes(p.state))return false;const ids=[...new Set([...p.messageIds,...draft.messageIds])];if(ids.length>30)return false;p.messageIds=ids;p.summary=String(draft.summary||p.summary).slice(0,12000);p.reason=String(draft.reason||p.reason).slice(0,3000);p.version++;p.sourceChanged=true;p.state='pending';p.updatedAt=now();return true;});
          if(merged){created++;continue;}
        }
        const actions=(draft.actions||[]).filter(a=>a.sessionId?context.sessions.some(c=>c.id===a.sessionId):context.sessions.some(c=>c.cwd===a.cwd&&c.machineId===a.machineId)).map(a=>{
          const target=context.sessions.find(c=>c.id===a.sessionId);return {...a,...(target?{engine:target.engine,machineId:target.machineId,cwd:target.cwd,sessionTitle:target.title}:{})};
        });
        // Never overwrite a reviewed draft. Changed sources remain visible for explicit review.
        if(draft.messageIds.every(id=>covered.has(id)))continue;
        store.draft({...draft,actions,model:result.model});created++;
      }
      store.transaction(next=>{for(const m of messages){if(m.textComplete){next.cursor['analyzed:'+m.id]=m.revision;delete next.cursor['offset:'+m.id+':'+m.revision];}else next.cursor['offset:'+m.id+':'+m.revision]=m.textOffset+m.text.length;}next.source.analysisBatchTurn=(next.source.analysisBatchTurn||0)+1;require('./heartflow-compact').saveMemory(next,result,context,now());next.source.analysisError='';next.source.lastAnalysis=now();next.source.analysisFailures=0;next.source.analysisRetryAt=0;});await followups(undefined,false,automatic);await verify(undefined,false,automatic);return {created};
    }catch(e){if(e.code==='ANALYSIS_PAUSED')return {paused:true};store.transaction(s=>{s.source.analysisError=errorText(e);s.source.analysisFailures=(s.source.analysisFailures||0)+1;s.source.analysisRetryAt=e.code==='BUDGET_EXHAUSTED'?0:now()+Math.min(3600000,60000*2**Math.min(s.source.analysisFailures,6));});throw e;}finally{analyzing=false;}
  }
  async function deliver() {
    if(dispatching)return;dispatching=true;
    try{
      for(const item of Object.values(store.snapshot().deliveries).filter(d=>d.state==='queued')){
        const d=store.claim(item.id);if(!d)continue;
        try{
          const current=store.snapshot();
          if(d.sources.some(m=>current.messages[m.id]?.revision!==m.revision||current.messages[m.id]?.deleted)){store.delivery(d.id,{state:'blocked',error:'来源消息已更新，需重新确认执行范围'});continue;}
          const result=await dispatch(d);
          store.delivery(d.id,{state:'accepted',sessionId:result.sessionId,runId:result.runId,error:''});
        }catch(e){store.delivery(d.id,{state:'unknown',error:errorText(e)+'；未自动重发，请核对原会话'});}
      }
      for(const d of Object.values(store.snapshot().deliveries).filter(d=>['accepted','running','unknown'].includes(d.state))){const status=observe(d);if(status)store.delivery(d.id,status);}
    }finally{dispatching=false;}
  }
  async function notices() {
    if(notifying)return;notifying=true;
    try {
    const s=store.snapshot();if(!notify || !s.config.notifyEnabled || !s.config.notifyUserId)return;
    if(notifyResult)for(const d of Object.values(s.deliveries).filter(d=>['completed','failed','unknown','blocked'].includes(d.state) && d.notifiedState!==d.state)){
      store.delivery(d.id,{notifiedState:d.state});
      try{await notifyResult(d,s.config);}catch(e){store.transaction(next=>{next.source.noticeError=errorText(e);});}
    }
    for(const p of Object.values(s.proposals).filter(p=>(p.state==='pending'||p.noticeMessageId) && p.notifiedVersion!==p.version)){
      store.transaction(next=>{next.proposals[p.id].notifiedVersion=p.version;next.proposals[p.id].noticeState='sending';});
      try{if((p.noticeState==='unknown'||p.noticeState==='sent')&&!p.noticeMessageId)throw new Error('上次通知结果不明，需核对原卡片');const receipt=await notify(p,s.config);store.transaction(next=>{const current=next.proposals[p.id];current.noticeState='sent';if(receipt?.messageId){current.noticeMessageId=receipt.messageId;current.noticeOwner=s.config.notifyUserId;}});}
      catch(e){store.transaction(next=>{next.proposals[p.id].noticeState='unknown';next.source.noticeError=errorText(e)+'；未自动重发通知';});}
    }
    }finally{notifying=false;}
  }
  async function tick() {if(store.snapshot().config.enabled){try{const result=await sync({automatic:true});if(result.ok && store.snapshot().config.modelEnabled && (store.snapshot().source.analysisRetryAt||0)<=now())await suggest({automatic:true});}catch{}}await deliver();await notices();}
  return {sync,suggest,deliver,notices,verify,followups,status:()=>({polling,analyzing,dispatching,usage:require('./heartflow-budget').usageStatus(store.snapshot(),now())}),start(){if(timer)return;const schedule=()=>{timer=setTimeout(async()=>{await tick().catch(()=>{});schedule();},Math.max(30,store.snapshot().config.intervalSeconds)*1000);timer.unref();};schedule();},stop(){clearTimeout(timer);timer=null;},
    async review(id,input){
      if(input.decision==='approve'){
        if(history && input.draft && JSON.stringify(input.draft.actions)!==JSON.stringify(store.snapshot().proposals[id]?.actions))throw new Error('请先保存修改，再确认执行，以便核对修改后的范围');
        await followups(id,true);
        await verify(id,true);
        const p=store.snapshot().proposals[id],draft=input.draft||p;if(!draft)throw new Error('建议不存在');
        if(p.sourceChanged&&['changed','cancelled'].includes(p.topic?.status))throw new Error('话题已改变行动范围，请先核对并保存行动，再确认执行');
        const all=await sessions();for(const a of draft.actions||[]){if(input.actionIds&&!input.actionIds.includes(a.id))continue;if(a.sessionId){const target=all.find(s=>s.id===a.sessionId);if(!target)throw new Error('目标会话不在当前可访问列表，请刷新后改派');if(a.machineId!==target.machineId || a.cwd!==target.project || a.engine!==target.engine)throw new Error('目标会话的位置或引擎已变化，请重新选择会话');}}
      }
      const p=store.review(id,input);if(input.decision==='approve')setImmediate(()=>deliver().catch(()=>{}));return p;
    },
  };
}
module.exports={createHeartflow};
