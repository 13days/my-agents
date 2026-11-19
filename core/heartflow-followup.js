const {createHash}=require('crypto');
function relatedMessages(p,state) {
  const sources=p.messageIds.map(id=>state.messages[id]).filter(Boolean);
  const keys=new Set(sources.flatMap(m=>[m.id,m.parentId,m.threadId].filter(Boolean).map(id=>m.chatId+':'+id)));
  const related=new Set(sources.map(m=>m.id));
  const all=Object.values(state.messages).filter(m=>!m.deleted).sort((a,b)=>a.createdAt-b.createdAt);
  // Follow explicit reply chains in either arrival order, without merging unrelated group topics.
  for(let i=0;i<5;i++)for(const m of all)if([m.id,m.parentId,m.threadId].some(id=>id&&keys.has(m.chatId+':'+id))){related.add(m.id);for(const id of [m.id,m.parentId,m.threadId].filter(Boolean))keys.add(m.chatId+':'+id);}
  return all.filter(m=>related.has(m.id)).slice(-100);
}
async function inspectFollowup(p,state,analyze,force=false) {
  const messages=relatedMessages(p,state);
  if(!messages.length||!p.actions.length)return null;
  const fingerprint=createHash('sha256').update(JSON.stringify([p.actions,messages])).digest('hex');
  if(!force&&p.followupFingerprint===fingerprint)return null;
  const result=await analyze({mode:'followup',selfId:state.config.selfId,proposal:p,messages},state.config.model);
  const resolutions=[];
  const floor=Math.min(...p.messageIds.map(id=>state.messages[id]?.createdAt).filter(Number.isFinite));
  for(const r of result.resolutions||[]){
    const action=p.actions.find(a=>a.id===r.actionId);
    if(!action||r.status!=='superseded')continue;
    const evidence=(r.evidence||[]).map(e=>{const m=messages.find(m=>m.id===e.messageId);return m&&m.createdAt>=floor&&m.senderId&&m.senderType!=='app'&&typeof e.quote==='string'&&e.quote.trim().length>=8&&m.text.includes(e.quote)?{id:m.id,source:'feishu',senderId:m.senderId,senderName:m.senderName,chatId:m.chatId,timestamp:new Date(m.createdAt).toISOString(),quote:e.quote}:null;});
    if(!evidence.length||evidence.some(e=>!e))continue;
    resolutions.push({actionId:action.id,sessionId:action.sessionId,status:'superseded',reason:String(r.reason||'').slice(0,2000),evidence});
  }
  return {fingerprint,resolutions,messages};
}
module.exports={inspectFollowup,relatedMessages};
