const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
function setup(){
 const nodes={render:{childNodes:[],replaceChildren(...children){this.childNodes=children;}},box:{scrollTop:120,updateScrollControls(){}},title:{firstChild:{textContent:'Conversation'}},path:{textContent:'/project'}};
 const context={state:{type:'sessions',items:[]},chatView:{sessionId:'a',messages:[]},chatScrollObserver:null,ResizeObserver:class{observe(){} disconnect(){}},chatChrome(){},refreshOpenChat(){context.refreshes++;},refreshes:0,$:id=>({'#render':nodes.render,'#chat-messages':nodes.box,'#title':nodes.title,'#fpath':nodes.path}[id])};
 vm.createContext(context);vm.runInContext(html.slice(html.indexOf('const chatPageCache ='),html.indexOf('let chatView =')),context);return {context,nodes,run:code=>vm.runInContext(code,context)};
}
test('restoring a cached conversation reuses live input nodes and refreshes without waiting',()=>{
 const {context,nodes,run}=setup();const input={value:'unsent draft',selectionStart:4,onclick(){return 'still bound';}};nodes.render.childNodes=[input];run('rememberChatPage()');nodes.render.childNodes=[];context.chatView={sessionId:'b'};nodes.box.scrollTop=0;
 assert.equal(run("restoreChatPage('a')"),true);assert.equal(context.chatView.sessionId,'a');assert.equal(nodes.render.childNodes[0],input);assert.equal(input.value,'unsent draft');assert.equal(input.onclick(),'still bound');assert.equal(nodes.box.scrollTop,120);assert.equal(context.refreshes,1);
});
test('conversation cache is bounded and does not restore a missing or evicted view',()=>{
 const {context,run}=setup();for(let i=0;i<10;i++){context.chatView={sessionId:'session-'+i};run('rememberChatPage()');}assert.equal(run('chatPageCache.size'),8);assert.equal(run("restoreChatPage('session-0')"),false);assert.equal(run("restoreChatPage('session-9')"),true);
});
