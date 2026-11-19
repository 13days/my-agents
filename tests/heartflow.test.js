const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createHeartflowStore}=require('../core/heartflow-store');
const {createHeartflow}=require('../core/heartflow');
const {normalizeMessage}=require('../core/heartflow-feishu');
const {heartflowCard}=require('../core/heartflow-card');
function setup(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'heartflow-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const store=createHeartflowStore({dir});store.ingest([{id:'m1',chatId:'oc_a',text:'个人 Tag 群里不要智能回复',createdAt:Date.now(),updatedAt:1},{id:'m2',chatId:'oc_a',text:'创建时默认关闭',createdAt:Date.now(),updatedAt:1}]);return {dir,store};}
const action=(id,sessionId='session-a')=>({id,sessionId,engine:'codex',machineId:'mac',cwd:'/project',prompt:'分析个人 Tag 默认设置的修改范围'});
const draft=(store,actions=[action('a')])=>store.draft({title:'个人 Tag',summary:'默认关闭群聊智能回复',messageIds:['m1','m2'],matterIds:[],actions});
test('many-to-many matters and partial approval persist exact check versions; stale/repeated checks cannot execute',t=>{
 const {dir,store}=setup(t),one=store.matter({title:'群回复'}),two=store.matter({title:'个人 Tag'});let p=draft(store,[action('a'),action('b','session-b')]);
 p=store.review(p.id,{version:1,decision:'save',draft:{...p,matterIds:[one.id,two.id]},reason:'关联两件事'});
 p=store.review(p.id,{version:2,decision:'approve',actionIds:['a']});assert.equal(p.state,'pending');assert.equal(p.actions.length,1);
 assert.throws(()=>store.review(p.id,{version:2,decision:'approve'}),/已经更新/);
 store.review(p.id,{version:3,decision:'approve'});
 const state=createHeartflowStore({dir}).snapshot();assert.equal(Object.keys(state.deliveries).length,2);assert.equal(state.checks.length,3);assert.deepEqual(state.checks[1].before.matterIds,[one.id,two.id]);assert.equal(state.checks[1].before.actions.length,2);
});
test('invalid checks are atomic and withdrawn/edited source invalidates approval version',t=>{
 const {store}=setup(t),p=draft(store);assert.throws(()=>store.review(p.id,{version:1,decision:'approve',actionIds:['missing']}));assert.equal(store.snapshot().checks.length,0);assert.equal(store.snapshot().proposals[p.id].version,1);
 store.ingest([{id:'m1',chatId:'oc_a',text:'先别改',updatedAt:2}]);assert.throws(()=>store.review(p.id,{version:1,decision:'approve'}),/已经更新/);
});
test('split and merge preserve provenance, clear execution scopes and record feedback',t=>{
 const {store}=setup(t),p=draft(store),q=store.combine([{id:p.id,version:1}],['m1']);assert.deepEqual(q.messageIds,['m1']);assert.equal(q.actions.length,0);
 const merged=store.combine([{id:p.id,version:2},{id:q.id,version:1}]);assert.equal(merged.messageIds.length,2);assert.equal(store.snapshot().checks.length,2);
});
test('concurrent dispatch uses durable claim and executes once; restart never replays uncertain delivery',async t=>{
 const {dir,store}=setup(t);let calls=0;const flow=createHeartflow({store,source:{},analyze:()=>{},sessions:async()=>[],dispatch:async()=>{calls++;await new Promise(r=>setTimeout(r,10));return {sessionId:'session-a'};}});
 const p=draft(store);store.review(p.id,{version:1,decision:'approve'});await Promise.all([flow.deliver(),flow.deliver()]);assert.equal(calls,1);
 const recovered=createHeartflowStore({dir});createHeartflow({store:recovered,source:{},sessions:async()=>[],dispatch:()=>{calls++;}});assert.equal(Object.values(recovered.snapshot().deliveries)[0].state,'unknown');assert.equal(calls,1);
});
test('changed source blocks queued execution; transport uncertainty is never retried',async t=>{
 const {store}=setup(t);let calls=0;const flow=createHeartflow({store,source:{},sessions:async()=>[],dispatch:async()=>{calls++;throw new Error('disconnected');}});
 const p=draft(store);store.review(p.id,{version:1,decision:'approve'});store.ingest([{id:'m1',chatId:'oc_a',text:'已解决',updatedAt:2}]);await flow.deliver();assert.equal(calls,0);assert.equal(Object.values(store.snapshot().deliveries)[0].state,'blocked');
 const q=draft(store);store.review(q.id,{version:1,decision:'approve'});await flow.deliver();await flow.deliver();assert.equal(calls,1);
});
test('model receives check feedback and own supporting replies, cannot invent sources or executable session IDs',async t=>{
 const {store}=setup(t);store.configure({since:Date.now()-60000,selfId:'me'});const old=draft(store);store.review(old.id,{version:1,decision:'ignore',reason:'只在创建时关闭'});
 store.ingest([{id:'m3',chatId:'oc_a',text:'请修改默认配置',threadId:'thread',senderId:'other',createdAt:Date.now(),updatedAt:1},{id:'m4',chatId:'oc_a',text:'只在创建时关闭',threadId:'thread',senderId:'me',createdAt:Date.now(),updatedAt:1}]);
 let context;const flow=createHeartflow({store,source:{},sessions:async()=>[{id:'known',engine:'codex',machineId:'mac',project:'/work'}],analyze:async c=>{context=c;return {model:'test',suggestions:[{title:'修改',summary:'默认值',reason:'@用户',messageIds:['m3'],actions:[action('a','invented')]}]};},dispatch:()=>{throw Error('must not execute');}});
 await flow.suggest();assert.equal(context.learning.length,1);assert.ok(context.supportingMessages.some(m=>m.id==='m4')); assert.equal(Object.values(store.snapshot().proposals).at(-1).actions.length,0);
 store.learning(store.snapshot().checks[0].id,false);assert.equal(store.snapshot().checks[0].learning,false);
});
test('personal message pagination persists continuation across bounded ticks without dropping burst messages',async t=>{
 const {store}=setup(t),base=Date.now();store.configure({since:base-60000,selfId:'me',chats:[{id:'oc_test'}]});let seen=[];
 const flow=createHeartflow({store,sessions:async()=>[],dispatch:()=>{},source:{page:async(_chat,token)=>{seen.push(token);const page=Number(token||0);return {messages:[{message_id:'page'+page,chat_id:'oc_test',msg_type:'text',create_time:String(base-page*1000),body:{content:'{"text":"消息"}'}}],has_more:page<5,page_token:String(page+1)};}}});
 await flow.sync();assert.equal(store.snapshot().cursor.oc_test.page,'4');await flow.sync();assert.equal(store.snapshot().cursor.oc_test.page,undefined);assert.equal(seen.length,6);assert.ok(store.snapshot().messages.page5);
});
test('normalize preserves mentions, quoted parent, edited/deleted state without interpreting message HTML',()=>{
 const m=normalizeMessage({message_id:'om_1',chat_id:'oc_x',msg_type:'text',body:{content:'{"text":"@_user_1 <script>bad</script>"}'},mentions:[{key:'@_user_1',name:'吴',id:'me'}],parent_id:'om_0',create_time:'10',update_time:'20',deleted:true});assert.equal(m.text,'@吴 <script>bad</script>');assert.equal(m.parentId,'om_0');assert.equal(m.deleted,true);assert.equal(m.updatedAt,20);
});
test('cards bind approval to version and owner; truncated descriptions cannot be approved',()=>{
 const proposal={id:'p',version:3,title:'任务',summary:'说明',reason:'相关',actions:[action('a')]};let c=heartflowCard({proposal,owner:'owner',coordinator:'mac'});const b=c.elements.at(-1).actions[0];assert.equal(b.value.version,3);assert.equal(b.value.owner,'owner');proposal.actions[0].prompt='x'.repeat(17000);c=heartflowCard({proposal,owner:'owner',coordinator:'mac'});assert.ok(c.elements.at(-1).actions.every(b=>b.value?.decision!=='approve'));
});

test('new evidence joins an existing pending proposal and makes the old card stale',async t=>{
 const {store}=setup(t);store.configure({since:Date.now()-60000,selfId:'me'});const p=draft(store);store.ingest([{id:'m3',chatId:'oc_a',text:'只改新建流程',createdAt:Date.now(),updatedAt:1}]);
 const flow=createHeartflow({store,source:{},sessions:async()=>[],dispatch:()=>{},analyze:async()=>({model:'test',suggestions:[{relatedProposalId:p.id,title:'补充',summary:'只改新建',messageIds:['m3'],actions:[]}]})});
 await flow.suggest();const next=store.snapshot();assert.equal(Object.keys(next.proposals).length,1);assert.ok(next.proposals[p.id].messageIds.includes('m3'));assert.equal(next.proposals[p.id].version,2);assert.throws(()=>store.review(p.id,{version:1,decision:'approve'}),/已经更新/);
});

test('approved edits are retained as learning examples even after actions leave the pending proposal',t=>{
 const {store}=setup(t),p=draft(store);store.review(p.id,{version:1,decision:'approve',draft:{...p,actions:[{...p.actions[0],sessionId:'corrected',prompt:'只检查创建默认值'}]}});
 const check=store.snapshot().checks[0];assert.equal(check.approvedActions[0].sessionId,'corrected');assert.equal(check.approvedActions[0].prompt,'只检查创建默认值');
});

test('notification outcome uncertainty is not retried and review remains pending',async t=>{
 const {store}=setup(t);store.configure({notifyEnabled:true,notifyUserId:'ou_owner'});const p=draft(store);let sent=0;
 const flow=createHeartflow({store,source:{},sessions:async()=>[],dispatch:()=>{},notify:async()=>{sent++;throw Error('timeout after sending');}});
 await flow.notices();await flow.notices();assert.equal(sent,1);assert.equal(store.snapshot().proposals[p.id].state,'pending');assert.equal(store.snapshot().proposals[p.id].noticeState,'unknown');
});

test('model parsing handles split SSE frames and exposes unsupported model errors',async()=>{
 const {createHeartflowModel}=require('../core/heartflow-model');let request;
 const body='data: '+JSON.stringify({type:'response.output_text.delta',delta:'{"suggestions":[]}'})+'\n\n';
 const fetchImpl=async(_url,input)=>{request=JSON.parse(input.body);return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(body.slice(0,15)));controller.enqueue(new TextEncoder().encode(body.slice(15)));controller.close();}}));};
 const result=await createHeartflowModel({url:'http://localhost',token:'test',defaultModel:async()=>'configured',fetchImpl})({messages:[]});assert.deepEqual(result.suggestions,[]);assert.equal(request.model,'configured');assert.equal(request.tools,undefined);
 await assert.rejects(createHeartflowModel({url:'http://localhost',token:'test',fetchImpl:async()=>new Response(JSON.stringify({error:{message:'not supported'}}),{status:400})})({},'bad'),/not supported/);
});

test('a source update while the model is thinking cannot silently approve an outdated interpretation',async t=>{
 const {store}=setup(t);store.configure({since:Date.now()-60000});let release;const pending=new Promise(r=>{release=r;});
 const flow=createHeartflow({store,source:{},sessions:async()=>[],dispatch:()=>{},analyze:()=>pending});const result=flow.suggest();await new Promise(r=>setImmediate(r));store.ingest([{id:'m1',chatId:'oc_a',text:'撤销原请求',updatedAt:2}]);release({model:'test',suggestions:[]});await assert.rejects(result,/来源消息已更新/);assert.equal(Object.keys(store.snapshot().proposals).length,0);
});
