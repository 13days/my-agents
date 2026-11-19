const bytes=x=>Buffer.byteLength(JSON.stringify(x));
const words=text=>new Set((String(text||'').toLowerCase().match(/[a-z0-9_./-]{3,}|[\p{Script=Han}]{2,}/gu)||[]).flatMap(w=>/[\p{Script=Han}]/u.test(w)?Array.from({length:Math.max(0,w.length-1)},(_,i)=>w.slice(i,i+2)):[w]));
function relevance(text,query){const terms=words(text);return [...words(query)].reduce((n,w)=>n+(terms.has(w)?1:0),0);}
function compactMessage(m){return Object.fromEntries(['id','chatId','senderId','senderName','senderType','mentions','mentionNames','createdAt','parentId','threadId','text','revision','deleted','textOffset','textComplete','reactions'].filter(k=>m[k]!==undefined).map(k=>[k,m[k]]));}
function batchMessages(unread,state){
 if(!unread.length)return [];
 const seed=(state.source.analysisBatchTurn||0)%2?unread.at(-1):unread[0];
 const candidates=unread.filter(m=>m.chatId===seed.chatId&&(seed.threadId?m.threadId===seed.threadId||m.id===seed.threadId:Math.abs(m.createdAt-seed.createdAt)<=30*60000));
 const result=[];
 for(const m of ((state.source.analysisBatchTurn||0)%2?candidates.slice(-12):candidates.slice(0,12))){
   const offset=state.cursor['offset:'+m.id+':'+m.revision]||0;
   const slice={...compactMessage(m),text:m.text.slice(offset,offset+3000),textOffset:offset,textComplete:offset+3000>=m.text.length};
   if(result.length&&bytes([...result,slice])>16000)break;
   result.push(slice);
 }
 return result;
}
function topicKey(messages){const first=messages[0];return JSON.stringify([first.chatId,first.threadId||Math.floor(first.createdAt/(30*60000))]);}
function validMemories(state,messages){
 const chats=new Set(messages.map(m=>m.chatId));
 return Object.values(state.topicMemories||{}).filter(m=>chats.has(m.chatId)&&m.refs.every(r=>state.messages[r.id]?.revision===r.revision&&!state.messages[r.id]?.deleted)).sort((a,b)=>b.at-a.at).slice(0,3).map(m=>({summary:m.summary,refs:m.refs,at:m.at}));
}
function suggestionContext(state,messages,support,candidates){
 const query=messages.map(m=>m.text).join('\n'),chats=new Set(messages.map(m=>m.chatId));
 const related=p=>(p.messageIds||[]).some(id=>chats.has(state.messages[id]?.chatId))||relevance(p.title+' '+p.summary,query)>2;
 const proposals=Object.values(state.proposals).filter(related).sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,8);
 const context={selfId:state.config.selfId,messages,topicMemories:validMemories(state,messages),supportingMessages:[],sessions:[],pending:[],recentTopics:[],learning:[],matters:[]};
 while(bytes(context)>24000&&context.topicMemories.length)context.topicMemories.pop();
 const add=(field,item)=>{context[field].push(item);if(bytes(context)>40000){context[field].pop();return false;}return true;};
 for(const m of support){if(bytes(context.supportingMessages)+bytes(m)>10000)continue;add('supportingMessages',compactMessage(m));}
 for(const x of candidates.map(x=>({x,score:relevance(x.title+' '+x.cwd+' '+x.latestPrompt,query)})).sort((a,b)=>b.score-a.score).slice(0,12))add('sessions',{...x.x,latestPrompt:x.x.latestPrompt?.slice(0,240)});
 for(const p of proposals){add('recentTopics',{id:p.id,title:p.title,state:p.state,summary:(p.topic?.summary||p.summary).slice(0,600)});if(['pending','deferred'].includes(p.state))add('pending',{id:p.id,title:p.title,summary:p.summary.slice(0,600),messageIds:p.messageIds,actions:p.actions});}
 for(const c of state.checks.filter(c=>c.learning&&(Array.isArray(c.before)?c.before:[c.before]).some(p=>p&&related(p))).slice(-5))add('learning',{decision:c.decision,reason:c.reason,before:{title:c.before?.title},approvedActions:c.approvedActions,after:{title:c.after?.title,actions:c.after?.actions}});
 for(const m of Object.values(state.matters).filter(m=>relevance(m.title+' '+m.description,query)>0).slice(0,8))add('matters',m);
 return context;
}
function saveMemory(state,result,context,now){
 const m=result.memory,ids=m?.evidenceMessageIds;
 if(typeof m?.summary!=='string'||!m.summary.trim()||!Array.isArray(ids)||!ids.length||ids.length>30)return;
 const sources=[...context.messages,...context.supportingMessages];
 if(ids.some(id=>!sources.some(s=>s.id===id)))return;
 const refs=[...new Map([...context.topicMemories.flatMap(m=>m.refs),...ids.map(id=>({id,revision:state.messages[id].revision}))].map(r=>[r.id,r])).values()];
 state.topicMemories??={};
 if(refs.length>200){delete state.topicMemories[topicKey(context.messages)];return;}
 state.topicMemories[topicKey(context.messages)]={chatId:context.messages[0].chatId,summary:m.summary.slice(0,1500),refs,at:now};
 const keys=Object.keys(state.topicMemories).sort((a,b)=>state.topicMemories[b].at-state.topicMemories[a].at);
 for(const key of keys.slice(200))delete state.topicMemories[key];
}
module.exports={compactMessage,batchMessages,suggestionContext,saveMemory,relevance};
