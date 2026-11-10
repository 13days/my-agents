const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex');
function normalizeClaudeAuth(input) {
  if (!input || typeof input!=='object' || Array.isArray(input) || Buffer.byteLength(JSON.stringify(input))>100000) throw new Error('请选择有效的 Claude Code 订阅登录文件');
  const token = input?.claudeAiOauth || input;
  if (!token || typeof token.accessToken !== 'string' || !token.accessToken || /[\r\n]/.test(token.accessToken)) throw new Error('请选择有效的 Claude Code 订阅登录文件');
  if (token.refreshToken && (typeof token.refreshToken!=='string' || /[\r\n]/.test(token.refreshToken))) throw new Error('Claude 刷新凭证无效');
  if (token.expiresAt !== undefined && (!Number.isFinite(token.expiresAt) || token.expiresAt<0)) throw new Error('Claude 凭证有效期无效');
  return { claudeAiOauth: { ...token }, ...(input.accountUuid ? { accountUuid: input.accountUuid } : {}), ...(input.emailAddress ? { emailAddress: input.emailAddress } : {}) };
}
function claudeAccountId(auth) {
  let subject = auth.accountUuid || auth.claudeAiOauth.accountUuid;
  try { subject ||= JSON.parse(Buffer.from(auth.claudeAiOauth.accessToken.split('.')[1], 'base64url')).sub; } catch {}
  return 'claude-sub:' + digest(subject || auth.claudeAiOauth.refreshToken || auth.claudeAiOauth.accessToken);
}
const available = (auth, now = Date.now()) => !!auth?.claudeAiOauth?.accessToken && (!auth.claudeAiOauth.expiresAt || auth.claudeAiOauth.expiresAt > now);
const expiresSoon = (auth, now = Date.now()) => !!auth?.claudeAiOauth?.expiresAt && auth.claudeAiOauth.expiresAt < now + 5 * 60 * 1000;
function createClaudeLogin({ dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), home = os.homedir(), platform = process.platform, env = process.env, exec = null, now = Date.now, pollMs = 5000 } = {}) {
  const file = path.join(dir, '.credentials.json');
  const suffix=env.CLAUDE_CONFIG_DIR ? digest(dir).slice(0,8) : '';
  const services=suffix ? ['Claude Code-credentials-'+suffix,'Claude Code-'+suffix+'-credentials'] : ['Claude Code-credentials'];
  let service=services[0],storage='file';
  let cached = null, checked = -Infinity, reading = null, marker='';
  function local() { try { return JSON.parse(fs.readFileSync(file,'utf8')); } catch { return env.CLAUDE_CODE_OAUTH_TOKEN ? {claudeAiOauth:{accessToken:env.CLAUDE_CODE_OAUTH_TOKEN}} : null; } }
  function enrich(raw) {
    if (!raw?.claudeAiOauth) return null;
    let account;
    for (const target of [path.join(dir,'.claude.json'),...(path.resolve(dir)===path.join(home,'.claude') ? [path.join(home,'.claude.json')] : [])]) { try { account=JSON.parse(fs.readFileSync(target,'utf8')).oauthAccount; if(account)break; } catch {} }
    try { return normalizeClaudeAuth({...raw,accountUuid:account?.accountUuid || raw.accountUuid,emailAddress:account?.emailAddress || raw.emailAddress}); } catch { return null; }
  }
  function keychain() {
    if (reading) return reading;
    reading=(async()=>{
      for (const candidate of services) {
        const raw=await new Promise(resolve=>execFile('security',['find-generic-password','-s',candidate,'-w'],{encoding:'utf8',timeout:2000},(error,stdout)=>{try{resolve(!error?JSON.parse(stdout):null);}catch{resolve(null);}}));
        const auth=enrich(raw);if(auth){service=candidate;storage='keychain';return auth;}
      }
      storage='file';return enrich(local());
    })().then(value=>{cached=value;return value;}).finally(()=>{reading=null;});
    return reading;
  }
  function read(refresh = false) {
    const stamp=[file,path.join(dir,'.claude.json')].map(target=>{try{const stat=fs.statSync(target);return stat.mtimeMs+':'+stat.size;}catch{return '';}}).join('|');
    if (!refresh && now()-checked<pollMs && stamp===marker) return cached;
    marker=stamp;
    checked=now();
    if (platform==='darwin') {
      if (exec) { for(const candidate of services){let raw;try{raw=JSON.parse(exec('security',['find-generic-password','-s',candidate,'-w'],{encoding:'utf8',timeout:2000}));}catch{}const auth=enrich(raw);if(auth){service=candidate;storage='keychain';return cached=auth;}}storage='file';return cached=enrich(local()); }
      // Keychain access must never block the panel's HTTP/event loop.
      keychain().catch(()=>{}); return cached || enrich(local());
    }
    return cached=enrich(local());
  }
  async function updated(previous, fresh) {
    try {
      const current=platform==='darwin'&&!exec ? await keychain() : read(true);
      if (!previous?.claudeAiOauth?.refreshToken || current?.claudeAiOauth?.refreshToken!==previous.claudeAiOauth.refreshToken) return;
      if (platform==='darwin' && storage==='keychain') {
        const quote=text=>'"'+text.replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"';
        const value=JSON.stringify({claudeAiOauth:fresh.claudeAiOauth});
        const ok=await new Promise(resolve=>{
          const child=spawn('security',['-i'],{stdio:['pipe','ignore','ignore']});
          const timer=setTimeout(()=>child.kill(),3000);
          child.on('error',()=>{clearTimeout(timer);resolve(false);});child.on('close',code=>{clearTimeout(timer);resolve(code===0);});child.stdin.on('error',()=>{});
          child.stdin.end('add-generic-password -U -s '+quote(service)+' -a '+quote(os.userInfo().username)+' -w '+quote(value)+'\n');
        }); if(!ok)return;
      } else {
        const existing=local() || {},temporary=file+'.'+crypto.randomUUID()+'.tmp';
        fs.mkdirSync(dir,{recursive:true,mode:0o700});
        try{fs.writeFileSync(temporary,JSON.stringify({...existing,claudeAiOauth:fresh.claudeAiOauth}),{mode:0o600,flag:'wx'});fs.renameSync(temporary,file);}finally{fs.rmSync(temporary,{force:true});}
      }
      cached=fresh;checked=now();
    } catch { /* The encrypted pool retains the new grant; unrelated native stores stay untouched. */ }
  }
  return {read,updated};
}
async function renewClaude(auth, { fetchImpl = fetch, now = Date.now } = {}) {
  const old = auth.claudeAiOauth;
  if (!old.refreshToken) throw new Error('Claude 订阅凭证需要重新登录');
  let response;
  try { response = await fetchImpl('https://platform.claude.com/v1/oauth/token', { method:'POST', headers:{'content-type':'application/json'}, signal:AbortSignal.timeout(45000), body:JSON.stringify({ grant_type:'refresh_token', refresh_token:old.refreshToken, client_id:'9d1c250a-e61b-44d9-88ed-5944d1962f5e' }) }); } catch { throw new Error('Claude 订阅刷新连接失败，原凭证已保留'); }
  if (!response.ok) throw new Error(`Claude 订阅刷新失败（HTTP ${response.status}），请重新登录`);
  const body = await response.json();
  if (typeof body.access_token !== 'string' || !body.access_token) throw new Error('Claude 订阅刷新响应无效');
  const ttl=Number(body.expires_in || 28800);if(!Number.isFinite(ttl)||ttl<=0)throw new Error('Claude 订阅刷新有效期无效');
  return { ...auth, claudeAiOauth:{ ...old, accessToken:body.access_token, refreshToken:body.refresh_token || old.refreshToken, expiresAt:now() + ttl*1000, ...(body.scope ? { scopes:body.scope.split(' ') } : {}) } };
}
module.exports = { normalizeClaudeAuth, claudeAccountId, available, expiresSoon, createClaudeLogin, renewClaude };
