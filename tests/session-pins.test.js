const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createSessionPins } = require('../core/session-pins');

test('pin preferences survive reload, apply to remote sessions and accept repeated updates', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-pins-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pins = createSessionPins(dir), id = 'remote-session';
  const first = pins.set({ id, pinned: true });
  assert.ok(first.pinnedAt > 0);
  assert.deepEqual(pins.set({ id, pinned: true }), first);
  assert.equal(createSessionPins(dir).read()[id], first.pinnedAt);
  assert.deepEqual(pins.set({ id, pinned: false }), { pinnedAt: 0 });
  assert.deepEqual(pins.set({ id, pinned: false }), { pinnedAt: 0 });
  assert.deepEqual(pins.read(), {});
  assert.throws(() => pins.set({ id, pinned: 'false' }));
  assert.throws(() => pins.set({ id: '../unsafe', pinned: true }));
  assert.ok(!fs.existsSync(path.join(dir, 'panel-sessions.json')));
});
