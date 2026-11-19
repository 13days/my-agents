const { normalizeMessage } = require('./heartflow-feishu');
function createHeartflow({store,source,analyze,sessions,dispatch,observe=()=>null,notify=null,notifyResult=null,now=Date.now}) {
  let polling=false,analyzing=false,dispatching=false,timer;
  store.recover();
  const errorText=e=>String(e.message||e).slice(0,1000);
  async function sync() {
    if(polling)return {busy:true};polling=true;
    try{
      const config=store.snapshot().config;
      if(!config.chats.length)throw new Error('先选择需要监听的聊天');
      if(!config.selfId){const who=await source.identity();if(!who.user?.open_id)throw new Error('无法确认当前飞书用户身份');store.configure({selfId:who.user.open_id});}
      for(const chat of config.chats){
        let snapshot=store.snapshot(),cursor=snapshot.cursor[chat.id]||{},page=cursor.page||'',upper=cursor.upper||now(),floor=cursor.floor||Math.max(config.since,(cursor.watermark||config.since)-5*60000),finished=false;
        // Bounded pages per tick; persist continuation instead of dropping burst messages.
        for(let i=0;i<4;i++){
          const result=await source.page(chat.id,page),rows=result.messages||[];
          store.ingest(rows.filter(m=>Number(m.create_time)>=floor && Number(m.create_time)<=upper && m.msg_type!=='system').map(normalizeMessage));
          const older=rows.some(m=>Number(m.create_time)<floor);
          if(!result.has_more||older){finished=true;break;}page=result.page_token;if(!page)throw new Error('飞书分页游标缺失');
        }
        store.transaction(s=>{s.cursor[chat.id]=finished?{watermark:upper}:{page,upper,floor,watermark:cursor.watermark};});
      }
      const snapshot=store.snapshot();
      const parents=[...new Set(Object.values(snapshot.messages).filter(m=>config.chats.some(c=>c.id===m.chatId)&&m.createdAt>=config.since).map(m=>m.parentId).filter(id=>id&&!snapshot.messages[id]))].slice(0,30);
      if(parents.length && source.messages){const refs=await source.messages(parents);store.ingest((refs.messages||refs.items||[]).filter(m=>config.chats.some(c=>c.id===m.chat_id)).map(normalizeMessage));}
      store.transaction(s=>{s.source={...s.source,ok:true,lastSync:now(),error:''};});
      return {ok:true};
    }catch(e){store.transaction(s=>{s.source={...s.source,ok:false,error:errorText(e)};});throw e;}finally{polling=false;}
  }
  async function suggest() {
    if(analyzing)return {busy:true};analyzing=true;
    try{
      const s=store.snapshot(),covered=new Set(Object.values(s.proposals).flatMap(p=>p.messageIds));
      const messages=Object.values(s.messages).filter(m=>!m.deleted && m.senderId!==s.config.selfId && m.createdAt>=s.config.since && (!covered.has(m.id)||Object.values(s.proposals).some(p=>p.sourceChanged&&p.messageIds.includes(m.id))) && s.cursor['analyzed:'+m.id]!==m.revision).sort((a,b)=>a.createdAt-b.createdAt).slice(0,30);
      if(!messages.length)return {created:0};
      const catalog=(await sessions()).slice(0,100),candidates=catalog.map(x=>({id:x.id,title:x.title,engine:x.engine,machineId:x.machineId,cwd:x.project,latestPrompt:x.latestPrompt?.slice(0,600),running:x.running}));
      const chats=new Set(messages.map(m=>m.chatId));
      const learning=s.checks.filter(c=>c.learning && (Array.isArray(c.before)?c.before.flatMap(p=>p.messageIds||[]):c.before?.messageIds||[]).some(id=>chats.has(s.messages[id]?.chatId))).slice(-20).map(c=>({decision:c.decision,reason:c.reason,before:c.before,after:c.after,approvedActions:c.approvedActions}));
      const threadKeys=new Set(messages.map(m=>m.chatId+':'+m.threadId).filter(k=>!k.endsWith(':')));
      const supportingMessages=Object.values(s.messages).filter(m=>!messages.some(x=>x.id===m.id) && (messages.some(x=>x.parentId===m.id || x.chatId===m.chatId && Math.abs(x.createdAt-m.createdAt)<15*60000)||threadKeys.has(m.chatId+':'+m.threadId))).slice(-20);
      const pending=Object.values(s.proposals).filter(p=>['pending','deferred'].includes(p.state)).slice(-50).map(p=>({id:p.id,title:p.title,summary:p.summary,messageIds:p.messageIds,actions:p.actions}));
      const context={pending,supportingMessages,selfId:s.config.selfId,messages,matters:Object.values(s.matters).slice(-100),sessions:candidates,learning};
      const result=await analyze(context,s.config.model);let created=0;
      const latest=store.snapshot();if([...messages,...supportingMessages].some(m=>latest.messages[m.id]?.revision!==m.revision))throw new Error('分析期间来源消息已更新，将在下次重新分析');
      for(const draft of result.suggestions){
        if(!Array.isArray(draft.messageIds)||!draft.messageIds.length||draft.messageIds.some(id=>![...messages,...supportingMessages].some(m=>m.id===id)) || !draft.messageIds.some(id=>messages.some(m=>m.id===id)))continue;
        if((draft.matterIds||[]).some(id=>!s.matters[id]))continue;
        if(draft.relatedProposalId && pending.some(p=>p.id===draft.relatedProposalId)){
          const previous=s.proposals[draft.relatedProposalId];
          const merged=store.transaction(next=>{const p=next.proposals[previous.id];if(p.version!==previous.version || !['pending','deferred'].includes(p.state))return false;const ids=[...new Set([...p.messageIds,...draft.messageIds])];if(ids.length>30)return false;p.messageIds=ids;p.version++;p.sourceChanged=true;p.state='pending';p.updatedAt=now();return true;});
          if(merged){created++;continue;}
        }
        const actions=(draft.actions||[]).filter(a=>a.sessionId?candidates.some(c=>c.id===a.sessionId):candidates.some(c=>c.cwd===a.cwd&&c.machineId===a.machineId)).map(a=>{
          const target=candidates.find(c=>c.id===a.sessionId);return {...a,...(target?{engine:target.engine,machineId:target.machineId,cwd:target.cwd,sessionTitle:target.title}:{})};
        });
        // Never overwrite a reviewed draft. Changed sources remain visible for explicit review.
        if(draft.messageIds.every(id=>covered.has(id)))continue;
        store.draft({...draft,actions,model:result.model});created++;
      }
      store.transaction(next=>{for(const m of messages)next.cursor['analyzed:'+m.id]=m.revision;next.source.analysisError='';next.source.lastAnalysis=now();next.source.analysisFailures=0;next.source.analysisRetryAt=0;});return {created};
    }catch(e){store.transaction(s=>{s.source.analysisError=errorText(e);s.source.analysisFailures=(s.source.analysisFailures||0)+1;s.source.analysisRetryAt=now()+Math.min(3600000,60000*2**Math.min(s.source.analysisFailures,6));});throw e;}finally{analyzing=false;}
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
    const s=store.snapshot();if(!notify || !s.config.notifyEnabled || !s.config.notifyUserId)return;
    if(notifyResult)for(const d of Object.values(s.deliveries).filter(d=>['completed','failed','unknown','blocked'].includes(d.state) && d.notifiedState!==d.state)){
      store.delivery(d.id,{notifiedState:d.state});
      try{await notifyResult(d,s.config);}catch(e){store.transaction(next=>{next.source.noticeError=errorText(e);});}
    }
    for(const p of Object.values(s.proposals).filter(p=>p.state==='pending' && p.notifiedVersion!==p.version)){
      store.transaction(next=>{next.proposals[p.id].notifiedVersion=p.version;next.proposals[p.id].noticeState='sending';});
      try{await notify(p,s.config);store.transaction(next=>{next.proposals[p.id].noticeState='sent';});}
      catch(e){store.transaction(next=>{next.proposals[p.id].noticeState='unknown';next.source.noticeError=errorText(e)+'；未自动重发通知';});}
    }
  }
  async function tick() {if(store.snapshot().config.enabled){try{await sync();if(store.snapshot().config.modelEnabled && (store.snapshot().source.analysisRetryAt||0)<=now())await suggest();}catch{}}await deliver();await notices();}
  return {sync,suggest,deliver,notices,status:()=>({polling,analyzing,dispatching}),start(){if(timer)return;const schedule=()=>{timer=setTimeout(async()=>{await tick().catch(()=>{});schedule();},Math.max(30,store.snapshot().config.intervalSeconds)*1000);timer.unref();};schedule();},stop(){clearTimeout(timer);timer=null;},
    async review(id,input){
      if(input.decision==='approve'){
        const p=store.snapshot().proposals[id],draft=input.draft||p;if(!draft)throw new Error('建议不存在');
        const all=await sessions();for(const a of draft.actions||[]){if(input.actionIds&&!input.actionIds.includes(a.id))continue;if(a.sessionId){const target=all.find(s=>s.id===a.sessionId);if(!target)throw new Error('目标会话不在当前可访问列表，请刷新后改派');if(a.machineId!==target.machineId || a.cwd!==target.project || a.engine!==target.engine)throw new Error('目标会话的位置或引擎已变化，请重新选择会话');}}
      }
      const p=store.review(id,input);if(input.decision==='approve')setImmediate(()=>deliver().catch(()=>{}));return p;
    },
  };
}
module.exports={createHeartflow};
