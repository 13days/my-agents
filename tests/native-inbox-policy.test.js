const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createNativeInboxPolicy } = require('../core/native-inbox-policy');
function fixture(t, value) {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-policy-')), home = path.join(dir, 'claude'), stateDir = path.join(dir, 'panel');
 fs.mkdirSync(home); fs.mkdirSync(stateDir); const file = path.join(home, 'settings.json');
 if (value) fs.writeFileSync(file, JSON.stringify(value));
 t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
 return { home, stateDir, file, policy: createNativeInboxPolicy({ home, stateDir }), read: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}
test('native receive opt-in preserves unrelated settings and restores only its owned key', t => {
 const f = fixture(t, { model: 'my-model', permissions: { defaultMode: 'default' }, crossSessionInbound: 'hold' });
 f.policy.set(true); f.policy.set(true);
 assert.equal(f.read().crossSessionInbound, 'accept');
 assert.deepEqual(f.read().permissions, { defaultMode: 'default' });
 assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
 f.policy.set(false);
 assert.equal(f.read().crossSessionInbound, 'hold'); assert.equal(f.read().model, 'my-model');
});
test('receive policy is durable across service restarts and rolls back a previously absent key', t => {
 const f = fixture(t, { model: 'my-model' }); f.policy.set(true);
 const restored = createNativeInboxPolicy(f); restored.set(true); restored.set(false);
 assert.deepEqual(f.read(), { model: 'my-model' });
});
test('manual overrides and already opted-in users are preserved', t => {
 const f = fixture(t, { crossSessionInbound: 'accept', model: 'm' }); f.policy.set(true); f.policy.set(false);
 assert.equal(f.read().crossSessionInbound, 'accept');
 fs.writeFileSync(f.file, JSON.stringify({ model: 'm' })); f.policy.set(true);
 fs.writeFileSync(f.file, JSON.stringify({ crossSessionInbound: 'refuse', model: 'm' }));
 assert.throws(() => f.policy.set(true), /手动修改/); f.policy.set(false);
 assert.equal(f.read().crossSessionInbound, 'refuse');
});
test('malformed and symlinked settings are never overwritten', t => {
 const f = fixture(t); fs.writeFileSync(f.file, '{broken'); assert.throws(() => f.policy.set(true));
 assert.equal(fs.readFileSync(f.file, 'utf8'), '{broken'); fs.unlinkSync(f.file);
 const target = path.join(f.home, 'target.json'); fs.writeFileSync(target, '{}'); fs.symlinkSync(target, f.file);
 assert.throws(() => f.policy.set(true), /普通文件/); assert.equal(fs.readFileSync(target, 'utf8'), '{}');
});
