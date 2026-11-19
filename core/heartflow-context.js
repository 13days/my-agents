// Candidate retrieval is deliberately broader than topic membership. The model must
// establish a concrete connection before using a candidate as decision evidence.
function topicContext(sources,state) {
  sources=sources.filter(Boolean);
  if(!sources.length)return [];
  const selected=new Set((state.config.chats||[]).map(c=>c.id));
  const all=Object.values(state.messages).filter(m=>!m.deleted&&(!selected.size||selected.has(m.chatId))).sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id));
  const chats=new Set(sources.map(m=>m.chatId));
  const keys=new Set(sources.flatMap(m=>[m.id,m.parentId,m.threadId].filter(Boolean).map(id=>m.chatId+':'+id)));
  const linked=new Set(sources.map(m=>m.id));
  for(let i=0;i<5;i++)for(const m of all)if([m.id,m.parentId,m.threadId].some(id=>id&&keys.has(m.chatId+':'+id))){linked.add(m.id);for(const id of [m.id,m.parentId,m.threadId].filter(Boolean))keys.add(m.chatId+':'+id);}
  const links=text=>(text.match(/https?:\/\/[^\s<>"，。]+/g)||[]).filter(url=>{try{return new URL(url).pathname.length>1;}catch{return false;}});
  const urls=new Set(sources.flatMap(m=>links(m.text)));
  const cross=all.filter(m=>!chats.has(m.chatId)&&links(m.text).some(url=>urls.has(url))).slice(-20);
  const latest=Math.max(...all.filter(m=>chats.has(m.chatId)).map(m=>m.createdAt),...sources.map(m=>m.createdAt));
  const floor=Math.max(Math.min(...sources.map(m=>m.createdAt))-30*60000,latest-7*86400000);
  const nearby=all.filter(m=>chats.has(m.chatId)&&m.createdAt>=floor&&!linked.has(m.id)).slice(-80);
  const explicit=all.filter(m=>linked.has(m.id)&&!sources.some(s=>s.id===m.id)).slice(-60);
  const picked=new Map(sources.map(m=>[m.id,m]));
  for(const m of [...explicit,...cross,...nearby])if(picked.size<150)picked.set(m.id,m);
  return [...picked.values()].sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id));
}
module.exports={topicContext};
