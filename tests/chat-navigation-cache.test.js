const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
function setup(){
 const nodes={render:{childNodes:[],replaceChildren(...children){this.childNodes=children;}},box:{scrollTop:120,updateScrollControls(){}},title:{firstChild:{textContent:'Conversation'}},path:{textContent:'/project'}};
 const context={state:{type:'sessions',items:[]},chatView:{sessionId:'a',messages:[]},chatScrollObserver:null,ResizeObserver:class{observe(){} disconnect(){}},chatChrome(){},refreshOpenChat(){context.refreshes++;},startChatHistoryFollow(){context.follows++;},follows:0,refreshes:0,$:id=>({'#render':nodes.render,'#chat-messages':nodes.box,'#title':nodes.title,'#fpath':nodes.path}[id])};
 vm.createContext(context);vm.runInContext(html.slice(html.indexOf('const chatPageCache ='),html.indexOf('let chatView =')),context);return {context,nodes,run:code=>vm.runInContext(code,context)};
}
test('restoring a cached conversation reuses live input nodes and refreshes without waiting',()=>{
 const {context,nodes,run}=setup();const input={value:'unsent draft',selectionStart:4,onclick(){return 'still bound';}};nodes.render.childNodes=[input];run('rememberChatPage()');nodes.render.childNodes=[];context.chatView={sessionId:'b'};nodes.box.scrollTop=0;
 assert.equal(run("restoreChatPage('a')"),true);assert.equal(context.chatView.sessionId,'a');assert.equal(nodes.render.childNodes[0],input);assert.equal(input.value,'unsent draft');assert.equal(input.onclick(),'still bound');assert.equal(nodes.box.scrollTop,120);assert.equal(context.refreshes,1);assert.equal(context.follows,1);assert.equal(context.chatView.needsReconcile,true);assert.equal(context.chatView.revision,'');
});
test('conversation cache is bounded and does not restore a missing or evicted view',()=>{
 const {context,run}=setup();for(let i=0;i<10;i++){context.chatView={sessionId:'session-'+i};run('rememberChatPage()');}assert.equal(run('chatPageCache.size'),8);assert.equal(run("restoreChatPage('session-0')"),false);assert.equal(run("restoreChatPage('session-9')"),true);
});
function setupRefresh(api){
 const box={scrollTop:20,scrollHeight:200,clientHeight:100,querySelectorAll:()=>[]};
 const prompt={value:'draft',selectionStart:2,selectionEnd:2,setSelectionRange(){}};
 const context={state:{type:'sessions'},chatView:{sessionId:'a',messages:[],lastReplayJobId:'same-job'},document:{querySelector:()=>null},api,renderChat(){context.renders++;},renders:0,streamChat(v,options){context.streams.push({v,options});v.run={};},streams:[],rt:zh=>zh,$:id=>({'#chat-messages':box,'#chat-prompt':prompt,'#chat-model':{value:'codex'},'#chat-status':{textContent:''}}[id])};
 vm.createContext(context);vm.runInContext('const openChatRefreshes = new WeakSet();\n'+html.slice(html.indexOf('async function refreshOpenChat()'),html.indexOf('async function refreshRoutes()')),context);
 return context;
}
test('returning to the same running job reconnects once without submitting a prompt',async()=>{
 const c=setupRefresh(async()=>({messages:[],liveReplay:true,jobId:'same-job'}));
 await c.refreshOpenChat();await c.refreshOpenChat();
 assert.equal(c.streams.length,1);assert.equal(c.streams[0].options.reconnect,true);
});
test('a pending refresh in another conversation does not block the current conversation',async()=>{
 let resolveA;const c=setupRefresh(url=>url);c.api=(_method,url)=>url.includes('/a/')?new Promise(resolve=>{resolveA=resolve;}):Promise.resolve({messages:[],liveReplay:true,jobId:'b-job'});
 const pending=c.refreshOpenChat();c.chatView={sessionId:'b',messages:[]};await c.refreshOpenChat();
 assert.equal(c.streams.length,1);assert.equal(c.streams[0].v.sessionId,'b');
 resolveA({messages:[],liveReplay:true,jobId:'same-job'});await pending;assert.equal(c.streams.length,1);
});

test('cached detached output is repainted even when native history has the same messages',async()=>{
 const c=setupRefresh(async()=>({messages:[],revision:'same'}));
 c.chatView.needsReconcile=true;
 await c.refreshOpenChat();assert.equal(c.renders,1);assert.equal(c.chatView.needsReconcile,false);
 await c.refreshOpenChat();assert.equal(c.renders,1);
});
test('restoring during stream cancellation restarts following and reconnects after cleanup',async()=>{
 const {context,run}=setup();let finish;const finished=new Promise(resolve=>finish=resolve);
 context.chatView.run={finished};run('rememberChatPage()');run("restoreChatPage('a')");
 assert.equal(context.follows,1);assert.equal(context.refreshes,0);
 context.chatView.run=null;finish();await Promise.resolve();assert.equal(context.refreshes,1);
});
