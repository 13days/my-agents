const { execFile } = require('child_process');
function createPersonalFeishu({ cli = process.env.BYTEDCLI || 'bytedcli', execute = execFile } = {}) {
  function call(args) {
    return new Promise((resolve,reject)=>execute(cli,['--json','feishu',...args],{timeout:45000,maxBuffer:8*1024*1024},(error,stdout)=>{
      let result;try{result=JSON.parse(stdout);}catch{return reject(new Error(error?.code==='ENOENT'?'本机未安装 bytedcli，请先安装并完成飞书用户授权':'飞书命令未返回有效 JSON，请检查用户授权'));}
      if(error || result.status!=='success' || result.error) return reject(new Error(String(result.error?.message || result.error || '飞书读取失败，请检查用户身份和消息读取权限').slice(0,1000)));
      resolve(result.data);
    }));
  }
  return {
    recent:(floor,upper,pageToken)=>call(['im','messages','search','--body-json',JSON.stringify({query:'',filter:{from_create_time:String(Math.floor(floor/1000)),to_create_time:String(Math.ceil(upper/1000))}}),'--page-size','50',...(pageToken?['--page-token',pageToken]:[])]),
    reactions:id=>new Promise((resolve,reject)=>execute(cli,['--json','lark','im','reactions','list','--message-id',id,'--user-id-type','open_id','--as','user','--page-size','50'],{timeout:45000,maxBuffer:1024*1024},(error,stdout)=>{
      let r;try{r=JSON.parse(stdout);}catch{return reject(new Error('表情回应接口未返回有效 JSON'));}
      if(error||r.error||r.code)return reject(new Error(r.error?.message||r.msg||'无法读取表情回应，请检查用户授权 im:message.reactions:read'));
      const data=r.data||r;
      if(!Array.isArray(data.items))return reject(new Error('表情回应接口未返回完整列表'));
      resolve(data);
    })),
    identity:()=>call(['user','get']),
    messages:ids=>call(['im','messages','mget','--message-ids',ids.join(',')]),
    search:query=>call(['chat','search','--query',String(query).slice(0,100)]),
    async page(chatId, pageToken) { return call(['im','messages','get','--chat-id',chatId,'--page-size','50','--sort-rule','ByCreateTimeDesc',...(pageToken?['--page-token',pageToken]:[])]); },
  };
}
function normalizeMessage(m) {
  let body;try{body=JSON.parse(m.body?.content || '{}');}catch{body={text:m.body?.content || ''};}
  function extract(x) { if(typeof x==='string')return x; if(Array.isArray(x))return x.map(extract).filter(Boolean).join('\n'); if(!x || typeof x!=='object')return ''; if(x.text)return x.text; if(x.tag==='img')return '[图片，需查看原消息]'; if(x.title || x.content)return [x.title,extract(x.content)].filter(Boolean).join('\n'); return Object.values(x).map(extract).filter(Boolean).join('\n'); }
  let text=extract(body); for(const mention of m.mentions || [])text=text.split(mention.key).join('@'+mention.name);
  return {identityEnriched:true,mentionNames:(m.mentions||[]).filter(x=>x.id&&x.name).map(x=>({id:typeof x.id==='object'?x.id.open_id:x.id,name:x.name})),id:m.message_id,chatId:m.chat_id,chatName:m.chat_default_name || m.chat_id,chatType:m.chat_type,senderId:m.sender?.id || '',senderType:m.sender?.sender_type || m.sender?.type || '',senderName:m.sender?.name || m.sender?.id || '',text:text.slice(0,16000),type:m.msg_type,deleted:!!m.deleted,createdAt:Number(m.create_time),updatedAt:Number(m.update_time || m.create_time),parentId:m.parent_id || '',threadId:m.thread_id || m.root_id || '',mentions:(m.mentions||[]).map(x=>x.id),chatUrl:'https://applink.feishu.cn/client/chat/open?openChatId='+encodeURIComponent(m.chat_id)};
}
module.exports={createPersonalFeishu,normalizeMessage};
