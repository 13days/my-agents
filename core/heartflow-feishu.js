const { execFile } = require('child_process');
function createPersonalFeishu({ cli = process.env.BYTEDCLI || 'bytedcli', execute = execFile } = {}) {
  function call(args) {
    return new Promise((resolve,reject)=>execute(cli,['--json','feishu',...args],{timeout:45000,maxBuffer:8*1024*1024},(error,stdout)=>{
      let result;try{result=JSON.parse(stdout);}catch{return reject(new Error(error?.code==='ENOENT'?'本机未安装 bytedcli，请先安装并完成飞书用户授权':'飞书命令未返回有效 JSON，请检查用户授权'));}
      if(error || result.status!=='success' || result.error) return reject(new Error(String(result.error?.message || result.error || '飞书读取失败，请检查用户身份和消息读取权限').slice(0,1000)));
      resolve(result.data);
    }));
  }
  async function larkGet(path, params = {}) {
    return new Promise((resolve, reject) => execute(cli, ['--json', 'lark', 'api', 'GET', path, '--as', 'user', '--params', JSON.stringify(params)], {timeout:45000,maxBuffer:1024*1024}, (error, stdout, stderr) => {
      let response;
      try { response = JSON.parse(stdout || stderr); } catch { return reject(new Error('无法调用 bytedcli lark api，请检查 lark-cli 安装和用户授权')); }
      if (error || !response.ok) return reject(new Error(response.error?.message || '飞书表情读取失败，请检查用户授权 im:message.reactions:read'));
      resolve(response.data);
    }));
  }
  async function checkReactionIdentity(selfId) {
    const who = await larkGet('/open-apis/authen/v1/user_info');
    if (!selfId || who?.open_id !== selfId) throw new Error('表情读取身份与消息来源不同，请用 bytedcli lark config 和 bytedcli lark login 选择同一飞书应用和用户，并授权 im:message.reactions:read');
  }
  return {
    recent:(floor,upper,pageToken)=>call(['im','messages','search','--body-json',JSON.stringify({query:'',filter:{from_create_time:String(Math.floor(floor/1000)),to_create_time:String(Math.ceil(upper/1000))}}),'--page-size','50',...(pageToken?['--page-token',pageToken]:[])]),
    checkReactionIdentity,
    reactions:(id,pageToken)=>larkGet('/open-apis/im/v1/messages/'+encodeURIComponent(id)+'/reactions', {
      user_id_type:'open_id', page_size:50, ...(pageToken ? {page_token:pageToken} : {})
    }),
    identity:()=>call(['user','get']),
    messages:ids=>call(['im','messages','mget','--message-ids',ids.join(',')]),
    search:query=>call(['chat','search','--query',String(query).slice(0,100)]),
    async page(chatId, pageToken) { return call(['im','messages','get','--chat-id',chatId,'--page-size','50','--sort-rule','ByCreateTimeDesc',...(pageToken?['--page-token',pageToken]:[])]); },
  };
}
function needsPersonalLogin(error) {
  return /invalid_grant|\b20064\b|refresh[_ ]token.{0,90}(?:revoked|invalid|expired)|need_user_authorization/i.test(String(error?.message || error));
}
function normalizeMessage(m) {
  let body;try{body=JSON.parse(m.body?.content || '{}');}catch{body={text:m.body?.content || ''};}
  function extract(x) { if(typeof x==='string')return x; if(Array.isArray(x))return x.map(extract).filter(Boolean).join('\n'); if(!x || typeof x!=='object')return ''; if(x.text)return x.text; if(x.tag==='img')return '[图片，需查看原消息]'; if(x.title || x.content)return [x.title,extract(x.content)].filter(Boolean).join('\n'); return Object.values(x).map(extract).filter(Boolean).join('\n'); }
  let text=extract(body); for(const mention of m.mentions || [])text=text.split(mention.key).join('@'+mention.name);
  return {identityEnriched:true,mentionNames:(m.mentions||[]).filter(x=>x.id&&x.name).map(x=>({id:typeof x.id==='object'?x.id.open_id:x.id,name:x.name})),id:m.message_id,chatId:m.chat_id,chatName:m.chat_default_name || m.chat_id,chatType:m.chat_type,senderId:m.sender?.id || '',senderType:m.sender?.sender_type || m.sender?.type || '',senderName:m.sender?.name || m.sender?.id || '',text:text.slice(0,16000),type:m.msg_type,deleted:!!m.deleted,createdAt:Number(m.create_time),updatedAt:Number(m.update_time || m.create_time),parentId:m.parent_id || '',threadId:m.thread_id || m.root_id || '',mentions:(m.mentions||[]).map(x=>x.id),chatUrl:'https://applink.feishu.cn/client/chat/open?openChatId='+encodeURIComponent(m.chat_id)};
}
module.exports={createPersonalFeishu,normalizeMessage,needsPersonalLogin};
