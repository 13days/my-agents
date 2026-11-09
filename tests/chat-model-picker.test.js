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
    chatView: { engine: 'claude', attachments: [], run: { model: 'old-model', turns: new Map([['turn', { finished: !active }]]) } },
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
