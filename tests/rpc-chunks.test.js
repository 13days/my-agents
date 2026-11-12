const test=require('node:test'),assert=require('node:assert/strict');
const {createPeer}=require('../node/rpc'),{pairTransports}=require('../node/transports');
test('large Unicode requests and replies use bounded frames without closing the control channel',async t=>{
 const [left,right]=pairTransports(),frames=[];const tracked={...left,send:text=>{frames.push(Buffer.byteLength(text));left.send(text)}};
 const a=createPeer(tracked),b=createPeer(right);t.after(()=>{a.close();b.close()});b.handle('echo',input=>input);await a.call('echo','handshake');
 const text='文件与代码🙂'.repeat(150000),result=await a.call('echo',{text});assert.equal(result.text,text);assert.ok(Math.max(...frames)<1024*1024);assert.equal(await a.call('echo','still connected'),'still connected');
});
test('oversized calls to legacy nodes fail locally without disconnecting unrelated work',async t=>{
 const [left,right]=pairTransports(),a=createPeer(left);t.after(()=>a.close());right.onMessage(raw=>{const message=JSON.parse(raw);if(message.id)right.send(JSON.stringify({id:message.id,result:'ok'}))});
 await assert.rejects(a.call('large',{text:'x'.repeat(7*1024*1024)}),{status:413});assert.equal(await a.call('small',{}),'ok');
});
test('backpressured model data does not prevent small control RPCs from completing',async t=>{
 const [left,right]=pairTransports();let blocked=false;
 const a=createPeer({...left,get bufferedBytes(){return blocked?300*1024:0}}),b=createPeer(right);t.after(()=>{a.close();b.close()});b.handle('echo',x=>x);await a.call('echo','ready');
 blocked=true;let finished=false;const large=a.call('echo','x'.repeat(1024*1024)).then(()=>{finished=true});
 assert.equal(await a.call('echo','heartbeat'),'heartbeat');assert.equal(finished,false);blocked=false;await large;
});
