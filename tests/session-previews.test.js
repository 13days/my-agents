const test = require('node:test'), assert = require('node:assert/strict');
const { sessionPreview, userMessagePage, previewText } = require('../core/session-previews');

test('turn counts include actual text/image sends, excluding assistant tools and empty records', () => {
  const history = { messages: [{ role: 'user', text: 'first', timestamp: '2026-11-01T01:00:00Z' }, { role: 'assistant', text: '', tools: [{ name: 'Read' }] }, { role: 'user', text: '' }, { role: 'user', images: [{}], timestamp: '2026-11-01T01:01:00Z' }, { role: 'assistant', text: 'answer', timestamp: '2026-11-01T01:01:30Z' }] };
  const before = JSON.stringify(history);
  const preview = sessionPreview(history, { id: 's', first: Date.parse('2026-11-02'), last: Date.parse('2026-11-01T01:02:00Z') });
  assert.equal(preview.turns, 2); assert.equal(preview.createdAt, Date.parse('2026-11-01T01:00:00Z'));
  assert.equal(preview.lastAt, Date.parse('2026-11-01T01:02:00Z'));
  assert.deepEqual(preview.userMessages.map(m => m.round), [1, 2]); assert.match(preview.userMessages[1].text, /图片 1 张/);
  assert.equal(JSON.stringify(history), before);
});
test('user-message pages start with the latest sends and retain actual round numbers', () => {
  const history = { messages: Array.from({ length: 12 }, (_, i) => [{ role: 'user', text: `question ${i + 1}` }, { role: 'assistant', text: 'response' }]).flat() };
  const latest = userMessagePage(history, 0); assert.equal(latest.turns, 12); assert.equal(latest.pages, 3);
  assert.deepEqual(latest.messages.map(m => m.round), [8, 9, 10, 11, 12]);
  assert.deepEqual(userMessagePage(history, 1).messages.map(m => m.round), [3, 4, 5, 6, 7]);
  assert.deepEqual(userMessagePage(history, 100).messages.map(m => m.round), [1, 2]);
});
test('missing remote history stays unknown, and display cleanup does not expose attachment paths or email', () => {
  assert.equal(sessionPreview(null).turns, null);
  assert.equal(sessionPreview({ messages: [{ role: 'user', text: 'initial only' }] }, { historyAvailable: false }).turns, null);
  assert.equal(sessionPreview({ messages: [] }).turns, 0);
  assert.equal(previewText('<image name=[Image #1] path="/tmp/clipboard.png"></image>[Image #1] 帮我分析 person@example.invalid'), '帮我分析 [邮箱已隐藏]');
});
