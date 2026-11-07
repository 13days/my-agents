const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createFeishuInbox } = require('../feishu-inbox');

test('all delivered content is preserved, duplicate deliveries are ignored, and records survive restart', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-inbox-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const inbox = createFeishuInbox(dir), content = '中文消息'.repeat(10000);
  const msg = { messageId: 'msg-1', senderId: 'ou_one', senderName: '用户一', chatId: 'oc_group', chatType: 'group', mentionedBot: true, content, resources: [{ type: 'image', fileKey: 'image-key' }] };
  assert.equal(await inbox.record('app-one', msg, 'blocked_group'), true);
  assert.equal(await inbox.record('app-one', msg, 'allowed'), false);
  inbox.setName('app-one', 'oc_group', '项目讨论群');
  await inbox.record('app-two', { ...msg, content: 'another app' }, 'allowed');
  const restored = createFeishuInbox(dir); await restored.ready;
  assert.equal(restored.contacts('app-one').groups[0].name, '项目讨论群');
  assert.equal(restored.contacts('app-one').users[0].count, 1); assert.equal(restored.contacts('app-one').users[0].mentionCount, 1);
  const result = await restored.messages('app-one');
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].content, content);
  assert.equal(result.items[0].access, 'blocked_group');
  assert.equal(result.items[0].resources[0].fileKey, 'image-key');
  assert.equal(fs.statSync(path.join(dir, 'panel-feishu-inbox.jsonl')).mode & 0o777, 0o600);
});

test('message pagination and user/group filters return complete records in stable order', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-inbox-pages-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const inbox = createFeishuInbox(dir);
  for (let i = 0; i < 65; i++) await inbox.record('app', { messageId: 'm' + i, senderId: i % 2 ? 'ou_odd' : 'ou_even', chatId: i % 2 ? 'oc_odd' : 'oc_even', chatType: 'group', content: String(i) }, 'allowed');
  const first = await inbox.messages('app'), second = await inbox.messages('app', { before: first.before }), third = await inbox.messages('app', { before: second.before });
  assert.equal([...first.items, ...second.items, ...third.items].length, 65);
  assert.equal(first.items[0].content, '64');
  assert.equal(third.items.at(-1).content, '0');
  assert.equal(third.hasMore, false);
  assert.ok((await inbox.messages('app', { userId: 'ou_odd', chatId: 'oc_odd' })).items.every(item => Number(item.content) % 2));
});

test('contact labels survive restart, remain app scoped and do not get replaced by official name refreshes', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-contact-labels-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const inbox = createFeishuInbox(dir), msg = { messageId: 'm1', senderId: 'ou_user', senderName: 'Official user', chatId: 'oc_group', chatName: 'Official group', chatType: 'group', content: 'Hi' };
  await inbox.record('app-one', msg, 'allowed'); await inbox.record('app-two', msg, 'allowed');
  inbox.setAlias('app-one', 'ou_user', ' 工作账号 '); inbox.setAlias('app-one', 'oc_group', '项目群');
  inbox.setName('app-one', 'ou_user', 'Updated official user');
  const restored = createFeishuInbox(dir); await restored.ready;
  const contact = restored.contacts('app-one').users[0]; assert.equal(contact.name, 'Updated official user'); assert.equal(contact.displayName, '工作账号'); assert.equal(contact.alias, '工作账号');
  assert.equal(restored.contacts('app-two').users[0].displayName, 'Official user');
  const history = (await restored.messages('app-one')).items[0]; assert.equal(history.senderName, '工作账号'); assert.equal(history.chatName, '项目群');
  restored.setAlias('app-one', 'ou_user', ''); assert.equal(restored.contacts('app-one').users[0].displayName, 'Updated official user');
  assert.throws(() => restored.setAlias('app-one', 'ou_user', 'x'.repeat(81)), /80/);
  assert.equal(fs.statSync(path.join(dir, 'panel-feishu-contact-labels.json')).mode & 0o777, 0o600);
});
