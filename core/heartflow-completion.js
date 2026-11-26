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
  let identityChecked = false;
  for(const id of ids.filter(id=>now()-(state.cursor['reactions:'+id]||0)>600000).slice(0,10)){
    try{
      if (!identityChecked) {
        await source.checkReactionIdentity?.(state.config.selfId);
        identityChecked = true;
      }
      const byId = new Map(), tokens = new Set();
      let token;
      do {
        const result = await source.reactions(id, token);
        if (!Array.isArray(result?.items)) throw new Error('表情回应接口未返回完整列表');
        for (const item of result.items) {
          if (!item.reaction_id) throw new Error('表情回应缺少 ID');
          byId.set(item.reaction_id, item);
        }
        token = result.has_more ? result.page_token : null;
        if (result.has_more && (!token || tokens.has(token) || tokens.size >= 19)) throw new Error('表情回应分页未完整读取，保留原记录');
        tokens.add(token);
      } while (token);
      const reactions = [...byId.values()].sort((a,b)=>String(a.reaction_id).localeCompare(String(b.reaction_id)));
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
