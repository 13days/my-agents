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
 let context;const flow=createHeartflow({store,source:{},sessions:async()=>[{id:'known',engine:'codex',machineId:'mac',project:'/work'}],analyze:async c=>{if(c.mode!=='followup')context=c;return {model:'test',suggestions:[{title:'修改',summary:'默认值',reason:'@用户',messageIds:['m3'],actions:[action('a','invented')]}]};},dispatch:()=>{throw Error('must not execute');}});
 await flow.suggest();assert.equal(context.learning.length,1);assert.ok([...context.messages,...context.supportingMessages].some(m=>m.id==='m4')); assert.equal(Object.values(store.snapshot().proposals).at(-1).actions.length,0);
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
 const proposal = { id: 'p', version: 3, title: '任务', summary: '说明', reason: '相关', actions: [action('a')] };
 const decisions = () => {
   const values = [];
   JSON.stringify(heartflowCard({ proposal, owner: 'owner', coordinator: 'mac' }), (key, value) => {
     if (value?.type === 'callback') values.push(value.value);
     return value;
   });
   return values;
 };
 assert.deepEqual(decisions().find(value => value.decision === 'approve'), { action: 'heartflow_review', id: 'p', version: 3, owner: 'owner', coordinator: 'mac', decision: 'approve' });
 proposal.actions[0].prompt = 'x'.repeat(17000);
 assert.ok(decisions().every(value => value.decision !== 'approve'));
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

test('concurrent notices send once and later versions update the same receipt',async t=>{
 const {store}=setup(t);store.configure({notifyEnabled:true,notifyUserId:'ou_owner'});const p=draft(store),seen=[];
 const flow=createHeartflow({store,source:{},sessions:async()=>[],notify:async p=>{seen.push(p.noticeMessageId);await new Promise(r=>setTimeout(r,5));return {messageId:'card-1'};}});
 await Promise.all([flow.notices(),flow.notices()]);store.review(p.id,{version:1,decision:'save'});await flow.notices();assert.deepEqual(seen,[undefined,'card-1']);
});
test('later reversal closes the exact action with evidence and invalidates old approvals',async t=>{
 const {store}=setup(t),p=draft(store),timestamp=new Date(Date.now()+1000).toISOString();
 const flow=createHeartflow({store,source:{},sessions:async()=>[],history:async()=>({messages:[{role:'user',timestamp,text:'这个改回来吧，先保持原样，不用关了'}]}),analyze:async c=>({suggestions:[],resolutions:[{actionId:p.actions[0].id,sessionId:'session-a',status:'superseded',reason:'用户已撤回',evidence:[{messageId:c.transcripts[0].messages[0].id,quote:'这个改回来吧，先保持原样，不用关了'}]}]})});
 await flow.verify();const next=store.snapshot().proposals[p.id];assert.equal(next.state,'superseded');assert.equal(next.actions.length,0);assert.equal(next.resolutions.length,1);assert.throws(()=>store.review(p.id,{version:1,decision:'approve'}),/已经更新/);assert.ok(!JSON.stringify(heartflowCard({proposal:next})).includes('heartflow_review'));
});
test('fabricated evidence and checkpoint transcripts cannot resolve work',async t=>{
 const {store}=setup(t),p=draft(store);let checkpoint=false;
 const flow=createHeartflow({store,source:{},sessions:async()=>[],history:async()=>({checkpoint,messages:[]}),analyze:async()=>({suggestions:[],resolutions:[{actionId:p.actions[0].id,sessionId:'session-a',status:'completed',evidence:[{messageId:'invented',quote:'已经完成整个需求'}]}]})});
 await flow.verify();assert.equal(store.snapshot().proposals[p.id].state,'pending');checkpoint=true;await assert.rejects(flow.verify(p.id,true),/实时记录/);
});
test('failed card updates never fall back to sending another card',async t=>{
 const {store}=setup(t);store.configure({notifyEnabled:true,notifyUserId:'ou_owner'});const p=draft(store);let calls=0;
 const flow=createHeartflow({store,source:{},sessions:async()=>[],notify:async p=>{calls++;if(p.noticeMessageId)throw Error('update failed');return {messageId:'card-1'};}});
 await flow.notices();store.review(p.id,{version:1,decision:'save'});await flow.notices();await flow.notices();assert.equal(calls,2);assert.equal(store.snapshot().proposals[p.id].noticeMessageId,'card-1');
});
test('partial history resolution preserves other actions and checkpoint checks block approval',async t=>{
 const {store}=setup(t),p=draft(store,[action('a'),action('b','session-b')]);let checkpoint=false;
 const flow=createHeartflow({store,source:{},sessions:async()=>[],history:async()=>({checkpoint,messages:[{role:'user',timestamp:new Date(Date.now()+1000).toISOString(),text:'这个改回来吧，先保持原样，不用关了'}]}),analyze:async c=>c.mode==='followup'?{suggestions:[],resolutions:[]}:({suggestions:[],resolutions:[{actionId:'a',sessionId:'session-a',status:'superseded',reason:'撤回',evidence:[{messageId:c.transcripts[0].messages[0].id,quote:'这个改回来吧，先保持原样，不用关了'}]}]})});
 await flow.verify();assert.equal(store.snapshot().proposals[p.id].state,'pending');assert.deepEqual(store.snapshot().proposals[p.id].actions.map(a=>a.id),['b']);checkpoint=true;await assert.rejects(flow.review(p.id,{version:2,decision:'approve'}),/实时记录/);assert.equal(Object.keys(store.snapshot().deliveries).length,0);
});

test('group followup supersedes a pending action without any session history',async t=>{
 const {store}=setup(t),p=draft(store),at=Date.now()+1000;
 store.ingest([{id:'later',chatId:'oc_a',parentId:'m1',senderId:'requester',senderName:'请求人',text:'结论：先不做默认回复模式的限制，取消刚刚的配置',createdAt:at,updatedAt:at}]);
 let calls=0;const flow=createHeartflow({store,source:{},sessions:async()=>[],analyze:async c=>{calls++;assert.equal(c.mode,'followup');assert.equal(c.messages.find(m=>m.id==='later').senderName,'请求人');return {suggestions:[],resolutions:[{actionId:p.actions[0].id,status:'superseded',reason:'请求人明确取消',evidence:[{messageId:'later',quote:'先不做默认回复模式的限制，取消刚刚的配置'}]}]};}});
 await flow.followups();await flow.followups();const next=store.snapshot().proposals[p.id];assert.equal(calls,1);assert.equal(next.state,'superseded');assert.equal(next.resolutions[0].evidence[0].senderId,'requester');assert.ok(next.messageIds.includes('later'));await assert.rejects(flow.review(p.id,{version:1,decision:'approve'}));
});
test('broad topic candidates allow the model to reject other topics and cache unchanged checks',async t=>{
 const {store}=setup(t),p=draft(store);
 store.ingest([{id:'other',chatId:'oc_a',parentId:'unrelated',senderId:'someone',text:'取消别的项目的配置修改',createdAt:Date.now()+1000,updatedAt:1}]);
 let calls=0;const flow=createHeartflow({store,source:{},sessions:async()=>[],analyze:async c=>{calls++;assert.ok(c.messages.some(m=>m.id==='other'));return {suggestions:[],resolutions:[]};}});
 await flow.followups();await flow.followups();assert.equal(calls,1);assert.equal(store.snapshot().proposals[p.id].state,'pending');
});
test('names enrich existing sender identities without changing source versions',t=>{
 const {store}=setup(t);const base={message_id:'identity',chat_id:'oc_a',sender:{id:'ou_person'},create_time:String(Date.now()),body:{content:'{"text":"原消息"}'}};
 store.ingest([normalizeMessage(base)]);const revision=store.snapshot().messages.identity.revision;
 store.ingest([normalizeMessage({...base,message_id:'mention',sender:{id:'ou_other'},mentions:[{id:'ou_person',name:'张三',key:'@_1'}]})]);
 store.ingest([normalizeMessage(base)]);assert.equal(store.snapshot().messages.identity.senderName,'张三');assert.equal(store.snapshot().messages.identity.revision,revision);
});

test('unthreaded decisions without mentions update a topic and invalidate old approval',async t=>{
 const {store}=setup(t),p=draft(store);
 store.ingest([{id:'decision',chatId:'oc_a',senderId:'owner',text:'最终只调整团队版本，个人版本保持原样',createdAt:Date.now()+1000,updatedAt:1}]);
 const flow=createHeartflow({store,source:{},sessions:async()=>[],analyze:async c=>{assert.ok(c.messages.some(m=>m.id==='decision'));return {suggestions:[],topic:{status:'changed',summary:'范围改为团队版本',evidence:[{messageId:'decision',quote:'最终只调整团队版本，个人版本保持原样'}]},resolutions:[]};}});
 await flow.followups();const next=store.snapshot().proposals[p.id];assert.equal(next.topic.status,'changed');assert.equal(next.version,2);assert.equal(next.sourceChanged,true);await assert.rejects(flow.review(p.id,{version:2,decision:'approve'}),/核对并保存/);assert.equal(Object.keys(store.snapshot().deliveries).length,0);
});
test('topic retrieval keeps sources, expands same-chat discussion, and limits cross-chat links',t=>{
 const {topicContext}=require('../core/heartflow-context');const {store}=setup(t);const at=Date.now();
 store.ingest([{id:'anchor',chatId:'oc_a',senderId:'me',text:'处理 https://example.com/tasks/123',createdAt:at,updatedAt:1},
 {id:'cross',chatId:'oc_b',senderId:'other',text:'https://example.com/tasks/123 范围已经变了',createdAt:at+1,updatedAt:1},
 {id:'irrelevant',chatId:'oc_c',text:'取消另一个任务 https://example.com/tasks/999',createdAt:at+2,updatedAt:1}]);
 const s=store.snapshot(),ids=topicContext([s.messages.anchor],s).map(m=>m.id);assert.ok(ids.includes('anchor'));assert.ok(ids.includes('cross'));assert.ok(!ids.includes('irrelevant'));
});
test('a new followup arriving during interpretation prevents applying a stale conclusion',async t=>{
 const {store}=setup(t),p=draft(store);let release;const model=new Promise(r=>release=r);
 const flow=createHeartflow({store,source:{},sessions:async()=>[],analyze:()=>model});const result=flow.followups();await new Promise(r=>setImmediate(r));store.ingest([{id:'newer',chatId:'oc_a',senderId:'me',text:'仍然按原方案执行，不撤回',createdAt:Date.now()+1000,updatedAt:1}]);release({suggestions:[],resolutions:[]});await assert.rejects(result,/群聊消息已变化/);assert.equal(store.snapshot().proposals[p.id].state,'pending');
});

test('feedback on a resolved proposal is retained for learning without reopening or executing work',t=>{
 const {store}=setup(t),p=draft(store);const resolved=store.review(p.id,{version:1,decision:'ignore'});
 const check=store.feedback(p.id,{version:resolved.version,reason:'取消的是其他需求，这件事仍需跟进'});
 assert.equal(check.decision,'feedback');assert.equal(check.learning,true);assert.equal(check.before.state,'ignored');assert.equal(store.snapshot().proposals[p.id].state,'ignored');assert.equal(Object.keys(store.snapshot().deliveries).length,0);
 assert.throws(()=>store.feedback(p.id,{version:1,reason:'旧版本'}),/已经更新/);assert.throws(()=>store.feedback(p.id,{version:resolved.version,reason:' '}));
});

test('automatic discovery reads private chats outside the selected list and keeps live/history cursors separate',async t=>{
 const {store}=setup(t),base=Date.now();store.configure({since:base-86400000,selfId:'me',discoveryMode:'recent',chats:[]});let calls=[];
 const source={recent:async(floor,upper,page)=>{calls.push({floor,upper,page});return {messages:[{message_id:'dm-'+upper,chat_id:'oc_private',create_time:String(upper-1000),sender:{id:'peer',sender_type:'user'},msg_type:'text',body:{content:'{"text":"请检查配置，我已经提交发布"}'}}],has_more:false};}};
 const flow=createHeartflow({store,source,now:()=>base,sessions:async()=>[],analyze:async c=>{assert.ok(c.messages.some(m=>m.chatId==='oc_private'));return {suggestions:[]};}});
 await flow.sync();assert.equal(calls.length,2);assert.equal(calls[0].floor,base-20*60000);assert.equal(calls[1].upper,base-10*60000);assert.equal(store.snapshot().cursor.discovery.history.done,true);
 await flow.suggest();assert.equal(Object.keys(store.snapshot().deliveries).length,0);
 await flow.sync();assert.equal(calls.length,3);
});
test('discovery persists bounded pagination, excludes app messages, deduplicates overlaps, and never advances on failure',async t=>{
 const {store}=setup(t),base=Date.now();store.configure({since:base-60000,selfId:'me',discoveryMode:'recent'});let fail=false;
 const source={recent:async(floor,upper,page)=>{if(fail)throw Error('read unavailable');return {messages:[{message_id:'dm',chat_id:'oc_dm',create_time:String(base-1000),sender:{sender_type:'user'},body:{content:'{"text":"hello"}'}},{message_id:'bot',chat_id:'oc_bot',create_time:String(base-1000),sender:{sender_type:'app'},body:{content:'{"text":"notification"}'}}],has_more:true,page_token:String(Number(page||0)+1)};}};
 const flow=createHeartflow({store,source,now:()=>base});await flow.sync();let s=store.snapshot();assert.equal(s.cursor.discovery.live.page,'2');assert.equal(s.messages.dm.revision,1);assert.equal(s.messages.bot,undefined);assert.equal(s.cursor.discovery.history.done,true);
 fail=true;await assert.rejects(()=>flow.sync(),/read unavailable/);assert.deepEqual(store.snapshot().cursor.discovery,s.cursor.discovery);assert.equal(store.snapshot().source.ok,false);
 fail=false;await flow.sync();assert.equal(store.snapshot().cursor.discovery.live.page,'4');assert.equal(store.snapshot().messages.dm.revision,1);
});
test('switching back to selected chats excludes discovered messages from analysis and topic context',async t=>{
 const {store}=setup(t),base=Date.now();store.configure({since:base-60000,chats:[{id:'oc_a'}],discoveryMode:'recent'});
 store.ingest([{id:'private',chatId:'oc_private',text:'Private followup',createdAt:base,updatedAt:base}]);
 const {topicContext}=require('../core/heartflow-context');assert.ok(topicContext([store.snapshot().messages.private],store.snapshot()).some(m=>m.id==='private'));
 store.configure({discoveryMode:'selected'});let context;
 await createHeartflow({store,source:{},sessions:async()=>[],analyze:async c=>{context=c;return {suggestions:[]};}}).suggest();assert.ok(context.messages.every(m=>m.chatId==='oc_a'));assert.throws(()=>store.configure({discoveryMode:'all-ever'}),/有效/);
});
test('personal discovery uses a bounded empty-query user message search, including pagination',async()=>{
 let command;const {createPersonalFeishu}=require('../core/heartflow-feishu');const source=createPersonalFeishu({execute:(cli,args,options,cb)=>{command=args;cb(null,JSON.stringify({status:'success',data:{messages:[],has_more:false}}));}});
 await source.recent(10001,20001,'next');const payload=JSON.parse(command[command.indexOf('--body-json')+1]);assert.equal(payload.query,'');assert.deepEqual(payload.filter,{from_create_time:'10',to_create_time:'21'});assert.equal(command.at(-1),'next');assert.ok(!command.includes('--compact'));
});
test('analysis alternates old and new topic batches without mixing chats',async t=>{
 const {store}=setup(t),base=Date.now();store.transaction(s=>{s.messages={};});store.configure({since:base-60000,discoveryMode:'recent'});store.ingest(Array.from({length:80},(_,i)=>({id:'bulk'+i,chatId:'oc_new',text:'Update '+i,createdAt:base-1000+i,updatedAt:base})));
 const contexts=[];const flow=createHeartflow({store,source:{},sessions:async()=>[],analyze:async c=>{contexts.push(c);return {suggestions:[],usage:{input_tokens:100,output_tokens:10}};}});
 await flow.suggest();await flow.suggest();assert.ok(contexts.every(c=>c.messages.length<=12));assert.ok(contexts[0].messages.some(m=>m.id==='bulk0'));assert.ok(contexts[1].messages.some(m=>m.id==='bulk79'));
});

test('expired discovery cursor restarts the same window and deduplicates existing messages',async t=>{
 const {store}=setup(t),base=Date.now();store.configure({since:base-60000,selfId:'me',discoveryMode:'recent'});
 store.transaction(s=>{s.cursor.discovery={live:{floor:base-60000,upper:base,page:'expired'},history:{done:true}};});
 const calls=[];const flow=createHeartflow({store,now:()=>base,source:{recent:async(floor,upper,page)=>{
 calls.push({floor,upper,page});if(page==='expired')throw Error('page_token is invalid or expired, please start a new search');
 return {messages:[{message_id:'fresh',chat_id:'oc_a',create_time:String(base),body:{content:'{"text":"新消息"}'}}],has_more:false};}}});
 await flow.sync();assert.deepEqual(calls.map(c=>c.page),['expired',undefined]);assert.ok(calls.every(c=>c.floor===base-60000&&c.upper===base));
 assert.equal(store.snapshot().cursor.discovery.live.watermark,base);await flow.sync();assert.equal(store.snapshot().messages.fresh.revision,1);
});
test('failed live discovery does not starve history or selected chats',async t=>{
 const {store}=setup(t),base=Date.now();store.configure({since:base-86400000,selfId:'me',discoveryMode:'recent',chats:[{id:'oc_selected'}]});let pages=0;
 const flow=createHeartflow({store,now:()=>base,source:{recent:async(floor,upper)=>{
 if(upper===base)throw Error('live unavailable');return {messages:[],has_more:false};
 },page:async()=>{pages++;return {messages:[],has_more:false};}}});
 await assert.rejects(flow.sync(),/live unavailable/);assert.equal(pages,1);assert.equal(store.snapshot().cursor.discovery.history.done,true);assert.equal(store.snapshot().source.ok,false);
});
test('unchanged store transactions preserve revision and do not rewrite the data file',t=>{
 const {dir,store}=setup(t),file=path.join(dir,'panel-heartflow.json');const revision=store.revision(),before=fs.statSync(file);
 store.transaction(()=>{});assert.equal(store.revision(),revision);assert.equal(fs.statSync(file).ino,before.ino);
 store.configure({enabled:true});assert.notEqual(store.revision(),revision);assert.equal(createHeartflowStore({dir}).snapshot().config.enabled,true);
 assert.notEqual(createHeartflowStore({dir}).revision(),store.revision());
});

test('revoked personal grants pause scheduled reads and manual reauthorization resumes the same cursor', async t => {
 const {store}=setup(t); let reads=0,revoked=true;
 store.configure({selfId:'me',discoveryMode:'recent',chats:[{id:'oc_a'}]});
 const source={identity:async()=>({user:{open_id:'me'}}), recent:async()=>{reads++;if(revoked)throw Error('invalid_grant 20064');return {messages:[]};},page:async()=>({messages:[]})};
 const flow=createHeartflow({store,source,sessions:async()=>[]});
 await assert.rejects(flow.sync(),/invalid_grant/); const cursor=store.snapshot().cursor;
 assert.equal(reads,1);assert.equal(store.snapshot().source.authRequired,true);
 assert.deepEqual(await flow.sync({automatic:true}),{authRequired:true});assert.equal(reads,1);assert.deepEqual(store.snapshot().cursor,cursor);
 revoked=false;await flow.sync();assert.equal(store.snapshot().source.authRequired,false);
 assert.ok(store.snapshot().source.lastSync);
});
