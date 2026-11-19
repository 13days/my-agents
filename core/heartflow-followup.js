const {createHash}=require('crypto');
const {topicContext}=require('./heartflow-context');
function relatedMessages(p,state) {return topicContext(p.messageIds.map(id=>state.messages[id]),state);}
async function inspectFollowup(p,state,analyze,force=false,now=Date.now()) {
  if(!force && p.lastFollowupCheck && now-p.lastFollowupCheck<(state.config.checkIntervalSeconds??600)*1000)return null;
  const messages=relatedMessages(p,state);
  if(!messages.length)return null;
  const fingerprint=createHash('sha256').update(JSON.stringify(['responsibility-v1',p.actions,messages])).digest('hex');
  if(!force&&p.followupFingerprint===fingerprint)return null;
  const result=await analyze({mode:'followup',selfId:state.config.selfId,proposal:{id:p.id,title:p.title,summary:p.summary,actions:p.actions,state:p.state,completion:p.completion},messages:messages.map(require('./heartflow-compact').compactMessage)},state.config.model);
  const resolutions=[];
  const floor=Math.min(...p.messageIds.map(id=>state.messages[id]?.createdAt).filter(Number.isFinite));
  for(const r of result.resolutions||[]){
    const action=p.actions.find(a=>a.id===r.actionId);
    if(!action||r.status!=='superseded')continue;
    const evidence=(r.evidence||[]).map(e=>{const m=messages.find(m=>m.id===e.messageId);return m&&m.createdAt>=floor&&m.senderId&&m.senderType!=='app'&&typeof e.quote==='string'&&e.quote.trim().length>=8&&m.text.includes(e.quote)?{id:m.id,source:'feishu',senderId:m.senderId,senderName:m.senderName,chatId:m.chatId,timestamp:new Date(m.createdAt).toISOString(),quote:e.quote}:null;});
    if(!evidence.length||evidence.some(e=>!e))continue;
    resolutions.push({actionId:action.id,sessionId:action.sessionId,status:'superseded',reason:String(r.reason||'').slice(0,2000),evidence});
  }
  let topic=null;
  const t=result.topic;
  if(t&&['discussing','decided','changed','cancelled','reported_complete'].includes(t.status)&&typeof t.summary==='string'&&t.summary.trim()){
    const evidence=(t.evidence||[]).map(e=>{const m=messages.find(m=>m.id===e.messageId);return m&&typeof e.quote==='string'&&e.quote.trim().length>=8&&m.text.includes(e.quote)?{id:m.id,source:'feishu',senderId:m.senderId,senderName:m.senderName,chatId:m.chatId,timestamp:new Date(m.createdAt).toISOString(),quote:e.quote}:null;});
    if(evidence.length&&evidence.length<=10&&evidence.every(Boolean))topic={status:t.status,summary:t.summary.slice(0,3000),evidence};
  }
  // Closing a follow-up is a report about this scope, never proof of code execution.
  let completion=null;
  const c=result.completion||result.reopen;
  if(c?.scope==='entire_proposal' && typeof c.reason==='string' && c.reason.trim()){
    const evidence=(c.evidence||[]).map(e=>{
      const m=messages.find(m=>m.id===e.messageId);
      if(!m||m.deleted||m.createdAt<floor)return null;
      if(e.reactionId){
        const r=(m.reactions||[]).find(r=>r.reaction_id===e.reactionId);
        if(!r||r.reaction_type?.emoji_type!=='DONE'||r.operator?.type!=='user'||!r.operator.operator_id)return null;
        return {id:m.id,revision:m.revision,source:'feishu_reaction',reactionId:r.reaction_id,senderId:r.operator.operator_id,quote:'DONE',timestamp:r.action_time};
      }
      if(!m.senderId||m.senderType==='app'||typeof e.quote!=='string'||e.quote.trim().length<2||!m.text.includes(e.quote))return null;
      return {id:m.id,revision:m.revision,source:'feishu',senderId:m.senderId,senderName:m.senderName,quote:e.quote,timestamp:new Date(m.createdAt).toISOString()};
    });
    if(evidence.length&&evidence.length<=10&&evidence.every(Boolean))completion={source:'conversation',reason:c.reason.slice(0,2000),evidence};
  }
  let exclusion=null;
  const x=result.exclusion;
  if(state.config.selfId&&x?.scope==='entire_proposal'&&x.kind==='delegated_others'&&typeof x.reason==='string'&&x.reason.trim()){
    const evidence=(x.evidence||[]).map(e=>{const m=messages.find(m=>m.id===e.messageId);return m&&!m.deleted&&m.senderId===state.config.selfId&&typeof e.quote==='string'&&e.quote.trim().length>=2&&m.text.includes(e.quote)?{id:m.id,revision:m.revision,senderId:m.senderId,quote:e.quote}:null;});
    if(evidence.length&&evidence.length<=10&&evidence.every(Boolean))exclusion={kind:x.kind,reason:x.reason.slice(0,2000),evidence};
  }
  return {fingerprint,resolutions,messages,topic,exclusion,completion:result.completion?completion:null,reopen:result.reopen&&!result.completion?completion:null};
}
module.exports={inspectFollowup,relatedMessages};
