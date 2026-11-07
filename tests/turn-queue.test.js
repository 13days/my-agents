const test = require('node:test');
const assert = require('node:assert/strict');
const { createTurnQueue } = require('../core/turn-queue');

function harness() {
  const started = [], interrupts = [];
  let idle = 0;
  const queue = createTurnQueue({ start: entry => started.push(entry.id), interrupt: entry => interrupts.push(entry.id), onIdle: () => idle++ });
  return { queue, started, interrupts, get idle() { return idle; } };
}
const tick = () => new Promise(resolve => queueMicrotask(resolve));

test('continuous inputs queue without starting overlapping turns', async () => {
  const h = harness();
  h.queue.submit('first', {});
  h.queue.submit('second', {});
  h.queue.submit('third', {});
  assert.deepEqual(h.started, ['first']);
  assert.equal(h.queue.finish().id, 'first'); await tick();
  assert.deepEqual(h.started, ['first', 'second']);
  h.queue.finish(); await tick();
  h.queue.finish(); await tick();
  assert.equal(h.idle, 1);
  h.queue.submit('fourth', {});
  assert.equal(h.queue.currentId, 'fourth');
});

test('steering interrupts once and runs before queued input', async () => {
  const h = harness();
  h.queue.submit('active', {});
  h.queue.submit('queued', {});
  h.queue.submit('steer-one', {}, true);
  h.queue.submit('steer-two', {}, true);
  assert.deepEqual(h.interrupts, ['active']);
  assert.equal(h.queue.interrupted, true);
  h.queue.finish(); await tick();
  assert.equal(h.queue.currentId, 'steer-one');
  h.queue.finish(); await tick();
  assert.equal(h.queue.currentId, 'steer-two');
  h.queue.finish(); await tick();
  assert.equal(h.queue.currentId, 'queued');
});

test('duplicates are idempotent, refused interrupts keep the turn, stop discards pending work', async () => {
  const h = harness();
  h.queue.submit('first', {});
  h.queue.submit('first', {});
  h.queue.submit('second', {}, true);
  h.queue.keep();
  assert.equal(h.queue.interrupted, false);
  h.queue.stop(); h.queue.finish(); await tick();
  assert.deepEqual(h.started, ['first']);
  assert.equal(h.idle, 0);
  assert.throws(() => h.queue.submit('new', {}));
});

test('engines that cannot interrupt keep the active turn running', () => {
  const interrupts = [];
  const queue = createTurnQueue({ start() {}, interrupt: entry => interrupts.push(entry.id), canInterrupt: () => false });
  queue.submit('a', {}); queue.submit('b', {}, true);
  assert.deepEqual(interrupts, []);
  assert.equal(queue.pendingCount, 1);
});
