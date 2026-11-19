const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {createHeartflowStore}=require('../core/heartflow-store');
const {trackedAnalysis,usageStatus}=require('../core/heartflow-budget');
const {requestBudget,createHeartflowModel}=require('../core/heartflow-model');
function setup(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hf-budget-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return {dir,store:createHeartflowStore({dir})};}
test('budget reserves atomically across concurrent calls, settles actual usage and survives restart',async t=>{
 const {dir,store}=setup(t),context={messages:[]};store.configure({dailyTokenBudget:requestBudget(context)});let release;const wait=new Promise(r=>release=r);let calls=0;
 const run=trackedAnalysis({store,analyze:async()=>{calls++;await wait;return {usage:{input_tokens:100,output_tokens:20,input_tokens_details:{cached_tokens:50}}};}});
 const first=run(context);await assert.rejects(run(context),e=>e.code==='BUDGET_EXHAUSTED');assert.equal(calls,1);assert.equal(usageStatus(createHeartflowStore({dir}).snapshot()).reserved,requestBudget(context));
 release();await first;const u=usageStatus(createHeartflowStore({dir}).snapshot());assert.equal(u.used,120);assert.equal(u.reserved,0);assert.equal(u.cachedTokens,50);
});
test('failed or interrupted requests retain conservative charges; UTC rollover gets a new budget',async t=>{
 const {store}=setup(t);let clock=Date.parse('2026-11-19T23:59:59Z');const context={messages:[]};store.configure({dailyTokenBudget:requestBudget(context)});
 const run=trackedAnalysis({store,now:()=>clock,analyze:async()=>{throw Error('stream lost');}});await assert.rejects(run(context),/stream lost/);assert.equal(usageStatus(store.snapshot(),clock).estimatedTokens,requestBudget(context));await assert.rejects(run(context),e=>e.code==='BUDGET_EXHAUSTED');
 clock+=2000;assert.equal(usageStatus(store.snapshot(),clock).used,0);await assert.rejects(run(context),/stream lost/);
});
test('model usage is charged even when its JSON is invalid, output is bounded',async t=>{
 const {store}=setup(t);let request;
 const analyze=createHeartflowModel({url:'http://local',token:'test',defaultModel:async()=>'model',fetchImpl:async(_u,o)=>{request=JSON.parse(o.body);return new Response('data: '+JSON.stringify({type:'response.completed',response:{usage:{input_tokens:21,output_tokens:9},output:[{content:[{text:'not json'}]}]}})+'\n\n');}});
 await assert.rejects(trackedAnalysis({store,analyze})({messages:[]}),/有效建议/);assert.equal(usageStatus(store.snapshot()).used,30);assert.equal(request.max_output_tokens,2048);
});
test('long message chunks stay pending until every chunk is processed and changed sources invalidate memory',async t=>{
 const {store}=setup(t),base=Date.now();store.configure({since:base-60000,selfId:'me'});store.ingest([{id:'long',chatId:'oc_one',senderId:'peer',text:'配置'.repeat(4000)+'最后撤销',createdAt:base,updatedAt:base}]);
 const contexts=[];const {createHeartflow}=require('../core/heartflow');const flow=createHeartflow({store,source:{},sessions:async()=>[],analyze:async c=>{contexts.push(c);return {suggestions:[],memory:{summary:'历史讨论，仍需核对结论',evidenceMessageIds:['long']},usage:{input_tokens:10,output_tokens:10}};}});
 await flow.suggest();assert.equal(store.snapshot().cursor['analyzed:long'],undefined);await flow.suggest();await flow.suggest();assert.equal(store.snapshot().cursor['analyzed:long'],1);assert.equal(contexts.map(c=>c.messages[0].text).join(''),'配置'.repeat(4000)+'最后撤销');assert.ok(contexts[1].topicMemories.length);
 store.ingest([{id:'long',chatId:'oc_one',text:'改回原样',createdAt:base,updatedAt:base+1}]);await flow.suggest();assert.equal(contexts.at(-1).topicMemories.length,0);
});
test('background history checks coalesce but approval forces fresh evidence and cannot bypass exhausted budget',async t=>{
 const {store}=setup(t),base=Date.now();store.configure({since:base-60000,selfId:'me'});store.ingest([{id:'m',chatId:'oc_one',text:'修改配置',createdAt:base,updatedAt:base}]);const p=store.draft({title:'配置',messageIds:['m'],actions:[{id:'a',sessionId:'s',engine:'codex',machineId:'local',cwd:'/p',prompt:'修改配置'}]});
 let historyCalls=0,models=0;const {createHeartflow}=require('../core/heartflow');const flow=createHeartflow({store,source:{},sessions:async()=>[],history:async()=>{historyCalls++;return {messages:[]};},analyze:async()=>{models++;return {suggestions:[],usage:{input_tokens:10,output_tokens:10}};}});
 await flow.verify();await flow.verify();assert.equal(historyCalls,1);assert.equal(models,1);await flow.verify(p.id,true);assert.equal(historyCalls,2);assert.equal(models,2);
 store.configure({dailyTokenBudget:0});await assert.rejects(flow.review(p.id,{decision:'approve',version:1}),e=>e.code==='BUDGET_EXHAUSTED');assert.equal(Object.keys(store.snapshot().deliveries).length,0);
});
test('budget pause clears after a limit increase without discarding unread messages',async t=>{
 const {store}=setup(t);store.configure({dailyTokenBudget:0});const run=trackedAnalysis({store,analyze:async()=>({usage:{input_tokens:1,output_tokens:1}})});
 await assert.rejects(run({messages:[]}),e=>e.code==='BUDGET_EXHAUSTED');assert.equal(usageStatus(store.snapshot()).paused,true);store.configure({dailyTokenBudget:500000});assert.equal(usageStatus(store.snapshot()).paused,false);await run({messages:[]});assert.equal(usageStatus(store.snapshot()).used,2);
});
test('usage on an unterminated final SSE line is retained',async()=>{
 let observed;const usage={input_tokens:13,output_tokens:5};const analyze=createHeartflowModel({url:'http://local',token:'test',fetchImpl:async()=>new Response('data: '+JSON.stringify({type:'response.completed',response:{usage,output:[{content:[{text:'{"suggestions":[]}'}]}]}}))});const result=await analyze({},'model',{onUsage:u=>observed=u});assert.deepEqual(observed,usage);assert.deepEqual(result.usage,usage);
});
test('incremental summaries retain earlier source dependencies and cannot fabricate references',async t=>{
 const {store}=setup(t);store.ingest([{id:'a',chatId:'oc_one',text:'first',createdAt:1,updatedAt:1},{id:'b',chatId:'oc_one',text:'followup',createdAt:2,updatedAt:2}]);const {saveMemory,suggestionContext}=require('../core/heartflow-compact');
 store.transaction(s=>saveMemory(s,{memory:{summary:'combined',evidenceMessageIds:['b']}},{messages:[s.messages.b],supportingMessages:[],topicMemories:[{refs:[{id:'a',revision:1}]}]},3));
 assert.equal(Object.values(store.snapshot().topicMemories)[0].refs.length,2);store.ingest([{id:'a',chatId:'oc_one',text:'withdrawn',createdAt:1,updatedAt:4}]);const s=store.snapshot();assert.equal(suggestionContext(s,[s.messages.b],[],[]).topicMemories.length,0);
 const before=JSON.stringify(s.topicMemories);store.transaction(s=>saveMemory(s,{memory:{summary:'fake',evidenceMessageIds:['invented']}},{messages:[s.messages.b],supportingMessages:[],topicMemories:[]},5));assert.equal(JSON.stringify(store.snapshot().topicMemories),before);
});
