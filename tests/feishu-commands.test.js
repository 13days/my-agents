const test = require('node:test');
const assert = require('node:assert/strict');
const { commandText } = require('../feishu-commands');
const bot = { openId: 'ou_bot', name: 'Timi' };
test('bot mentions before commands normalize names, placeholders, raw mentions, rich tags and invisible spaces', () => {
  for (const content of ['@Timi /new codex', '@Timi\u00a0/new codex', '\u200b@Timi\u200b/new codex', '@Timi @Timi /new codex', '@_user_1 /new codex', '<at user_id="ou_bot">Timi</at> /new codex']) {
    assert.equal(commandText({ content, mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'Timi', isBot: true }] }, bot), '/new codex');
  }
  assert.equal(commandText({ content: '@群内昵称 /engine claude', raw: { event: { message: { mentions: [{ key: '@_user_3', id: { open_id: 'ou_bot' }, name: '群内昵称' }] } } } }, bot), '/engine claude');
});
test('normalization leaves other mentions, prose, quotes and explicit /ask content intact', () => {
  for (const content of ['@Alice /new codex', '@TimiOther /new codex', '请执行 /new codex', '> @Timi /new codex', '@Timi 帮我写代码', '<at user_id="ou_other">Alice</at> /new codex']) assert.equal(commandText({ content }, bot), content);
  assert.equal(commandText({ content: '@Timi /ask /new codex' }, bot), '/ask /new codex');
  assert.equal(commandText({ content: '/new codex' }, {}), '/new codex');
});
