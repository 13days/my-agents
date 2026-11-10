const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionInspection } = require('../core/session-inspection');

test('native history previews stay on the owner and one offline machine preserves other results', async () => {
 const calls=[];
 const inspect=createSessionInspection({selfId:()=> 'mac',localPreviews:async items=>items.map(item=>({id:item.id,turns:42,userMessages:[{text:'完整的本机预览'}]})),peerFor:id=>({call:async(method,args)=>{calls.push({id,method,args});if(id==='offline')throw Error('offline');return args.items.map(item=>({id:item.id,turns:7,userMessages:[{text:'远程预览'}]}))}})});
 const result=await inspect.previews([{id:'local-native',machineId:'mac'},{id:'remote-native',machineId:'linux'},{id:'offline-native',machineId:'offline'}]);
 assert.deepEqual(result.map(x=>x.turns),[42,7,null]);assert.equal(result[2].previewUnavailable,true);
 assert.ok(calls.every(call=>call.method==='history.previews'));assert.equal(result[1].userMessages[0].text,'远程预览');
});

test('user message pagination requests a bounded page from the owning machine',async()=>{
 let call;
 const inspect=createSessionInspection({selfId:()=> 'mac',localUserPage:async input=>({local:input}),peerFor:id=>({call:async(method,args)=>{call={id,method,args};return{messages:[{text:'问题'}],pages:3};}})});
 const item={id:'remote-native',machineId:'linux'};
 const result=await inspect.userPage(item,1);
 assert.equal(call.method,'history.userPage');assert.equal(call.id,'linux');assert.equal(call.args.page,1);assert.equal(result.messages.length,1);
 assert.deepEqual(await inspect.userPage({id:'local-native',machineId:'mac'},0),{local:{item:{id:'local-native',machineId:'mac'},page:0}});
});

test('node RPC returns only preview and paged user text from a large transcript',async t=>{
 const {pairTransports}=require('../node/transports'),{createPeer}=require('../node/rpc'),{serveNode}=require('../node/agent');
 const [hubTransport,nodeTransport]=pairTransports(),hub=createPeer(hubTransport),node=createPeer(nodeTransport);
 t.after(()=>hub.close());
 const history={messages:[{role:'assistant',text:'x'.repeat(9*1024*1024)},...Array.from({length:12},(_,i)=>({role:'user',text:'问题 '+(i+1),timestamp:'2026-11-10T10:00:00Z'}))]};
 serveNode({peer:node,host:{platform:'test',homeDir:()=>'/home/test'},engines:[],id:'linux',history:{list:()=>[],messages:()=>history}});
 const item={id:'native-long-session',machineId:'linux'};
 const inspect=createSessionInspection({selfId:()=> 'mac',peerFor:()=>hub});
 const previews=await inspect.previews([item]);assert.equal(previews[0].turns,12);assert.equal(previews[0].userMessages.length,2);
 const page=await inspect.userPage(item,0);assert.equal(page.messages.length,5);assert.equal(page.messages[4].text,'问题 12');
 assert.ok(Buffer.byteLength(JSON.stringify({previews,page}))<10000);assert.equal(hub.closed,false);
});
