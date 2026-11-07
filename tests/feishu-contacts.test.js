const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createFeishuInbox } = require('../feishu-inbox');
const { createContactDirectory } = require('../feishu-contacts');
async function fixture(t, channel) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-contact-names-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const inbox = createFeishuInbox(dir); await inbox.record('app', { messageId: 'm1', senderId: 'ou_user', chatId: 'oc_group', chatType: 'group', content: 'Hello' }, 'allowed');
  let appId = 'app', activeChannel = channel, clock = 100;
  const names = createContactDirectory({ inbox, getChannel: () => activeChannel, getAppId: () => appId, now: () => clock });
  return { dir, inbox, names, app(value) { appId = value; }, channel(value) { activeChannel = value; }, advance(ms) { clock += ms; } };
}
test('official user and group names are fetched with open IDs and cached across restart', async t => {
  const requests = [];
  const channel = { getChatInfo: async id => ({ name: '研发讨论群' }), rawClient: { contact: { v3: { user: { get: async input => { requests.push(input); return { code: 0, data: { user: { name: '张三', email: 'not-persisted@example.com' } } }; } } } } } };
  const f = await fixture(t, channel);
  assert.deepEqual(await f.names.refresh(), { updated: 2, failed: 0 });
  assert.deepEqual(requests[0], { path: { user_id: 'ou_user' }, params: { user_id_type: 'open_id' } });
  assert.equal(f.inbox.contacts('app').users[0].displayName, '张三');
  const restored = createFeishuInbox(f.dir); await restored.ready;
  assert.equal(restored.contacts('app').groups[0].displayName, '研发讨论群');
  assert.equal((await restored.messages('app')).items[0].senderName, '张三');
  assert.equal(fs.readFileSync(path.join(f.dir, 'panel-feishu-contacts.json'), 'utf8').includes('not-persisted'), false);
});
test('missing permissions do not block records and failed lookups can be retried', async t => {
  let permitted = false, calls = 0;
  const channel = { rawClient: { contact: { v3: { user: { get: async () => { calls++; if (!permitted) throw Error('permission denied'); return { data: { user: { name: 'User' } } }; } } } } } };
  const f = await fixture(t, channel);
  assert.equal(await f.names.lookup('users', 'ou_user'), false);
  assert.equal(await f.names.lookup('users', 'ou_user'), false); assert.equal(calls, 1);
  permitted = true;
  assert.equal(await f.names.lookup('users', 'ou_user', true), true); assert.equal(calls, 2);
  assert.equal((await f.inbox.messages('app')).items[0].content, 'Hello');
});
test('concurrent lookups deduplicate and late results do not write names after app or channel changes', async t => {
  let resolve, calls = 0;
  const channel = { getChatInfo: () => { calls++; return new Promise(done => { resolve = done; }); } };
  const f = await fixture(t, channel);
  const first = f.names.lookup('groups', 'oc_group'), second = f.names.lookup('groups', 'oc_group');
  await Promise.resolve(); assert.equal(calls, 1);
  f.app('other-app'); resolve({ name: 'Wrong app' });
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(f.inbox.contacts('app').groups[0].name, '');
  f.app('app'); const stopped = f.names.lookup('groups', 'oc_group', true); await Promise.resolve(); f.channel(null); resolve({ name: 'Late result' });
  assert.equal(await stopped, false); assert.equal(f.inbox.contacts('app').groups[0].name, '');
});

test('group member names fill missing user names without collecting undiscovered members', async t => {
  let memberCalls = 0;
  const channel = { rawClient: { contact: { v3: { user: { get: async () => ({ code: 0, data: { user: {} } }) } } }, im: { v1: { chatMembers: { get: async input => { memberCalls++; assert.equal(input.params.member_id_type, 'open_id'); return { code: 0, data: { items: [{ member_id: 'ou_user', name: '群内姓名' }, { member_id: 'ou_unseen', name: 'Unseen member' }], has_more: false } }; } } } } } };
  const f = await fixture(t, channel);
  assert.equal(await f.names.lookup('users', 'ou_user'), true);
  assert.equal(f.inbox.contacts('app').users[0].displayName, '群内姓名');
  assert.equal(f.inbox.contacts('app').users.length, 1); assert.equal(memberCalls, 1);
  assert.equal(fs.readFileSync(path.join(f.dir, 'panel-feishu-contacts.json'), 'utf8').includes('Unseen member'), false);
});
