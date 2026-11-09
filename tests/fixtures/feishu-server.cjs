// Real Panel HTTP/CLI lifecycle, with only the Feishu transport and Claude process replaced.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), Module = require('node:module');
const dir = process.env.CLAUDE_DIR, sent = [], updates = [], handlers = {};
const transport = { on(event, fn) { handlers[event] = fn; }, connect: async () => {}, disconnect: async () => {}, send: async (chatId, content, options) => { const messageId = 'out_' + (sent.length + 1); sent.push({ chatId, content, messageId, options }); return { messageId }; }, updateCard: async (id, card) => { updates.push({ id, card }); } };
const originalLoad = Module._load;
Module._load = function (id, ...rest) { return id === '@larksuiteoapi/node-sdk' ? { createLarkChannel: () => transport, Domain: { Feishu: 0, Lark: 1 }, LoggerLevel: { error: 1 } } : originalLoad.call(this, id, ...rest); };
const cli = path.join(dir, 'mock-cli.cjs');
fs.writeFileSync(cli, `#!${process.execPath}
const fs=require('fs'),path=require('path'),rl=require('readline');
const log=x=>fs.appendFileSync(path.join(process.env.CLAUDE_DIR,'cli-events.jsonl'),JSON.stringify(x)+'\\n');
log({type:'start',args:process.argv.slice(2)});let current,timer;const args=process.argv,id=args[args.indexOf('--session-id')+1]||args[args.indexOf('--resume')+1];
const write=x=>process.stdout.write(JSON.stringify(x)+'\\n');
function complete(){const text=current.message.content.filter(x=>x.type==='text').at(-1).text;const tool='tool_'+current.uuid;
write({type:'assistant',message:{content:[{type:'tool_use',id:tool,name:'Bash',input:{command:'pwd'}}]}});
write({type:'user',message:{content:[{type:'tool_result',tool_use_id:tool,content:'project directory'}]}});
write({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'完成：'+text}}});
const folder=path.join(process.env.CLAUDE_DIR,'projects','mock');fs.mkdirSync(folder,{recursive:true});fs.appendFileSync(path.join(folder,id+'.jsonl'),JSON.stringify({type:'user',cwd:process.cwd(),message:current.message})+'\\n'+JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'完成：'+text}]}})+'\\n');
write({type:'result',session_id:id,result:'done'});current=null;}
rl.createInterface({input:process.stdin}).on('line',line=>{const msg=JSON.parse(line);log(msg);
if(msg.type==='control_response'){if(msg.response.response.behavior==='allow')complete();return;}
if(msg.type==='control_request'){write({type:'control_response',response:{subtype:'success',request_id:msg.request_id,response:{}}});if(current){clearTimeout(timer);write({type:'result',is_error:true,result:'interrupted'});current=null;}return;}
current=msg;const text=msg.message.content.filter(x=>x.type==='text').at(-1).text;
if(text.includes('授权'))write({type:'control_request',request_id:'permit_test',request:{subtype:'can_use_tool',tool_name:'Bash',input:{command:'pwd'}}});else timer=setTimeout(complete,text.includes('慢任务')?1200:50);
}).on('close',()=>process.exit(0));
`);
fs.chmodSync(cli, 0o755); process.env.CLAUDE_CLI = cli;
require('../../server.js');
const base = `http://127.0.0.1:${process.env.PORT}/api/`;
const wait = async fn => { const until = Date.now() + 10000; while (Date.now() < until) { const result = await fn(); if (result) return result; await new Promise(r => setTimeout(r, 25)); } throw new Error('Integration condition timed out'); };
async function api(route, method = 'GET', body) { const r = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }); const data = await r.json(); assert.equal(r.ok, true, JSON.stringify(data)); return data; }
let count = 0;
async function receive(content, extra = {}) { const before = sent.length; handlers.message({ messageId: 'in_' + ++count, senderId: 'ou_owner', chatId: 'oc_private', chatType: 'p2p', content, ...extra }); await wait(() => sent.length > before); }
(async () => {
 await wait(async () => { try { return (await fetch(base + 'feishu')).ok; } catch { return false; } });
 await api('feishu', 'PUT', { enabled: true, appId: 'cli_mock_test', appSecret: 'test-secret', defaultProject: dir });
 await receive((await api('feishu/pairing', 'POST', {})).command); await receive('/new 请授权后检查项目');
 const formMessage = sent.at(-1), form = formMessage.content.card.body.elements.find(item=>item.tag==='form');
 assert.equal(form.elements.find(item=>item.name==='prompt').default_value,'请授权后检查项目');
 const submit = form.elements.find(item=>item.tag==='button').behaviors[0].value;
 const checkpoint = (await api('workspaces')).selfId;
 await handlers.cardAction({messageId:formMessage.messageId,chatId:'oc_private',operator:{openId:'ou_owner'},action:{tag:'button',value:submit},raw:{action:{form_value:{machineId:checkpoint,workspaceId:'__directory__',cwd:dir,engine:'claude',prompt:'请授权后检查项目',model:'__default__',worktree:'original'}}}});
 await wait(() => updates.some(x => JSON.stringify(x.card).includes('已完成') && JSON.stringify(x.card).includes('完成：请授权后检查项目')));
 assert.match(JSON.stringify(updates.at(-1)), /project directory/);
 const sessions = await api('sessions'); assert.equal(sessions.items.length, 1); const id = sessions.items[0].key;
 await receive('/rename 我的远程项目'); await wait(async () => (await api('sessions')).items[0].name === '我的远程项目');
 await receive('慢任务'); await receive('/queue 排队消息'); await receive('/steer 改为新方向');
 await wait(() => updates.some(x => JSON.stringify(x.card).includes('完成：排队消息')));
 const log = fs.readFileSync(path.join(dir, 'cli-events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(log.filter(x => x.type === 'start').length, 1, 'all Feishu turns share one actual CLI process');
 assert.ok(log.find(x => x.type === 'start').args.includes('--dangerously-skip-permissions'));
 assert.ok(!log.find(x => x.type === 'start').args.includes('--permission-prompt-tool'));
 assert.ok(log.some(x => x.type === 'control_response' && x.response.request_id === 'permit_test' && x.response.response.behavior === 'allow'));
 assert.ok(!updates.some(x => JSON.stringify(x.card).includes('允许本次调用')), 'default mode never waits for a tool approval card');
 assert.equal(log.filter(x => x.type === 'user').length, 4); assert(log.some(x => x.type === 'control_request' && x.request.subtype === 'interrupt'));
 await receive('/sessions'); assert.match(JSON.stringify(sent.at(-1)), /我的远程项目/);
 await receive('/history'); assert.match(JSON.stringify(sent.at(-1)), /完成：排队消息/); assert.doesNotMatch(JSON.stringify(sent.at(-1)), /飞书发送上下文|feishu\/reply/);
 const forbidden = await fetch(base + 'feishu', { headers: { Origin: 'https://example.com' } }); assert.equal(forbidden.status, 403);
 const safe = await api('feishu'); assert.equal(JSON.stringify(safe).includes('test-secret'), false);
 const labelled = await api('feishu/contacts/label', 'POST', { id: 'ou_owner', label: 'Integration user' }); assert.equal(labelled.inbox.users.find(item => item.id === 'ou_owner').displayName, 'Integration user');
 const syncNames = await api('feishu/contacts/refresh', 'POST', {}); assert.equal(typeof syncNames.nameRefresh.updated, 'number');
 const revealed = await api('feishu/secret', 'POST', {}); assert.equal(revealed.appSecret, 'test-secret');
 const blockedSecret = await fetch(base + 'feishu/secret', { method: 'POST', headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(blockedSecret.status, 403);
 const secretResponse = await fetch(base + 'feishu/secret', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(secretResponse.headers.get('cache-control'), 'no-store');

 const initialContext = log.find(x => x.type === 'user').message.content[0].text;
 assert.match(initialContext, /oc_private/);
 const queuedContext = log.filter(x => x.type === 'user').at(-1).message.content[0].text;
 assert.notEqual(initialContext.match(/"token":"([a-f0-9]+)"/)[1], queuedContext.match(/"token":"([a-f0-9]+)"/)[1]);
 await api('feishu', 'PUT', { allowedChatIds: ['oc_group'] });
 await receive('群话题发卡片', { chatId: 'oc_group', chatType: 'group', threadId: 'omt_topic', mentionedBot: true });
 const groupTurn = await wait(() => fs.readFileSync(path.join(dir, 'cli-events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).find(x => x.type === 'user' && x.message.content.at(-1).text === '群话题发卡片'));
 const context = groupTurn.message.content[0].text, token = context.match(/"token":"([a-f0-9]+)"/)[1];
 assert.match(context, /oc_group/); assert.match(context, /omt_topic/); assert.match(context, /cli_mock_test/);
 assert.equal(groupTurn.message.content.at(-1).text, '群话题发卡片');
 const result = await api('feishu/reply', 'POST', { token, card: { schema: '2.0', body: { elements: [{ tag: 'markdown', content: '话题卡片' }] } } });
 assert.equal(result.chatId, 'oc_group'); assert.equal(result.threadId, 'omt_topic');
 assert.equal(sent.at(-1).chatId, 'oc_group'); assert.equal(sent.at(-1).options.replyInThread, true); assert.match(sent.at(-1).options.replyTo, /^in_/);
 const override = await fetch(base+'feishu/reply', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({token,text:'wrong recipient',chatId:'oc_private'}) }); assert.equal(override.status, 400);
 const crossSite = await fetch(base+'feishu/reply', {method:'POST',headers:{'Content-Type':'application/json',Origin:'https://example.com'},body:JSON.stringify({token,text:'cross-site'})}); assert.equal(crossSite.status,403);
 console.log('FEISHU_INTEGRATION_OK ' + id);
 process.kill(process.pid, 'SIGTERM');
})().catch(e => { console.error(e); process.exitCode = 1; process.kill(process.pid, 'SIGTERM'); });
