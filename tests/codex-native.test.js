const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { WebSocketServer } = require('ws');
const http = require('node:http');
const { createCodexNativeSessions } = require('../engines/codex/native');
const { createCodexEngine } = require('../engines/codex');

const waitFor = async predicate => {
  const until = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > until) throw new Error('condition timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
};
async function daemon(t, { lostAck = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-cn-'));
  const dir = path.join(home, 'app-server-control'); fs.mkdirSync(dir, { mode: 0o700 });
  const socketPath = path.join(dir, 'app-server-control.sock');
  const server = http.createServer(), ws = new WebSocketServer({ server });
  const calls = [], turns = [], queued = [], observer = [];
  let failReads = false;
  ws.on('connection', socket => socket.on('message', raw => {
    const row = JSON.parse(raw); calls.push(row);
    if (!row.id) return;
    const respond = result => socket.send(JSON.stringify({ id: row.id, result }));
    const error = message => socket.send(JSON.stringify({ id: row.id, error: { code: -32600, message } }));
    if (row.method === 'initialize') respond({});
    else if (row.method === 'thread/read') respond({ thread: { id: 'original-thread', status: { type: 'idle' } } });
    else if (row.method === 'thread/turns/list') {
      if (failReads) return socket.terminate();
      const offset = Number(row.params.cursor || 0), limit = row.params.limit;
      respond({ data: turns.slice().reverse().slice(offset, offset + limit), nextCursor: turns.length > offset + limit ? String(offset + limit) : null });
    } else if (row.method === 'thread/queue/add') {
      queued.push(row.params); observer.push(row.params); // Same thread seen by the original terminal.
      if (lostAck) return socket.terminate();
      respond({ queuedSubmission: { id: 'queue-' + queued.length, ...row.params } });
    } else error('unexpected method: ' + row.method);
  }));
  await new Promise(resolve => server.listen(socketPath, resolve)); fs.chmodSync(socketPath, 0o600);
  t.after(async () => {
    for (const client of ws.clients) client.terminate();
    await new Promise(resolve => ws.close(resolve)); await new Promise(resolve => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  });
  const events = [];
  const native = createCodexNativeSessions({ home, pollMs: 15 });
  let closed = 0;
  const open = () => {
    const session = native.open({ sessionId: 'original-thread', emit: (event, data) => events.push({ event, ...data }), onIdle() {}, onClosed() { closed++; } });
    t.after(() => session.close()); return session;
  };
  const turn = (clientId, status = 'inProgress', text = '阶段回复') => ({ id: 'turn-' + clientId, status, items: [{ id: 'user-' + clientId, type: 'userMessage', clientId, content: [] }, { id: 'answer-' + clientId, type: 'agentMessage', text }] });
  return { home, native, open, events, calls, queued, turns, observer, turn, failReads: value => { failReads = value; }, get closed() { return closed; } };
}

test('native Codex queues into the original loaded thread and waits for its authoritative completion', async t => {
  const d = await daemon(t), session = d.open();
  assert.equal((await d.native.find('original-thread')).id, 'original-thread');
  assert.equal(await session.ready, 'original-thread');
  session.submit('message-1', { prompt: 'continue' });
  await waitFor(() => d.queued.length === 1);
  assert.deepEqual(d.queued[0], { threadId: 'original-thread', clientUserMessageId: 'message-1', input: [{ type: 'text', text: 'continue' }] });
  assert.deepEqual(d.observer, d.queued);
  d.turns.push(d.turn('unrelated', 'completed', 'not our reply'), d.turn('message-1'));
  await waitFor(() => d.events.some(e => e.event === 'text'));
  assert.equal(d.events.some(e => e.event === 'done'), false);
  d.turns.at(-1).items[1].text += '，最终答复';
  d.turns.at(-1).status = 'completed';
  await waitFor(() => d.events.some(e => e.event === 'done'));
  assert.equal(d.events.filter(e => e.event === 'text').map(e => e.text).join(''), '阶段回复，最终答复');
  assert.equal(session.busy, false);
  session.submit('message-1', { prompt: 'duplicate delivery' });
  assert.equal(d.queued.length, 1);
  assert.equal(d.calls.some(c => /resume|fork|start|interrupt|settings/.test(c.method)), false);
});

test('lost queue ACK and disconnected reads recover without replaying input or declaring completion', async t => {
  const d = await daemon(t, { lostAck: true }), session = d.open();
  session.submit('message-2', { prompt: 'once' });
  await waitFor(() => d.queued.length === 1);
  d.failReads(true);
  await waitFor(() => d.events.some(e => e.kind === 'node_reconnecting'));
  assert.equal(d.events.some(e => e.event === 'done'), false);
  d.turns.push(d.turn('message-2', 'completed', 'recovered')); d.failReads(false);
  await waitFor(() => d.events.some(e => e.event === 'done'));
  assert.equal(d.queued.length, 1);
  assert.equal(d.events.filter(e => e.event === 'text').map(e => e.text).join(''), 'recovered');
});

test('detach never interrupts the terminal or removes already queued messages', async t => {
  const d = await daemon(t), session = d.open();
  session.submit('message-3', { prompt: 'continue original' });
  await waitFor(() => d.queued.length === 1);
  session.stop();
  d.turns.push(d.turn('message-3', 'completed'));
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(d.closed, 1);
  assert.equal(d.events.some(e => e.event === 'done'), false);
  assert.equal(d.calls.some(c => /interrupt|delete|archive/.test(c.method)), false);
});

test('native adapter bypasses CLI spawning and preserves original model, provider and permissions', async t => {
  const d = await daemon(t);
  const adapter = createCodexEngine({ sessions: { pathFor: () => '/thread' }, nativeSessions: d.native, capture: () => { throw new Error('must not reroute native thread'); } });
  const session = await adapter.open({ sessionId: 'original-thread', model: 'different-model', host: { spawn() { throw new Error('must not spawn'); } }, emit() {}, onIdle() {}, onClosed() {} });
  t.after(() => session.close());
  assert.equal(session.nativeAttached, true);
  assert.equal(await session.ready, 'original-thread');
  assert.equal(d.calls.some(c => c.params?.model || c.params?.config || c.params?.approvalPolicy), false);
});

test('a queued turn pushed past the first history page is still correlated by client message ID', async t => {
  const d = await daemon(t), session = d.open();
  d.turns.push(d.turn('before', 'completed'));
  session.submit('message-4', { prompt: 'queued' });
  await waitFor(() => d.queued.length === 1);
  d.turns.push(d.turn('message-4', 'completed', 'own reply'));
  for (let i = 0; i < 12; i++) d.turns.push(d.turn('external-' + i, 'completed', 'external'));
  await waitFor(() => d.events.some(e => e.event === 'done'));
  assert.equal(d.events.filter(e => e.event === 'text').map(e => e.text).join(''), 'own reply');
});

test('official private socket symlinks are allowed, shared control directories are refused', async t => {
  const d = await daemon(t);
  const source = path.join(d.home, 'app-server-control/app-server-control.sock'), targetDir = path.join(d.home, 'short');
  fs.mkdirSync(targetDir, { mode: 0o700 });
  const target = path.join(targetDir, 'daemon.sock'); fs.renameSync(source, target); fs.symlinkSync(target, source);
  assert.equal((await d.native.find('original-thread')).id, 'original-thread');
  fs.chmodSync(path.dirname(source), 0o755);
  await assert.rejects(d.native.find('original-thread'), /权限不安全/);
});
