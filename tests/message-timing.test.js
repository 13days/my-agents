const test = require('node:test');
const assert = require('node:assert/strict');
const { annotateMessageTimings, messageTimestamp } = require('../message-timing');
const { createChatJob } = require('../core/chat-job');
test('message timing uses recorded timestamps and respects precise engine durations', () => {
  const messages = [
    { role: 'user', timestamp: '2026-11-07T12:57:00Z' },
    { role: 'assistant', timestamp: '2026-11-07T12:59:21Z' },
    { role: 'user', timestamp: '2026-11-07T13:00:00Z' },
    { role: 'assistant', timestamp: '2026-11-07T13:00:10Z', durationMs: 9750 },
    { role: 'user' }, { role: 'assistant' },
  ];
  annotateMessageTimings(messages); assert.equal(messages[1].durationMs, 141000); assert.equal(messages[3].durationMs, 9750); assert.equal(messages[5].durationMs, undefined);
  assert.equal(messageTimestamp(undefined), undefined); assert.equal(messageTimestamp('invalid'), undefined);
  assert.equal(messageTimestamp(1794056220), '2026-11-07T12:57:00.000Z');
});
test('job replay preserves send times and duration across browser reconnects', () => {
  const job = createChatJob({ sessionId: 'test' });
  job.publish('input', { id: 'turn', timestamp: '2026-11-07T12:57:00Z' });
  job.publish('turn', { id: 'turn', messageId: 'turn', timestamp: '2026-11-07T12:57:02Z' });
  job.publish('done', { messageId: 'turn', timestamp: '2026-11-07T12:59:21Z' });
  assert.equal(job.events[0].data.timestamp, '2026-11-07T12:57:00Z'); assert.equal(job.events.at(-1).data.durationMs, 139000);
  assert.ok(job.events.every(item => item.data.timestamp)); job.close();
});
