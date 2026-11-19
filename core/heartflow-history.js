const {createHash}=require('crypto');
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
// Evidence is retained with the decision; a model assertion alone cannot close a proposal.
async function inspectProposal(p, state, history, analyze, force=false,now=Date.now()) {
  if(!force && p.lastHistoryCheck && now-p.lastHistoryCheck<(state.config.checkIntervalSeconds??600)*1000)return null;
  const ids=[...new Set(p.actions.map(a=>a.sessionId).filter(Boolean))];
  if(!ids.length)return null;
  const transcripts=[];
  for(const id of ids){
    const target=p.actions.find(a=>a.sessionId===id),result=await history(id,target.machineId);
    if(!result || result.checkpoint)throw new Error('无法读取目标会话的实时记录，请稍后核对');
    transcripts.push({sessionId:id,messages:(result.messages||[]).filter(m=>['user','assistant'].includes(m.role)&&m.text).slice(-80).map(m=>({id:hash([id,m.role,m.timestamp,m.text]),role:m.role,timestamp:m.timestamp,text:m.text.slice(0,12000)}))});
  }
  const sources=p.messageIds.map(id=>state.messages[id]);
  // Recent turns plus relevant request/answer pairs, instead of resending 80 turns.
  if(!force)for(const transcript of transcripts){
    const rows=transcript.messages,selected=new Set(rows.slice(-4).map(m=>m.id));
    const query=p.actions.map(a=>a.prompt).join(' ');
    const ranked=rows.map((m,i)=>({i,score:require('./heartflow-compact').relevance(m.text,query)})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,4);
    for(const {i} of ranked)for(const m of rows.slice(Math.max(0,i-1),i+2))selected.add(m.id);
    transcript.messages=rows.filter(m=>selected.has(m.id));
  }
  const fingerprint=hash([p.actions,sources,transcripts]);
  if(!force && p.historyFingerprint===fingerprint)return null;
  const result=await analyze({mode:'verify',selfId:state.config.selfId,proposal:{id:p.id,title:p.title,summary:p.summary,actions:p.actions},messages:sources.map(require('./heartflow-compact').compactMessage),transcripts},state.config.model);
  const resolutions=[];
  for(const r of result.resolutions||[]){
    const action=p.actions.find(a=>a.id===r.actionId&&a.sessionId===r.sessionId);
    if(!action || !['in_progress','completed','superseded'].includes(r.status))continue;
    const transcript=transcripts.find(t=>t.sessionId===r.sessionId);
    const evidence=(r.evidence||[]).map(e=>{const m=transcript.messages.find(m=>m.id===e.messageId);return m && typeof e.quote==='string'&&e.quote.trim().length>=4&&m.text.includes(e.quote)&&Date.parse(m.timestamp)>=Math.min(...sources.map(s=>s.createdAt))?{...m,text:undefined,quote:e.quote}:null;});
    if(!evidence.length||evidence.some(e=>!e)||!evidence.some(e=>e.role==='user'&&e.quote.trim().length>=8)||(r.status==='completed'&&!evidence.some(e=>e.role==='assistant')))continue;
    resolutions.push({actionId:action.id,sessionId:r.sessionId,status:r.status,reason:String(r.reason||'').slice(0,2000),evidence});
  }
  return {fingerprint,resolutions};
}
module.exports={inspectProposal};
