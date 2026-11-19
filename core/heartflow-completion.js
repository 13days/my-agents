// Refresh quiet conversations too: a reaction does not advance message create_time.
async function refresh({store,source,now=Date.now}) {
  const state=store.snapshot();
  const ps=Object.values(state.proposals).filter(p=>['pending','deferred'].includes(p.state)||p.completion?.source==='conversation');
  const chats=[...new Set(ps.map(p=>p.messageIds.map(id=>state.messages[id]?.chatId)).flat().filter(Boolean))]
    .sort((a,b)=>(state.cursor['followup-chat:'+a]||0)-(state.cursor['followup-chat:'+b]||0));
  if(source.page)for(const chat of chats.filter(c=>now()-(state.cursor['followup-chat:'+c]||0)>600000).slice(0,2)){
    const result=await source.page(chat,'');
    store.ingest((result.messages||[]).map(require('./heartflow-feishu').normalizeMessage));
    store.transaction(s=>{s.cursor['followup-chat:'+chat]=now();});
  }
  if(!source.reactions||now()<(state.source.reactionRetryAt||0))return;
  const ids=[...new Set(ps.flatMap(p=>p.messageIds))].filter(id=>state.messages[id]&&!state.messages[id].deleted)
    .sort((a,b)=>(state.cursor['reactions:'+a]||0)-(state.cursor['reactions:'+b]||0));
  for(const id of ids.filter(id=>now()-(state.cursor['reactions:'+id]||0)>600000).slice(0,10)){
    try{
      const result=await source.reactions(id);
      if(result.has_more)throw new Error('表情回应分页未完整读取，保留原记录');
      const reactions=(result.items||[]).sort((a,b)=>String(a.reaction_id).localeCompare(String(b.reaction_id)));
      store.transaction(s=>{
        const m=s.messages[id];if(!m)return;
        if(JSON.stringify(m.reactions||[])!==JSON.stringify(reactions)){
          m.reactions=reactions;m.revision++;
          for(const p of Object.values(s.proposals))if(p.messageIds.includes(id)){
            if(p.state==='completed'&&p.completion?.source==='conversation'){
              p.previousCompletion=p.completion;delete p.completion;p.actions=p.completionActions||[];delete p.completionActions;p.state='pending';
            }
            if(['pending','deferred'].includes(p.state)){p.version++;p.sourceChanged=true;delete p.followupFingerprint;p.lastFollowupCheck=0;}
          }
        }
        s.cursor['reactions:'+id]=now();s.source.reactionError='';s.source.reactionRetryAt=0;
      });
    }catch(e){store.transaction(s=>{s.source.reactionError=String(e.message).slice(0,500);s.source.reactionRetryAt=now()+600000;});break;}
  }
}
module.exports={refresh};
