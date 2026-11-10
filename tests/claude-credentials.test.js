const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),path=require('path'),os=require('os');
const {createClaudeLogin,normalizeClaudeAuth,claudeAccountId,renewClaude}=require('../core/claude-credentials');
test('native Claude credentials are read without changing them; refresh CAS preserves an unrelated login', t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'my-agents-claude-auth-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'.credentials.json'),old={claudeAiOauth:{accessToken:'first-token',refreshToken:'first-refresh',expiresAt:10},otherKey:'preserve'};
 fs.writeFileSync(file,JSON.stringify(old));fs.writeFileSync(path.join(dir,'.claude.json'),JSON.stringify({oauthAccount:{accountUuid:'user-id'}}));
 const login=createClaudeLogin({dir,home:dir,platform:'linux',env:{}}),auth=login.read();
 assert.equal(auth.accountUuid,'user-id');assert.equal(fs.readFileSync(file,'utf8'),JSON.stringify(old));
 const fresh={...auth,claudeAiOauth:{accessToken:'new-token',refreshToken:'new-refresh',expiresAt:100}};
 login.updated(auth,fresh);assert.equal(JSON.parse(fs.readFileSync(file)).otherKey,'preserve');
 fs.writeFileSync(file,JSON.stringify({claudeAiOauth:{accessToken:'other-user',refreshToken:'other-refresh'}}));
 login.updated(auth,fresh);assert.equal(JSON.parse(fs.readFileSync(file)).claudeAiOauth.accessToken,'other-user');
 assert.equal(claudeAccountId(auth),claudeAccountId(fresh));
});
test('macOS subscription detection reads the native keychain without leaking secrets in errors',()=>{
 let args;
 const login=createClaudeLogin({platform:'darwin',env:{},dir:'/nonexistent',home:'/nonexistent',exec:(cmd,a)=>{assert.equal(cmd,'security');args=a;return JSON.stringify({claudeAiOauth:{accessToken:'mac-token'}});}});
 assert.equal(login.read().claudeAiOauth.accessToken,'mac-token');assert.deepEqual(args,['find-generic-password','-s','Claude Code-credentials','-w']);
 assert.throws(()=>normalizeClaudeAuth({claudeAiOauth:{accessToken:'bad\nheader'}}),/有效/);
});
test('Claude renew exchanges only the intended grant and preserves identity',async()=>{
 const auth={accountUuid:'user',claudeAiOauth:{accessToken:'old',refreshToken:'refresh',expiresAt:1}};
 const result=await renewClaude(auth,{now:()=>1000,fetchImpl:async(url,options)=>{
  assert.equal(url,'https://platform.claude.com/v1/oauth/token');assert.equal(JSON.parse(options.body).refresh_token,'refresh');
  return{ok:true,json:async()=>({access_token:'fresh',refresh_token:'rotated',expires_in:3600})};
 }});
 assert.equal(result.accountUuid,'user');assert.equal(result.claudeAiOauth.expiresAt,3601000);
});

test('custom Claude directories never borrow a different default profile identity',t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'my-agents-profiles-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const dir=path.join(home,'custom');fs.mkdirSync(dir);fs.writeFileSync(path.join(home,'.claude.json'),JSON.stringify({oauthAccount:{accountUuid:'wrong-default-user'}}));
 fs.writeFileSync(path.join(dir,'.credentials.json'),JSON.stringify({claudeAiOauth:{accessToken:'custom-token',refreshToken:'custom-refresh'}}));
 assert.equal(createClaudeLogin({dir,home,platform:'linux',env:{}}).read().accountUuid,undefined);
});
