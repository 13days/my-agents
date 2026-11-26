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
  let ws, subscriptions = 0, rejectAuth = false, isLeader = true;
  peer.on('connection', connection => {
    ws = connection;
    connection.on('message', raw => {
      const frame = JSON.parse(raw);
      if (frame.cmd === 'aibot_subscribe') {
        subscriptions++;
        assert.deepEqual(frame.body, { bot_id:'bot-1', secret:'fixture-secret' });
      } else if (frame.cmd === 'aibot_respond_msg') replies.push(frame);
      connection.send(JSON.stringify({ headers:frame.headers, errcode:rejectAuth ? 40013 : 0 }));
    });
  });
  const gateway = createWecom({
    dir, canStart: () => isLeader, connect: opts => connectWecom({ ...opts, url }),
    panel: {
      async submit(input) {
        const sessionId = input.sessionId || 'session-' + (sessions.size + 1);
        if (!sessions.has(sessionId)) sessions.set(sessionId, createChatJob({sessionId}));
        turns.push({ ...input, sessionId });
        return { sessionId };
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
  assert.throws(() => gateway.configure({allowedUsers:[' * ']}));
  gateway.configure({enabled:true, botId:'bot-1', secret:'fixture-secret', engine:'claude', allowedUsers:['owner','teammate'], workspaceId:'design'});
  await until(() => gateway.status().phase === 'connected');
  assert.equal(gateway.status().config.hasSecret, true);
  assert.ok(!JSON.stringify(gateway.status()).includes('fixture-secret'));
  assert.equal(fs.statSync(path.join(dir,'panel-wecom.json')).mode & 0o777, 0o600);
  send('invalid', 'wrong-bot', {aibotid:'another'});
  send('group-stranger','unauthorized',{chattype:'group',chatid:'group1',from:{userid:'stranger'}});
  send('private-stranger','identity',{from:{userid:'stranger'}});
  assert.match((await final('private-stranger')).body.stream.content, /UserID 是 stranger/);
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
  assert.equal((await final('b')).body.stream.content,'second result');
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
  gateway.configure({allowedUsers:['owner']}); finish(other,'private answer');
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
  const before = subscriptions; ws.terminate();
  await until(()=>subscriptions>before && gateway.status().phase==='connected');
  ws.send(JSON.stringify({cmd:'aibot_event_callback',headers:{req_id:'kick'},body:{event:{eventtype:'disconnected_event'}}}));
  await until(()=>gateway.status().phase==='error');
  rejectAuth=true; gateway.configure({enabled:true});
  await until(()=>gateway.status().phase==='error' && gateway.status().lastError.includes('40013'));
  gateway.configure({enabled:false}); assert.equal(gateway.status().phase,'disabled');
});
