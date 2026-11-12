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
