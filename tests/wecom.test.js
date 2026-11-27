const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { WebSocketServer } = require('ws');
const { connectWecom } = require('../channels/wecom-socket');
const { createWecom } = require('../channels/wecom');
const { createChatJob } = require('../core/chat-job');

async function until(check) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await delay(10);
  }
  throw Error('Timed out waiting for local WeCom test transport');
}
test('WeCom long connection authenticates, fences membership and resumes only the matching conversation', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-panel-'));
  const peer = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(peer, 'listening');
  const url = 'ws://127.0.0.1:' + peer.address().port;
  const replies = [], turns = [], sessions = new Map();
  let ws, subscriptions = 0, rejectAuth = false, isLeader = true, rejectStream = '';
  peer.on('connection', connection => {
    ws = connection;
    connection.on('message', raw => {
      const frame = JSON.parse(raw);
      if (frame.cmd === 'aibot_subscribe') {
        subscriptions++;
        assert.deepEqual(frame.body, { bot_id:'bot-1', secret:'fixture-secret' });
      } else replies.push(frame);
      connection.send(JSON.stringify({ headers:frame.headers, errcode:rejectAuth ? 40013 : (frame.cmd === 'aibot_respond_msg' && frame.headers.req_id === rejectStream ? 40099 : 0) }));
    });
  });
  const gateway = createWecom({
    dir, canStart: () => isLeader, connect: opts => connectWecom({ ...opts, url }),
    panel: {
      validateTarget: async () => ({cwd: '/project'}),
      async submit(input) {
        const sessionId = input.sessionId || 'session-' + (sessions.size + 1);
        if (!sessions.has(sessionId)) sessions.set(sessionId, createChatJob({sessionId}));
        turns.push({ ...input, sessionId });
        return input.prompt === 'two' ? { sessionId, machineId: 'devbox', engine: 'codex' } : { sessionId };
      },
      watch: (id, fn) => sessions.get(id).listen(fn),
    },
  });
  t.after(async () => {
    gateway.stop();
    for (const client of peer.clients) client.terminate();
    await new Promise(resolve => peer.close(resolve));
    fs.rmSync(dir, { recursive:true, force:true });
  });
  const send = (id, content, extra = {}) => ws.send(JSON.stringify({
    cmd:'aibot_msg_callback', headers:{req_id:id}, body:{
      aibotid:'bot-1', msgid:id, chattype:'single', from:{userid:'owner'}, msgtype:'text', text:{content}, ...extra,
    },
  }));
  const frames = id => replies.filter(frame => frame.headers.req_id === id);
  const final = id => until(() => frames(id).find(frame => frame.body.stream.finish));
  const waitTurn = id => until(() => turns.find(turn => turn.prompt === id));
  function finish(turn, text) {
    const job = sessions.get(turn.sessionId), messageId = turn.messageId;
    job.publish('text', {messageId, text});
    job.publish('done', {messageId});
  }

  gateway.start();
  assert.equal(gateway.status().phase, 'disabled');
  await assert.rejects(() => gateway.configure({allowedUsers:[' * ']}));
  await gateway.configure({enabled:true, botId:'bot-1', secret:'fixture-secret', engine:'claude', allowedUsers:['teammate'], workspaceId:'design'});
  await until(() => gateway.status().phase === 'connected');
  assert.equal(gateway.status().config.hasSecret, true);
  assert.ok(!JSON.stringify(gateway.status()).includes('fixture-secret'));
  assert.equal(fs.statSync(path.join(dir,'panel-wecom.json')).mode & 0o777, 0o600);
  send('invalid', 'wrong-bot', {aibotid:'another'});
  ws.send(JSON.stringify({cmd:'aibot_event_callback', headers:{req_id:'welcome'},body:{aibotid:'bot-1',from:{userid:'visitor'},event:{eventtype:'enter_chat'}}}));
  await until(() => frames('welcome').some(f=>f.cmd==='aibot_respond_welcome_msg'));
  assert.equal(gateway.status().ownerUserId,'');
  send('claim','/whoami');
  send('group-stranger','unauthorized',{chattype:'group',chatid:'group1',from:{userid:'stranger'}});
  send('private-stranger','identity',{from:{userid:'stranger'}});
  assert.match((await final('private-stranger')).body.stream.content, /UserID 是 stranger/);
  assert.equal(gateway.status().ownerUserId,'owner');
  assert.match((await final('claim')).body.stream.content,/Owner/);
  send('unsupported','',{msgtype:'voice'});
  assert.match((await final('unsupported')).body.stream.content, /文字/);
  assert.equal(turns.length,0);
  send('a','one'); send('a','one'); send('b','two');
  const one = await waitTurn('one'), two = await waitTurn('two');
  assert.equal(one.engine,'claude'); assert.equal(one.workspaceId,'design');
  assert.equal(two.sessionId,one.sessionId); assert.equal(two.mode,'queue');
  sessions.get(one.sessionId).publish('permission',{messageId:one.messageId,id:'approval'});
  finish(one,'first result'); finish(two,'second result');
  assert.equal((await final('a')).body.stream.content,'first result');
  assert.equal((await final('b')).body.stream.content,'second result\n\n执行机器：devbox · codex');
  assert.deepEqual(frames('a').map(f => f.body.stream.finish),[false,false,true]);
  assert.equal(new Set(frames('a').map(f => f.body.stream.id)).size,1);
  assert.equal(frames('invalid').length + frames('group-stranger').length,0);
  assert.equal(turns.length,2);

  send('c','group task',{chattype:'group',chatid:'group1'});
  send('d','other member',{chattype:'group',chatid:'group1',from:{userid:'teammate'}});
  const group = await waitTurn('group task'), other = await waitTurn('other member');
  assert.notEqual(group.sessionId,other.sessionId); assert.notEqual(group.sessionId,one.sessionId);
  finish(group,'答'.repeat(9000));
  const clipped = (await final('c')).body.stream.content;
  assert.ok(Buffer.byteLength(clipped)<=20480); assert.match(clipped,/完整结果/);
  await gateway.configure({allowedUsers:[]}); finish(other,'private answer');
  send('new','/new'); await final('new'); send('e','fresh');
  const fresh = await waitTurn('fresh'); assert.notEqual(fresh.sessionId,one.sessionId);
  assert.ok(!frames('d').some(f=>f.body.stream.finish));
  finish(fresh,'ok'); await final('e');
  gateway.stop(); gateway.reload(); isLeader=false; gateway.start();
  assert.equal(gateway.status().phase,'disabled'); isLeader=true; gateway.start();
  await until(()=>gateway.status().phase==='connected');
  send('e','fresh'); send('after','after restart');
  const recovered=await waitTurn('after restart');
  assert.equal(recovered.sessionId,fresh.sessionId); assert.equal(turns.filter(t=>t.prompt==='fresh').length,1);
  finish(recovered,'ready'); await final('after');
  await until(()=>gateway.status().activity.stage==='replied');
  rejectStream='rejected';
  send('rejected','rejected stream');
  finish(await waitTurn('rejected stream'),'原聊天的回复');
  await until(()=>replies.some(f=>f.cmd==='aibot_send_msg' && f.body.chatid==='owner' && f.body.markdown.content==='原聊天的回复'));
  await until(()=>gateway.status().activity.stage==='replied');
  const before = subscriptions; ws.terminate();
  await until(()=>subscriptions>before && gateway.status().phase==='connected');
  ws.send(JSON.stringify({cmd:'aibot_event_callback',headers:{req_id:'kick'},body:{event:{eventtype:'disconnected_event'}}}));
  await until(()=>gateway.status().phase==='error');
  rejectAuth=true; await gateway.configure({enabled:true});
  await until(()=>gateway.status().phase==='error' && gateway.status().lastError.includes('40013'));
  await gateway.configure({enabled:false}); assert.equal(gateway.status().phase,'disabled');
});

test('owner survives restart, is scoped to the bot, and migrates a single historical sender', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-owner-'));
  t.after(()=>fs.rmSync(dir, {recursive:true, force:true}));
  const legacy = {bindings:{[JSON.stringify(['old',null,'past'])]:{id:'sample'}}, seen:[], lastMessageAt:0};
  fs.writeFileSync(path.join(dir,'panel-wecom-state.json'), JSON.stringify(legacy));
  let connection, leader=true;
  const gateway=createWecom({dir, panel:{}, canStart:()=>leader, connect: opts=>{ connection=opts; return {close(){}}; }});
  const use=botId=>gateway.configure({enabled:true,botId,secret:'test-secret'});
  await use('old');
  assert.equal(gateway.status().ownerUserId,'past');
  await use('__proto__');
  const message={aibotid:'__proto__',msgid:'one',from:{userid:'new-owner'},chattype:'single',msgtype:'text',text:{content:'/whoami'}};
  const replies=[];
  const reply=async (...args)=>{replies.push(args);};
  leader=false;
  connection.onMessage(message,reply);
  assert.equal(gateway.status().ownerUserId,'');
  leader=true;
  connection.onMessage(message,reply);
  connection.onMessage({...message,msgid:'two',from:{userid:'another'}},reply);
  await until(()=>replies.length===2);
  assert.equal(gateway.status().ownerUserId,'new-owner');
  await use('old'); gateway.stop(); gateway.reload(); gateway.start();
  assert.equal(gateway.status().ownerUserId,'past');
  await use('__proto__'); assert.equal(gateway.status().ownerUserId,'new-owner');
  gateway.stop();
});

test('WeCom voice, quotes, session handoff and status respect the bot, member and chat', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-handoff-'));
  const turns = [], catalogQueries = [];
  const terminal = {id:'terminal-session', title:'Review design-kit', engine:'codex', machineId:'linux', project:'/projects/design-kit'};
  let connection, seq = 0, permitResume = true;
  const gateway = createWecom({
    dir, canStart: () => true,
    connect(opts) { connection = opts; return {close() {}}; },
    panel: {
      engines: () => [{id:'codex', label:'Codex'}],
      machineLabel: () => 'Linux 服务器',
      validateTarget: async ({machineId, cwd}) => {
        if (machineId !== 'linux' || cwd !== '/project') throw Error('机器或目录不可用');
        return {cwd};
      },
      models: async () => ({models:[{id:'allowed-model'}]}),
      async sessionCatalog({query}) {
        catalogQueries.push(query);
        return {sessions: permitResume && (!query || terminal.id.includes(query) || terminal.title.includes(query)) ? [terminal] : [], unavailable: []};
      },
      async resolveSession(id, row) { assert.deepEqual(row, terminal); return row; },
      sessionStatus(id) { assert.equal(id, terminal.id); return '正在执行'; },
      async submit(input) {
        if (input.prompt === 'fail submission') throw Error('offline');
        const sessionId = input.sessionId || 'chat-' + seq;
        turns.push({...input, sessionId}); return {sessionId, engine:'codex', machineId:'linux'};
      },
      watch(id, notify) {
        const {messageId} = turns.at(-1);
        notify('done', {messageId}); return () => {};
      },
    },
  });
  t.after(() => { gateway.stop(); fs.rmSync(dir,{recursive:true,force:true}); });
  const send = (text, fields = {}) => new Promise(resolve => {
    connection.onMessage({
      aibotid:'working', msgid:String(++seq), chattype:'single', from:{userid:'owner'}, msgtype:'text', text:{content:text}, ...fields,
    }, async (_, content, final) => { if (final) resolve(content); });
  });
  await gateway.configure({enabled:true, botId:'working', secret:'fixture', allowedUsers:['colleague']});
  await assert.rejects(() => gateway.configure({ownerSessionCatalog:true}), /Owner/);
  await send('/whoami');
  assert.match(await send('/status'), /没有可用会话/);
  assert.match(await send('/sessions'), /没有会话/);
  assert.deepEqual(catalogQueries, []);
  await assert.rejects(gateway.configure({cwd:'/project'}), /指定一台/);
  await assert.rejects(gateway.configure({machineId:'wrong', cwd:'/project'}), /不可用/);
  await assert.rejects(gateway.configure({machineId:'linux', cwd:'/project', model:'missing'}), /模型/);
  assert.equal(gateway.status().config.machineId, '');
  await gateway.configure({machineId:'linux', cwd:'/project', model:'allowed-model', worktree:true});
  await send('', {msgtype:'voice', voice:{content:'Prepare release notes'}, quote:{msgtype:'text', text:{content:'Mention design-kit'}}});
  const first = turns.at(-1);
  assert.deepEqual([first.machineId, first.cwd, first.model, first.worktree], ['linux','/project','allowed-model',true]);
  assert.equal(gateway.status().receipts[0].sender, 'owner');
  await until(() => gateway.status().receipts[0].stage === 'replied');
  assert.equal(first.prompt, 'Prepare release notes'); assert.match(first.gatewayContext, /Mention design-kit/);
  assert.match(await send('/new fail submission'), /offline/);
  await gateway.configure({model:'', worktree:false});
  await send('still here');
  assert.deepEqual([turns.at(-1).model, turns.at(-1).cwd, turns.at(-1).worktree], ['allowed-model', undefined, undefined]); assert.equal(turns.at(-1).sessionId,first.sessionId);
  await send('/new run tests'); assert.equal(turns.at(-1).prompt,'run tests'); assert.notEqual(turns.at(-1).sessionId, first.sessionId);
  assert.match(await send('/sessions Prepare'), /1\. Prepare release notes/);
  const count=turns.length; assert.match(await send('/use 1'), /已切换/); assert.equal(turns.length,count);
  await send('follow up', {quote:{msgtype:'voice',voice:{content:'Ship Friday'}}});
  assert.equal(turns.at(-1).sessionId,first.sessionId); assert.match(turns.at(-1).gatewayContext,/Ship Friday/);
  assert.match(await send('/new'), /下一条/);
  gateway.stop(); gateway.reload(); gateway.start();
  assert.match(await send('/use 1'), /先发/); assert.match(await send('/sessions Prepare'), /Prepare release/);

  await gateway.configure({ownerSessionCatalog:true});
  const group={chattype:'group',chatid:'design'}, other={from:{userid:'colleague'}};
  assert.match(await send('/sessions', group), /没有会话/);
  assert.match(await send('/sessions', other), /没有会话/);
  assert.deepEqual(catalogQueries, []);
  assert.match(await send('/sessions design-kit'), /Review design-kit/);
  assert.match(await send('/use 1', other), /先发/);
  assert.match(await send('/use 1', group), /先发/);
  permitResume=false; assert.match(await send('/use 1'), /暂时无法接续/);
  permitResume=true; assert.match(await send('/use 1'), /已切换/);
  assert.match(await send('/status'), /Linux 服务器[\s\S]*正在执行/);
  await send('Continue the review'); assert.equal(turns.at(-1).sessionId, terminal.id);
  await gateway.configure({ownerSessionCatalog:false});
  const beforeRevoke=turns.length;
  assert.match(await send('after revoke'), /访问已关闭/);
  assert.equal(turns.length,beforeRevoke);
  assert.match(await send('/sessions design-kit'), /没有匹配/);
  assert.match(await send('/status'), /没有可用会话/);
  await send('/new use local history'); assert.notEqual(turns.at(-1).sessionId,terminal.id);
});
