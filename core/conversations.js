const fs = require('fs'), path = require('path'), crypto = require('crypto');
// Bounded, portable checkpoints. Native CLI files and worktrees stay on their machines.
function createConversations({ dir, publish = () => {} }) {
  const file = path.join(dir, 'panel-conversations.json');
  let timer;
  let cached = {}, revision = '';
  const pending = new Map();
  const read = () => { try { const st=fs.statSync(file), next=st.mtimeMs+':'+st.size; if(next!==revision){cached=JSON.parse(fs.readFileSync(file,'utf8'));revision=next;} return {...cached}; } catch (e) { if (e.code === 'ENOENT') return {}; throw e; } };
  const get = id => pending.get(id) || read()[id];
  function merge(record) {
    if (!record || typeof record.id !== 'string' || !/^[\w-]{8,100}$/.test(record.id)) throw Error('会话检查点无效');
    const all = read(), old = all[record.id];
    if (old && old.updatedAt > record.updatedAt) return;
    all[record.id] = record;
    const sorted = Object.values(all).sort((a,b) => b.updatedAt - a.updatedAt).slice(0,1000);
    let budget = 0;
    for (const row of sorted) { budget += Buffer.byteLength(JSON.stringify(row)); if (budget > 2 * 1024 * 1024) row.messages = []; }
    const tmp = file + '.' + crypto.randomUUID() + '.tmp'; fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(sorted.map(row=>[row.id,row]))),{mode:0o600});fs.renameSync(tmp,file);revision='';
  }
  function flush() { clearTimeout(timer); timer = null; for (const record of pending.values()) { merge(record); Promise.resolve(publish(record)).catch(()=>{}); } pending.clear(); }
  function put(id, patch) {
    const record = { ...get(id), ...patch, id, updatedAt:Date.now() }; pending.set(id,record);
    if (!timer) { timer=setTimeout(flush,1000);timer.unref?.(); } return record;
  }
  function record(id,event,data) {
    const row=get(id); if(!row)return;
    const messages=(row.messages||[]).map(item=>({...item}));
    const key=data.messageId||data.id||'turn';
    if(event==='input') messages.push({role:'user',id:key,text:String(data.prompt||'').slice(0,1500),timestamp:data.timestamp});
    if(event==='text') {let reply=messages.findLast(item=>item.role==='assistant'&&item.id===key);if(!reply){reply={role:'assistant',id:key,text:'',timestamp:data.timestamp};messages.push(reply)}reply.text=(reply.text+(data.text||'')).slice(-2500);}
    if(['input','text','done','error','stopped','end'].includes(event)) put(id,{messages:messages.slice(-12),state:event==='done'?(data.isError?'interrupted':'completed'):event==='end'&&row.state==='completed'?'completed':['error','stopped','end'].includes(event)?'interrupted':'running'});
    if (['done','error','stopped'].includes(event)) flush();
  }
  return { get, put, merge, read, record, flush };
}
module.exports={createConversations};
