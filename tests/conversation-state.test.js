const test=require('node:test'),assert=require('node:assert/strict'),state=require('../conversation-state');
test('Web and IM preserve approval and reconnect states until delivery or completion',()=>{
 const view=state.create();state.apply(view,'warning',{kind:'native_approval',warning:'approval'});assert.equal(view.phase,'等待原窗口确认');assert.equal(view.done,false);
 state.apply(view,'warning',{kind:'node_reconnecting',warning:'reconnecting'});assert.equal(view.phase,'等待节点重连');
 state.apply(view,'text',{text:'actual answer'});state.apply(view,'done',{});state.apply(view,'warning',{warning:'late update'});assert.equal(view.phase,'已完成');assert.equal(view.text,'actual answer');
 const lost=state.create();state.apply(lost,'warning',{kind:'recovery',warning:'check outcome'});state.apply(lost,'end',{state:'unknown'});assert.equal(lost.phase,'结果待核对');
});
test('background task and final-summary waits stay nonterminal in both Web and IM',()=>{
 const view=state.create();state.apply(view,'warning',{kind:'native_attachment',nativeSession:{id:'original',name:'Original terminal'}});
 state.apply(view,'text',{text:'Still checking'});state.apply(view,'warning',{kind:'native_background',warning:'one task running'});
 assert.equal(view.phase,'等待后台任务');assert.equal(view.done,false);assert.equal(view.nativeSession.name,'Original terminal');
 state.apply(view,'warning',{kind:'native_summary',warning:'awaiting summary'});assert.equal(view.phase,'等待原会话汇总');assert.equal(view.done,false);
 state.apply(view,'text',{text:'Final result'});state.apply(view,'done',{});assert.equal(view.phase,'已完成');
});

test('only an actual reconnect changes the phase during live delivery and replay',()=>{
 const view=state.create(); state.apply(view,'text',{text:'hello'});
 for(const warning of ['Model metadata for demo not found. Defaulting to fallback metadata; using defaults.', 'other notice']) {
   state.apply(view,'warning',{warning}); assert.equal(view.phase,'正在输出');
 }
 state.apply(view,'warning',{warning:'Reconnecting... 2/5 (connection reset)'}); assert.equal(view.phase,'连接重试中');
 state.apply(view,'error',{error:'authentication failed'}); assert.equal(view.phase,'失败');
});
test('hide only the native attachment prefix when matching images are present',()=>{
 const descriptor='<image name="[Image #1]" path="/tmp/test.png">\n</image>[Image #1] ';
 assert.equal(state.messageText(descriptor+'line 1\nline 2',[{}]),'line 1\nline 2');
 assert.equal(state.messageText(descriptor+'question',[]),descriptor+'question');
 assert.equal(state.messageText('sample code\n'+descriptor,[{}]),'sample code\n'+descriptor);
});

test('a historical revoked grant shows one account-specific recovery action in the web conversation',()=>{
 const raw='Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.';
 const shown=state.codexLoginHint(state.codexLoginHint(raw),{machineLabel:'Mac',email:'demo@example.org',poolEnabled:true});
 assert.match(shown,/Mac · 原终端登录 · demo@example.org/); assert.match(shown,/账号策略/);
 assert.ok(!shown.includes(raw)); assert.ok(!state.codexLoginHint(raw,{machineLabel:'Box'}).includes('undefined'));
});

test('reopened Codex histories explain the last revoked login until a newer native or panel turn', () => {
  const { lastCodexLoginFailure } = require('../conversation-state');
  const data = { error: 'Your access token could not be refreshed because your refresh token was revoked.', timestamp: '2026-01-01T10:01:00Z' };
  const events = [{ event: 'error', data }, { event: 'done', data }, { event: 'end', data: {} }];
  assert.equal(lastCodexLoginFailure(events, [{ timestamp: '2026-01-01T10:00:00Z' }]), data);
  assert.equal(lastCodexLoginFailure(events, [{ timestamp: '2026-01-01T10:02:00Z' }]), null);
  assert.equal(lastCodexLoginFailure([...events, { event: 'done', data: {} }], []), null);
});
