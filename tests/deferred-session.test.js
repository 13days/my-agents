const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createDeferredSession}=require('../core/deferred-session');
const {nativeTurnBusy}=require('../core/native-turn-state');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<100;i++){if(fn())return;await sleep(3)}assert.ok(fn(),'condition did not become true')}

test('a native handover accepts questions immediately, waits for quiet, then resumes the same session in order',async t=>{
 let busy=true,opened=0,closed=0,resolveReady;const sent=[],events=[];
 const session=createDeferredSession({sessionId:'native-session',busy:()=>busy,pollMs:3,quietMs:12,emit:(event,data)=>events.push({event,data}),onClosed:()=>closed++,open:async()=>{opened++;return{ready:new Promise(r=>resolveReady=r),submit:(id,input,steer)=>{sent.push({id,input,steer});resolveReady('native-session')},stop(){},close(){},get busy(){return true}}}});
 t.after(()=>session.stop());assert.equal(await session.ready,'native-session');
 session.submit('first-query',{prompt:'前面聊了什么'},false);session.submit('second-query',{prompt:'继续完成'},true);
 await sleep(15);assert.equal(opened,0);assert.equal(session.busy,true);assert.equal(session.currentId,'first-query');
 busy=false;await sleep(5);busy=true;await sleep(10);assert.equal(opened,0);
 busy=false;await until(()=>sent.length===2);
 assert.equal(opened,1);assert.deepEqual(sent.map(x=>x.id),['first-query','second-query']);assert.ok(sent.every(x=>x.steer===false));
 assert.equal(events[0].data.kind,'native_handoff');assert.equal(closed,0);
});

test('cancelling a waiting handover never opens or stops the original CLI',async()=>{
 let opened=0,closed=0;
 const session=createDeferredSession({sessionId:'native',busy:()=>true,pollMs:2,quietMs:0,emit(){},onClosed:()=>closed++,open:async()=>{opened++;throw Error('must not open')}});
 session.submit('query',{prompt:'continue'});session.stop();await sleep(12);
 assert.equal(opened,0);assert.equal(closed,1);assert.equal(session.busy,false);
});

test('a resumed CLI startup failure reports the accepted question instead of reopening /new',async t=>{
 const events=[];let closed=false;
 const session=createDeferredSession({sessionId:'native',busy:()=>false,pollMs:2,quietMs:0,emit:(event,data)=>events.push({event,data}),onClosed:()=>closed=true,open:async()=>{throw Error('CLI not available')}});t.after(()=>session.stop());
 session.submit('query',{prompt:'continue'});await until(()=>closed);
 assert.ok(events.some(x=>x.event==='error'&&x.data.messageId==='query'&&x.data.error==='CLI not available'));
});

test('native tool execution remains busy even in the gap between HTTP requests',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-turn-')),file=path.join(dir,'session.jsonl');t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const write=rows=>fs.writeFileSync(file,rows.map(x=>JSON.stringify(x)).join('\n')+'\n');
 write([{type:'assistant',message:{stop_reason:'tool_use',content:[{type:'tool_use'}]}}]);assert.equal(nativeTurnBusy(file),true);
 write([{type:'user',message:{content:[{type:'tool_result'}]}}]);assert.equal(nativeTurnBusy(file),true);
 write([{type:'assistant',message:{stop_reason:'end_turn',content:[{type:'text',text:'done'}]}},{type:'progress'}]);assert.equal(nativeTurnBusy(file),false);
 write([{type:'assistant',message:{stop_reason:'end_turn',content:[]}},{type:'user',message:{content:'new task'}}]);assert.equal(nativeTurnBusy(file),true);
 fs.writeFileSync(file,'x'.repeat(600000));assert.equal(nativeTurnBusy(file),true);
});

test('cancelling during an asynchronous native-state check cannot spawn another CLI',async()=>{
 let release,checking=false,opened=0;
 const session=createDeferredSession({sessionId:'native',pollMs:2,quietMs:0,busy:()=>{checking=true;return new Promise(r=>release=r)},emit(){},onClosed(){},open:async()=>{opened++;throw Error('must not open')}});
 session.submit('query',{prompt:'continue'});await until(()=>checking);session.stop();release(false);await sleep(10);assert.equal(opened,0);
});
