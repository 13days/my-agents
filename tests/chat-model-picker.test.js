const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '..', 'index.html'), 'utf8');
const sendSource = html.slice(html.indexOf('async function sendChat('), html.indexOf('async function streamChat('));

function fixture(active) {
  const prompt = { value: 'Keep my message' }, model = { value: 'new-model' };
  const calls = [];
  const ctx = vm.createContext({
    chatModel: '', LEGACY_ENGINE: 'claude', localStorage: { setItem() {} },
    document: { querySelectorAll: () => [] },
    $: selector => selector === '#chat-prompt' ? prompt : model,
    rt: text => text, toast: message => calls.push(['toast', message]),
    registerChatInSidebar() {}, createChatTurn: () => ({ id: 'message-id' }), paintChatAttachments() {},
    streamChat: () => calls.push(['start']),
    chatView: { sessionId: 'existing-session', engine: 'claude', attachments: [], run: { model: 'old-model', turns: new Map([['turn', { finished: !active }]]) } },
  });
  ctx.chatView.run.finished = Promise.resolve();
  ctx.chatView.run.abort = { abort: () => { calls.push(['detach']); ctx.chatView.run = null; } };
  vm.runInContext(sendSource, ctx);
  return { ctx, prompt, calls };
}

test('a changed model resumes the conversation through a new engine run after the old turn is idle', async () => {
  const { ctx, calls } = fixture(false);
  await vm.runInContext('sendChat()', ctx);
  assert.deepEqual(calls, [['detach'], ['start']]);
});

test('changing the selected model does not interrupt an active answer or discard the draft', async () => {
  const { ctx, calls, prompt } = fixture(true);
  await vm.runInContext('sendChat()', ctx);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'toast');
  assert.equal(prompt.value, 'Keep my message');
  assert.ok(ctx.chatView.run);
});

test('sending the first prompt enters its conversation once and clears the cached draft', async () => {
  const { ctx, calls } = fixture(false);
  ctx.chatView.sessionId = ''; ctx.chatView.run = null;
  ctx.chatPageCache = new Map([['__draft__', {}]]);
  ctx.registerChatInSidebar = v => { v.sessionId = 'new-session'; };
  ctx.renderChat = () => calls.push(['render', ctx.chatView.sessionId]);
  await vm.runInContext('sendChat()', ctx);
  assert.deepEqual(calls, [['render', 'new-session'], ['start']]);
  assert.equal(ctx.chatPageCache.has('__draft__'), false);
});

test('Enter queues the second message and only the interrupt button steers the active turn', async () => {
  const { ctx, prompt } = fixture(true);
  const modes = [], controls = { '#chat-prompt': prompt, '#chat-form': {}, '#chat-steer': {} };
  const run = ctx.chatView.run;
  run.inputChain = Promise.resolve(); run.model = 'new-model';
  ctx.$ = selector => controls[selector] || { value: 'new-model' };
  ctx.createChatTurn = () => ({ id: prompt.value, label: {} });
  ctx.updateChatSendState = () => {};
  ctx.api = async (method, url, input) => modes.push([input.prompt, input.mode]);
  controls['#chat-form'].requestSubmit = () => controls['#chat-form'].onsubmit({ preventDefault() {} });
  const handlers = html.slice(html.indexOf("  $('#chat-prompt').onkeydown"), html.indexOf("  v.attachments ||= [];"));
  vm.runInContext(handlers, ctx);
  assert.ok(html.includes('type="button" id="chat-steer"'));
  prompt.onkeydown({ key: 'Enter', preventDefault() {} });
  await run.inputChain;
  prompt.value = 'change direction';
  await controls['#chat-steer'].onclick(); await run.inputChain;
  assert.deepEqual(modes, [['Keep my message', 'queue'], ['change direction', 'steer']]);
});
