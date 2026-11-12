const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {createClaudeNativeSessions}=require('../core/claude-native-session');
const {createClaudeEngine}=require('../engines/claude');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<150;i++){if(fn())return;await sleep(5)}assert.ok(fn(),'native event not observed')}
async function fixture(t,{held=false,ignore=false}={}){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'native-live-')),registry=path.join(home,'sessions'),transcript=path.join(home,'native.jsonl');fs.mkdirSync(registry,{mode:0o700});fs.writeFileSync(transcript,'');
 const socketPath=path.join(home,'inbox.sock'),frames=[];
 const row={pid:process.pid,sessionId:'original-native-session',kind:'interactive',peerProtocol:1,messagingSocketPath:socketPath,procStart:'test-process',pidDomain:'test',status:'idle',version:'2.1.283'};
 const record=path.join(registry,process.pid+'.json');fs.writeFileSync(record,JSON.stringify(row),{mode:0o600});
 fs.writeFileSync(path.join(registry,process.pid+'.auth.key'),JSON.stringify({peerToken:'test-inbox-key',procStart:row.procStart,pidDomain:row.pidDomain}),{mode:0o600});
 let count=0;
 const append=record=>fs.appendFileSync(transcript,JSON.stringify(record)+'\n');
 const server=net.createServer(socket=>{let text='';socket.on('data',b=>text+=b);socket.on('end',()=>{const received=text.trim().split('\n').map(x=>JSON.parse(x));frames.push(...received);const input=received.find(x=>x.type==='user');if(input&&held){append({type:'system',subtype:'informational',content:'Held peer message — preview: '+input.message.content});return;}if(input&&!ignore){count++;append({type:'user',message:{role:'user',content:input.message.content}});append({uuid:'answer-'+count,type:'assistant',message:{id:'answer-'+count,content:[{type:'text',text:'native reply '+count}],stop_reason:'end_turn'}})}})});
 await new Promise(r=>server.listen(socketPath,r));fs.chmodSync(socketPath,0o600);
 t.after(()=>new Promise(resolve=>server.close(()=>{fs.rmSync(home,{recursive:true,force:true});resolve()})));
 const native=createClaudeNativeSessions({home,transcriptPath:()=>transcript,pollMs:5,deliveryTimeoutMs:300});
 return{home,registry,transcript,record,row,native,frames,append};
}

test('terminal → IM → terminal → IM stays in the existing native process without spawning another CLI',async t=>{
 const f=await fixture(t),events=[];let closed=0;
 f.append({type:'user',message:{content:'first terminal question'}});f.append({type:'assistant',message:{content:[{type:'text',text:'first terminal answer'}],stop_reason:'end_turn'}});
 const engine=createClaudeEngine({transcripts:{path:()=>f.transcript,messages:()=>[]},nativeSessions:f.native,env:{CLAUDE_CLI:'/must-not-spawn'}});
 const session=await engine.open({host:{spawn(){throw Error('must not create a second CLI')}},sessionId:f.row.sessionId,resume:true,cwd:f.home,emit:(event,data)=>events.push({event,data}),onIdle(){},onClosed(){closed++}});t.after(()=>session.close());
 assert.equal(session.nativeAttached,true);assert.equal(await session.ready,f.row.sessionId);
 session.submit('im-question-one',{prompt:'second question from IM',context:'[my-agents 飞书发送上下文，本轮有效]\n当前会话由 my-agents 直接启动，版本为 2.1.319\n{"messageId":"im-question-one"}\n原消息发送位置'});
 await until(()=>events.some(x=>x.event==='done'));
 assert.equal(f.frames[0].type,'auth');assert.equal(f.frames[0].token,'test-inbox-key');assert.match(f.frames[1].message.content,/second question from IM/);assert.match(f.frames[1].message.content,/2\.1\.283/);assert.doesNotMatch(f.frames[1].message.content,/2\.1\.319/);assert.match(f.frames[1].message.content,/原消息发送位置/);
 assert.ok(events.some(x=>x.event==='text'&&x.data.text==='native reply 1'&&x.data.messageId==='im-question-one'));
 f.append({type:'user',message:{content:'third question back at terminal'}});f.append({type:'assistant',message:{content:[{type:'text',text:'terminal answer'}],stop_reason:'end_turn'}});
 await sleep(25);assert.ok(!events.some(x=>x.data.text==='terminal answer'));
 session.submit('im-question-two',{prompt:'fourth question from IM'});await until(()=>events.filter(x=>x.event==='done').length===2);
 assert.match(fs.readFileSync(f.transcript,'utf8'),/third question back at terminal/);
 session.stop();assert.equal(closed,1);assert.doesNotThrow(()=>process.kill(process.pid,0));assert.ok(fs.existsSync(f.record));
});

test('insecure native registry entries are refused instead of falling back to a copied session',async t=>{
 const f=await fixture(t);fs.chmodSync(f.record,0o666);assert.throws(()=>f.native.find(f.row.sessionId),/权限不安全/);
});

test('a closed original window ends IM observation without closing or resuming a different session',async t=>{
 const f=await fixture(t),events=[];let closed=false;
 const session=f.native.open({record:f.row,sessionId:f.row.sessionId,emit:(event,data)=>events.push({event,data}),onIdle(){},onClosed(){closed=true}});t.after(()=>session.close());
 f.row.status='working';fs.writeFileSync(f.record,JSON.stringify(f.row));session.submit('waiting-message',{prompt:'continue'});fs.unlinkSync(f.record);
 await until(()=>closed);assert.ok(events.some(x=>x.event==='error'&&x.data.messageId==='waiting-message'));assert.equal(f.frames.length,0);
});


test('held native delivery remains observed beyond the deadline and synchronizes a later approved answer once',async t=>{
 const f=await fixture(t,{held:true}),events=[];
 const session=f.native.open({record:f.row,sessionId:f.row.sessionId,emit:(event,data)=>events.push({event,data}),onIdle(){},onClosed(){}});t.after(()=>session.close());
 session.submit('held-one',{prompt:'wait for genuine native approval'});
 await until(()=>events.some(x=>x.data.kind==='native_approval'));
 await sleep(350);
 assert.equal(session.busy,true);assert.ok(!events.some(x=>x.event==='error'||x.event==='done'));
 assert.equal(f.frames.filter(x=>x.type==='user').length,1);
 assert.equal(events.filter(x=>x.data.kind==='native_approval').length,1);
 // Unrelated terminal activity must not be attributed to the held IM turn.
 f.append({type:'assistant',message:{content:[{type:'text',text:'unrelated terminal answer'}],stop_reason:'end_turn'}});
 f.append({type:'user',message:{content:f.frames.find(x=>x.type==='user').message.content}});
 f.append({type:'assistant',message:{id:'approved-answer',content:[{type:'text',text:'answer after approval'}],stop_reason:'end_turn'}});
 await until(()=>events.some(x=>x.event==='done'));
 assert.equal(events.filter(x=>x.event==='text').map(x=>x.data.text).join(''),'answer after approval');
 assert.equal(session.busy,false);assert.equal(f.frames.filter(x=>x.type==='user').length,1);
});

test('unknown native delivery stays pending without retry and can later be confirmed',async t=>{
 const f=await fixture(t,{ignore:true}),events=[];
 const session=f.native.open({record:f.row,sessionId:f.row.sessionId,emit:(event,data)=>events.push({event,data}),onIdle(){},onClosed(){}});t.after(()=>session.close());
 session.submit('unknown-one',{prompt:'send only once'});
 await until(()=>events.some(x=>x.data.kind==='native_delivery_pending'));
 await sleep(50);assert.equal(events.filter(x=>x.data.kind==='native_delivery_pending').length,1);
 assert.ok(!events.some(x=>x.event==='error'));assert.equal(session.busy,true);
 f.append({type:'user',message:{content:f.frames.find(x=>x.type==='user').message.content}});
 f.append({type:'assistant',message:{id:'late-answer',content:[{type:'text',text:'late answer'}],stop_reason:'end_turn'}});
 await until(()=>events.some(x=>x.event==='done'));
 assert.equal(f.frames.filter(x=>x.type==='user').length,1);
});

async function secondWindow(f, status = 'idle') {
 const row = { ...f.row, pid: process.ppid, procStart: 'second-process', status };
 fs.writeFileSync(path.join(f.registry, row.pid + '.json'), JSON.stringify(row), { mode: 0o600 });
 return row;
}

test('a single conversational window wins over an older shell window without delivering a probe', async t => {
 const f = await fixture(t);
 await secondWindow(f, 'shell');
 assert.equal(f.native.find(f.row.sessionId).pid, f.row.pid);
 assert.equal(f.frames.length, 0);
 // File traversal order and misleading recency must not decide ownership.
 const second = await secondWindow(f, 'idle');
 assert.throws(() => f.native.find(f.row.sessionId), /多个 Claude Code 对话窗口.*本次尚未投递/);
 assert.equal(f.native.find(f.row.sessionId, f.row).pid, f.row.pid);
 assert.equal(f.native.find(f.row.sessionId, second).pid, second.pid);
});

test('opening another window does not break an established native attachment or redirect its messages', async t => {
 const f = await fixture(t), events = [];
 const record = f.native.find(f.row.sessionId);
 const session = f.native.open({ record, sessionId: f.row.sessionId, emit: (event, data) => events.push({ event, data }), onIdle() {}, onClosed() {} });
 t.after(() => session.close());
 await secondWindow(f);
 session.submit('pinned-window', { prompt: 'continue in the selected window' });
 await until(() => events.some(e => e.event === 'done'));
 assert.equal(f.frames.filter(frame => frame.type === 'user').length, 1);
 assert.ok(!events.some(e => e.event === 'error'));
 fs.unlinkSync(f.record);
 assert.equal(f.native.find(f.row.sessionId, record), null, 'a closed selected window never silently becomes the other window');
});

test('a registry filename cannot impersonate a second window and pinned process identity cannot be reused', async t => {
 const f = await fixture(t);
 fs.writeFileSync(path.join(f.registry, '0' + f.row.pid + '.json'), JSON.stringify(f.row), { mode: 0o600 });
 assert.equal(f.native.find(f.row.sessionId).pid, f.row.pid);
 const changed = { ...f.row, procStart: 'reused-process' };
 fs.writeFileSync(f.record, JSON.stringify(changed));
 assert.equal(f.native.find(f.row.sessionId, f.row), null);
});
