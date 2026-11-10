const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {createClaudeLogin}=require('./claude-credentials');
const PROFILE_DIRECTORY='my-agents-logins';
function profileDirectories(base) {
 const found=[],pending=[base];
 while(pending.length && found.length<256) {
  const parent=pending.shift();let rows=[];try{rows=fs.readdirSync(path.join(parent,PROFILE_DIRECTORY),{withFileTypes:true});}catch{}
  for(const row of rows)if(row.isDirectory()&&/^[\w.-]{1,80}$/.test(row.name)) {
   const dir=path.join(parent,PROFILE_DIRECTORY,row.name);found.push(dir);pending.push(dir);if(found.length===256)break;
  }
 }
 return found;
}
function createCodexLogins({home,readDefault=()=>null}) {
 const read=dir=>{try{return JSON.parse(fs.readFileSync(path.join(dir,'auth.json'),'utf8'));}catch{return null;}};
 const readAll=()=>[readDefault(),...profileDirectories(home).map(read)].filter(Boolean);
 function updated(previous,fresh) {
  if(!previous?.tokens?.refresh_token)return;
  for(const dir of [home,...profileDirectories(home)]) {
   const current=read(dir);if(current?.tokens?.refresh_token!==previous.tokens.refresh_token)continue;
   const file=path.join(dir,'auth.json'),temporary=file+'.'+crypto.randomUUID()+'.tmp';
   try {fs.writeFileSync(temporary,JSON.stringify(fresh,null,2)+'\n',{mode:0o600,flag:'wx'});fs.renameSync(temporary,file);}finally{fs.rmSync(temporary,{force:true});}
  }
 }
 return {readAll,updated};
}
function createClaudeLogins({dir,login=null,env=process.env,home,platform}) {
 login ||= createClaudeLogin({dir,env,home,platform});
 const profiles=new Map();
 const handlers=()=>[login,...profileDirectories(dir).map(target=>{
  if(!profiles.has(target))profiles.set(target,createClaudeLogin({dir:target,env:{...env,CLAUDE_CONFIG_DIR:target},home,platform,pollMs:30000}));
  return profiles.get(target);
 })];
 return {read:()=>login.read(),readAll:()=>handlers().map(handler=>handler.read()).filter(Boolean),updated:async(previous,fresh)=>{await Promise.all(handlers().filter(handler=>handler.read()?.claudeAiOauth?.refreshToken===previous?.claudeAiOauth?.refreshToken).map(handler=>handler.updated(previous,fresh)));}};
}
module.exports={PROFILE_DIRECTORY,profileDirectories,createCodexLogins,createClaudeLogins};
