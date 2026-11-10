const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),path=require('path'),os=require('os'),vm=require('vm'),{execFileSync}=require('child_process');
const {createCodexLogins,createClaudeLogins,profileDirectories}=require('../core/login-profiles');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'my-agents-login-profiles-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
const codex=(name)=>({tokens:{access_token:'access-'+name,refresh_token:'refresh-'+name,account_id:name}});
test('Codex isolated profiles preserve the default login and update only the matching refresh grant',t=>{
 const home=fixture(t),original=JSON.stringify(codex('default')),profile=path.join(home,'my-agents-logins','second');fs.mkdirSync(profile,{recursive:true});
 fs.writeFileSync(path.join(home,'auth.json'),original);fs.writeFileSync(path.join(profile,'auth.json'),JSON.stringify(codex('second')));
 const logins=createCodexLogins({home,readDefault:()=>JSON.parse(fs.readFileSync(path.join(home,'auth.json')))});
 assert.equal(logins.readAll().length,2);logins.updated(codex('second'),codex('second-fresh'));
 assert.equal(fs.readFileSync(path.join(home,'auth.json'),'utf8'),original);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(profile,'auth.json'))),codex('second-fresh'));
 assert.equal(fs.statSync(path.join(profile,'auth.json')).mode&0o777,0o600);
 logins.updated(codex('second'),codex('must-not-overwrite'));
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(profile,'auth.json'))),codex('second-fresh'));
});
test('Claude isolated subscriptions are discovered without replacing the existing native login',t=>{
 const dir=fixture(t),profile=path.join(dir,'my-agents-logins','second');fs.mkdirSync(profile,{recursive:true});
 for(const [root,name] of [[dir,'default'],[profile,'second']]){fs.writeFileSync(path.join(root,'.credentials.json'),JSON.stringify({claudeAiOauth:{accessToken:name,refreshToken:name+'-refresh'}}));fs.writeFileSync(path.join(root,'.claude.json'),JSON.stringify({oauthAccount:{accountUuid:name}}));}
 const logins=createClaudeLogins({dir,home:dir,platform:'linux',env:{}});
 assert.deepEqual(logins.readAll().map(x=>x.accountUuid).sort(),['default','second']);assert.equal(logins.read().accountUuid,'default');
});
test('managed profile discovery includes nested login homes and excludes directory symlinks',t=>{
 const dir=fixture(t),first=path.join(dir,'my-agents-logins','first'),nested=path.join(first,'my-agents-logins','second');fs.mkdirSync(nested,{recursive:true});
 fs.symlinkSync(dir,path.join(first,'my-agents-logins','loop'));
 assert.deepEqual(profileDirectories(dir).sort(),[first,nested].sort());
});
test('the copied Codex sign-in command creates a private isolated home and leaves active auth unchanged',t=>{
 const dir=fixture(t),home=path.join(dir,'codex'),bin=path.join(dir,'bin');fs.mkdirSync(home);fs.mkdirSync(bin);const authFile=path.join(home,'auth.json');fs.writeFileSync(authFile,'original-active-auth');
 const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8'),start=html.indexOf('function poolSubscriptionCommand('),end=html.indexOf('function openPoolSubscriptionLogin(',start);
 const context={};vm.createContext(context);vm.runInContext(html.slice(start,end),context);const command=context.poolSubscriptionCommand('codex','second');
 assert.match(command,/cli_auth_credentials_store="file"/);
 fs.writeFileSync(path.join(bin,'codex'),'#!/bin/sh\nprintf "%s" "new-login" > "$CODEX_HOME/auth.json"\n',{mode:0o700});
 execFileSync('/bin/sh',['-c',command],{env:{...process.env,CODEX_HOME:home,PATH:bin+':'+process.env.PATH}});
 assert.equal(fs.readFileSync(authFile,'utf8'),'original-active-auth');assert.equal(fs.readFileSync(path.join(home,'my-agents-logins','second','auth.json'),'utf8'),'new-login');
 assert.equal(fs.statSync(path.join(home,'my-agents-logins','second')).mode&0o777,0o700);
});
