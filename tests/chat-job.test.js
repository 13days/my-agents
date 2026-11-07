const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createChatJob } = require('../core/chat-job');

function subscriber() {
  const res = new EventEmitter(); res.frames = []; res.writeHead = () => {}; res.flushHeaders = () => {};
  res.write = frame => res.frames.push(frame); res.end = () => { res.writableEnded = true; res.emit('close'); };
  return res;
}

test('a task keeps progress after the browser disconnects and replays tool output and final text', () => {
  const job = createChatJob({ sessionId: 'test-session', cwd: '/tmp' });
  const first = subscriber(); job.subscribe(first);
  job.publish('input', { id: 'turn-1', prompt: 'List files' });
  job.publish('tool', { id: 'tool-1', messageId: 'turn-1', name: 'Bash' });
  first.end();
  job.publish('tool_result', { id: 'tool-1', messageId: 'turn-1', output: 'README.md' });
  job.publish('text', { messageId: 'turn-1', text: 'Files: ' });
  job.publish('text', { messageId: 'turn-1', text: 'README.md' });
  job.publish('done', { messageId: 'turn-1' });
  assert.equal(job.closed, false);
  const second = subscriber(); job.subscribe(second);
  assert.match(second.frames.join(''), /README.md/);
  assert.match(second.frames.join(''), /tool_result/);
  assert.equal(job.events.filter(event => event.event === 'text').length, 1);
  assert.equal(job.events.find(event => event.event === 'text').data.text, 'Files: README.md');
  job.close();
  const third = subscriber(); job.subscribe(third);
  assert.equal(third.writableEnded, true);
  assert.match(third.frames.join(''), /event: done/);
});
