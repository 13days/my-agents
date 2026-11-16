const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = html.slice(html.indexOf('let stopChatHistoryFollow ='), html.indexOf('async function loadOlderChat('));
const user = text => ({ role: 'user', text }), answer = text => ({ role: 'assistant', text });
function setup(messages = [user('first'), answer('first reply')]) {
  const timers = [], calls = [], box = { scrollHeight: 300, scrollTop: 12, clientHeight: 30, paints: 0, replaceChildren() { this.paints++; } };
  const view = { sessionId: 'original-thread', messages };
  let incoming = { messages: [...messages, user('CLI second'), answer('CLI reply')], messageCount: 4, revision: 'next' };
  const context = vm.createContext({ chatView: view, state: { type: 'sessions' }, expandedWindow: null,
    getSelection: () => null, $: () => box, document: { hidden: false, createElement: () => ({ childNodes: [], append() {} }) },
    api: async (...args) => { calls.push(args); return typeof incoming === 'function' ? incoming() : incoming; },
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {},
    rt: text => text, appendChatMessage: () => ({}), paintChatImages() {}, paintChatReasoning() {}, paintChatTool() {}, loadOlderChat() {},
  });
  vm.runInContext(source, context); context.startChatHistoryFollow(view);
  return { view, box, calls, context, next: async () => { assert.ok(timers.length); await timers.shift()(); }, incoming: value => { incoming = value; } };
}
test('an open web page follows later CLI turns without replacing the composer or changing the session', async () => {
  const s = setup(); await s.next();
  assert.equal(s.view.messages.at(-1).text, 'CLI reply'); assert.equal(s.view.sessionId, 'original-thread');
  assert.equal(s.box.scrollTop, 12); assert.equal(s.box.paints, 1);
  assert.equal(s.calls[0][0], 'GET'); assert.match(s.calls[0][1], /source=transcript/);
  s.incoming({ unchanged: true, revision: 'next' }); await s.next(); assert.equal(s.box.paints, 1);
});
test('native follow never overwrites a pending web turn or a response arriving during a read', async () => {
  const s = setup(); s.view.run = { turns: new Map([['web', { finished: false }]]) };
  await s.next(); assert.equal(s.calls.length, 0);
  s.view.run.turns.clear(); let respond; s.incoming(() => new Promise(resolve => { respond = resolve; }));
  const reading = s.next(); await Promise.resolve(); s.view.run.turns.set('new', { finished: false });
  respond({ messages: [user('old')] }); await reading; assert.equal(s.box.paints, 0);
});
test('transcript flush lag cannot erase a web answer, and read errors never resubmit input', async () => {
  const s = setup([user('web question'), answer('web final')]);
  s.view.historyPendingTurn = { user: user('web question'), answer: answer('web final') };
  s.incoming({ messages: [user('web question')], revision: 'lag' }); await s.next(); assert.equal(s.box.paints, 0);
  s.incoming(() => { throw new Error('read disconnected'); }); await s.next(); assert.equal(s.box.paints, 0);
  s.incoming({ messages: [user('web question'), answer('web final'), user('CLI next'), answer('next reply')], messageCount: 4, revision: 'flushed' });
  await s.next(); assert.equal(s.view.messages.at(-1).text, 'next reply'); assert.equal(s.view.historyPendingTurn, null);
  assert.ok(s.calls.every(call => call[0] === 'GET'));
});
test('follow preserves explicitly loaded older messages and retires on a view change', async () => {
  const s = setup([user('older'), answer('older reply'), user('first'), answer('first reply')]);
  s.incoming({ messages: [user('first'), answer('first reply'), user('CLI next')], messageCount: 5, revision: 'next' });
  await s.next(); assert.equal(s.view.messages[0].text, 'older'); assert.equal(s.view.messages.length, 5);
  s.context.chatView = {}; await s.next(); assert.equal(s.calls.length, 1);
});
test('a later native turn resumes following after a web request failed before delivery', async () => {
  const s = setup([user('not delivered'), answer('delivery failed')]);
  s.view.historyPendingTurn = { finished: true, user: { ...user('not delivered'), timestamp: '2026-11-16T00:00:00Z' }, answer: answer('delivery failed'), transcriptText: '' };
  s.incoming({ messages: [{ ...user('back in CLI'), timestamp: '2026-11-16T00:01:00Z' }, answer('CLI continues')], messageCount: 2 });
  await s.next(); assert.equal(s.view.messages.at(-1).text, 'CLI continues'); assert.equal(s.view.historyPendingTurn, null);
});
