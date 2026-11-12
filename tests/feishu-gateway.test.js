const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createFeishuGateway, contextKey, messageUUID } = require('../feishu-gateway');
const { createChatJob } = require('../core/chat-job');

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-feishu-test-'));
  const calls = [], sent = [], updated = [], jobs = new Map(), handlers = {}, policies = [], reactions = [];
  let clock = Date.now(), count = 0;
  const rows = [{ id: '11111111-1111-4111-8111-111111111111', title: 'First session', project: dir }, { id: '22222222-2222-4222-8222-222222222222', title: 'Second session', project: dir }];
  const channel = {
    botIdentity: { name: 'Test bot' }, on: (event, handler) => { handlers[event] = handler; }, connect: async () => {}, disconnect: async () => {},
    send: async (chatId, content, options) => { const messageId = 'out_' + ++count; sent.push({ messageId, chatId, content, options }); return { messageId }; },
    addReaction: async (messageId, emojiType) => { const id = 'reaction_' + messageId; reactions.push({ action: 'add', messageId, emojiType, id }); return id; },
    removeReaction: async (messageId, id) => { reactions.push({ action: 'remove', messageId, id }); },
    updateCard: async (id, card) => { updated.push({ id, card }); },
    downloadResource: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  };
  const panel = {
    sessions: () => rows, projects: () => [dir], running: id => jobs.has(id), history: () => [{ role: 'assistant', text: 'Saved reply' }],
    submit: async input => {
      calls.push(input); if (!rows.some(item => item.id === input.sessionId)) rows.unshift({ id: input.sessionId, project: input.cwd, title: input.prompt });
      let job = jobs.get(input.sessionId); if (!job) { job = createChatJob({ sessionId: input.sessionId }); jobs.set(input.sessionId, job); }
      const messageId = input.messageId;
      job.publish('turn', { id: messageId, messageId }); job.publish('tool', { id: 'tool_' + messageId, messageId, name: 'Read', input: { file_path: 'README.md' } });
      job.publish('tool_result', { id: 'tool_' + messageId, messageId, output: 'README contents' }); job.publish('text', { messageId, text: 'A complete response.' }); job.publish('done', { messageId });
    },
    watch: (id, listener) => jobs.get(id).listen(listener),
    rename: async (id, title) => { rows.find(item => item.id === id).title = title; }, stop: async id => { calls.push({ stop: id }); },
  };
  const runtime = { status: () => ({ supported: true, keepAwake: false, autoStart: false }), keepAwake() {} };
  const options = { dir, panel, runtime, replyURL: 'http://127.0.0.1:4321/api/feishu/reply', channelFactory: options => { policies.push(options.policy); return channel; }, now: () => clock };
  const gateway = createFeishuGateway(options);
  await gateway.configure({ enabled: true, appId: 'cli_test_app', appSecret: 'fake-test-secret', defaultProject: dir });
  const msg = (content, extra = {}) => ({ messageId: 'incoming_' + ++count, chatId: 'oc_private', senderId: 'ou_owner', chatType: 'p2p', content, ...extra });
  const pair = async (senderId = 'ou_owner') => { const code = gateway.newPairing().command; await gateway.receive(msg(code, { senderId })); };
  t.after(async () => { await gateway.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { gateway, panel, calls, sent, updated, rows, dir, msg, pair, options, channel, handlers, policies, reactions, advance: value => { clock += value; } };
}

test('a shared conversation keeps its execution machine when the IM leader changes', async t => {
  const f = await fixture(t); await f.pair();
  f.panel.machineId = () => 'mac';
  await f.gateway.receive(f.msg('/new'));
  f.panel.machineId = () => 'linux';
  f.panel.nodes = () => [{ id: 'mac', label: 'Mac', connected: true }];
  await f.gateway.receive(f.msg('Continue on the original machine'));
  assert.equal(f.calls.at(-1).machineId, 'mac');
  assert.equal(f.calls.at(-1).node, 'mac');
  assert.equal(f.calls.at(-1).cwd, fs.realpathSync(f.dir));
});

test('a late IM handshake cannot reconnect a gateway after its leadership lease is lost', async t => {
  const f = await fixture(t); await f.gateway.stop();
  let permitted = true, release, connected = false, disconnected = 0;
  const callbacks = {};
  const gateway = createFeishuGateway({ ...f.options, leadership: { canStart: () => permitted }, channelFactory: () => ({
    ...f.channel, on: (event, fn) => { callbacks[event] = fn; },
    connect: () => { connected = true; return new Promise(resolve => { release = resolve; }); },
    disconnect: async () => { disconnected++; },
  }) });
  t.after(() => gateway.stop());
  const starting = gateway.start();
  while (!connected) await new Promise(resolve => setTimeout(resolve, 5));
  permitted = false; await gateway.stop(); release(); await starting;
  callbacks.reconnected(); callbacks.message(f.msg('A stale channel must ignore this'));
  assert.equal(gateway.status().phase, 'disabled');
  assert.equal(f.calls.length, 0); assert.ok(disconnected >= 2);
});

test('Feishu model dropdown persists its option, submits that model and rejects stale session cards', async t => {
  const f = await fixture(t); await f.pair();
  f.panel.models = async () => ({ accountName: 'Proxy', models: [{ id: 'model-a', name: 'Model A' }, { id: 'model-b', name: 'Model B' }] });
  await f.gateway.receive(f.msg('/new'));
  await f.gateway.receive(f.msg('/model'));
  const picker = f.sent.at(-1), binding = JSON.parse(fs.readFileSync(path.join(f.dir, 'panel-feishu-state.json'))).bindings[contextKey(f.msg(''))];
  const select = picker.content.card.body.elements.find(item => item.tag === 'select_static');
  assert.ok(select.options.some(item => item.value === 'model-b'));
  const evt = { messageId: picker.messageId, chatId: 'oc_private', operator: { openId: 'ou_owner' }, action: { tag: 'select_static', value: select.behaviors[0].value, option: 'model-b' } };
  await f.gateway.action(evt);
  assert.match(JSON.stringify(f.sent.at(-1).content), /已选择模型：model-b/);
  await f.gateway.receive(f.msg('Use the selected model'));
  assert.equal(f.calls.at(-1).model, 'model-b');
  await f.gateway.stop(); const restored = createFeishuGateway(f.options); await restored.start();
  t.after(() => restored.stop());
  await restored.receive(f.msg('/model'));
  assert.match(JSON.stringify(f.sent.at(-1).content), /model-b/);
  await restored.receive(f.msg('/new'));
  await restored.action(evt);
  assert.match(JSON.stringify(f.sent.at(-1).content), /会话已切换/);
  const state = JSON.parse(fs.readFileSync(path.join(f.dir, 'panel-feishu-state.json')));
  assert.equal(state.sessionModels[binding.id], 'model-b');
  assert.equal(state.sessionModels[state.bindings[contextKey(f.msg(''))].id], undefined);
});

test('simple Feishu topics can view, select and reset models independently', async t => {
  const f = await fixture(t);
  await f.gateway.configure({ allowAllGroups: true });
  const inTopic = (text, threadId) => f.msg(text, { chatId: 'oc_group', chatType: 'group', threadId, mentionedBot: true });
  await f.gateway.receive(inTopic('/model model-a', 'topic-a'));
  await f.gateway.receive(inTopic('/model model-b', 'topic-b'));
  assert.equal(f.calls.length, 0);
  await f.gateway.receive(inTopic('/model', 'topic-a'));
  assert.match(JSON.stringify(f.sent.at(-1).content), /模型：model-a/);
  assert.doesNotMatch(JSON.stringify(f.sent.at(-1).content), /model-b/);
  await f.gateway.receive(inTopic('Run A', 'topic-a'));
  assert.equal(f.calls.at(-1).model, 'model-a');
  await f.gateway.receive(inTopic('Run B', 'topic-b'));
  assert.equal(f.calls.at(-1).model, 'model-b');
  await f.gateway.receive(inTopic('/model default', 'topic-a'));
  await f.gateway.receive(inTopic('Default model', 'topic-a'));
  assert.equal(f.calls.at(-1).model, '');
  await f.gateway.receive(inTopic('/model bad model', 'topic-b'));
  assert.match(JSON.stringify(f.sent.at(-1).content), /模型 ID 无效/);
});

test('only a paired owner can access sessions or invoke Claude; pairing is single use and secrets stay redacted', async t => {
  const f = await fixture(t);
  await f.gateway.receive(f.msg('/sessions')); assert.equal(f.calls.length, 0); assert.match(f.sent.at(-1).content.post.zh_cn.content[0][0].text, /尚未配对/);
  const command = f.gateway.newPairing().command;
  await f.gateway.receive(f.msg(command)); await f.gateway.receive(f.msg(command, { senderId: 'ou_stranger' }));
  assert.deepEqual(f.gateway.status().config.allowedUserIds, ['ou_owner']);
  await f.gateway.receive(f.msg('Read this project', { senderId: 'ou_stranger' })); assert.equal(f.calls.length, 0);
  assert.equal(JSON.stringify(f.gateway.status()).includes('fake-test-secret'), false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(f.dir, 'panel-feishu.json')).mode & 0o777, 0o600);
});

test('session list numbers remain stable after reordering; switching changes the binding and replies to older cards preserve it', async t => {
  const f = await fixture(t); await f.pair(); await f.gateway.receive(f.msg('/sessions'));
  f.rows.reverse(); await f.gateway.receive(f.msg('/switch 1'));
  const firstCard = f.sent.at(-1).messageId;
  await f.gateway.receive(f.msg('/sessions')); await f.gateway.receive(f.msg('/switch 1'));
  await f.gateway.receive(f.msg('Question for the first card', { replyToMessageId: firstCard }));
  assert.equal(f.calls.at(-1).sessionId, '22222222-2222-4222-8222-222222222222');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(JSON.stringify(f.updated.at(-1).card), /A complete response/); assert.match(JSON.stringify(f.updated.at(-1).card), /README contents/);
});

test('new project sessions, queue/steer modes and images reach the same Panel API without duplicate execution', async t => {
  const f = await fixture(t); await f.pair(); await f.gateway.receive(f.msg('/new 1'));
  const first = f.msg('First task'); await f.gateway.receive(first); await f.gateway.receive(first);
  assert.equal(f.calls.length, 1);
  const id = f.calls[0].sessionId;
  await f.gateway.receive(f.msg('/queue Next task')); await f.gateway.receive(f.msg('/steer Change direction'));
  assert.equal(f.calls[1].mode, 'queue'); assert.equal(f.calls[2].mode, 'steer'); assert.equal(f.calls[2].sessionId, id);
  await f.gateway.receive(f.msg('', { resources: [{ type: 'image', fileKey: 'img_test' }] }));
  assert.equal(f.calls.at(-1).images[0].mimeType, 'image/png');
  assert.equal(f.calls[0].messageId, messageUUID(first.messageId));
});

test('unlisted project paths survive restart before the first task and support engine switching', async t => {
  const f = await fixture(t); await f.pair();
  const cwd = path.join(f.dir, '新项目  with spaces'); fs.mkdirSync(cwd);
  await f.gateway.receive(f.msg('/new codex "' + cwd + '"'));
  assert.match(JSON.stringify(f.sent.at(-1).content), /新会话已就绪/);
  assert.equal(f.calls.length, 0);
  await f.gateway.stop();
  const restored = createFeishuGateway(f.options); await restored.start();
  try {
    await restored.receive(f.msg('/projects'));
    assert.ok(JSON.stringify(f.sent.at(-1).content).includes(cwd));
    await restored.receive(f.msg('/claude'));
    await restored.receive(f.msg('First task in the new directory'));
    assert.equal(f.calls.at(-1).cwd, cwd);
    await restored.receive(f.msg('/new codex ' + cwd));
    await restored.receive(f.msg('Codex task in the new directory'));
    assert.equal(f.calls.at(-1).cwd, cwd);
    assert.equal(f.calls.at(-1).engine, 'codex');
  } finally { await restored.stop(); }
});

test('new project paths must be existing directories and retain management authorization', async t => {
  const f = await fixture(t); await f.pair();
  const file = path.join(f.dir, 'ordinary-file'); fs.writeFileSync(file, 'text');
  for (const target of [file, path.join(f.dir, 'missing-directory')]) {
    await f.gateway.receive(f.msg('/new ' + target));
    assert.match(JSON.stringify(f.sent.at(-1).content), /项目目录不存在或不是文件夹/);
  }
  assert.equal(fs.existsSync(path.join(f.dir, 'missing-directory')), false);
  await f.gateway.receive(f.msg('/new ~/'));
  assert.match(JSON.stringify(f.sent.at(-1).content), /新会话已就绪/);
  await f.gateway.receive(f.msg('Use the home directory'));
  assert.equal(f.calls.at(-1).cwd, os.homedir());
  await f.gateway.configure({ allowAllGroups: true });
  await f.gateway.receive(f.msg('/new ' + f.dir, { chatId: 'oc_unlisted_group', chatType: 'group', mentionedBot: true }));
  assert.match(JSON.stringify(f.sent.at(-1).content), /逐项授权/);
  assert.equal(f.calls.length, 1);
});

test('card actions cannot be used by another owner and groups require an allowlist plus mention', async t => {
  const f = await fixture(t); await f.pair(); await f.pair('ou_second');
  const action = { action: { value: { owner: 'ou_owner', action: 'switch', id: f.rows[0].id, key: contextKey(f.msg('')) } }, operator: { openId: 'ou_second' }, chatId: 'oc_private', messageId: 'card_id' };
  const before = f.sent.length; await f.gateway.action(action); assert.equal(f.sent.length, before + 1); assert.match(JSON.stringify(f.sent.at(-1).content), /仅限发起人/);
  await f.gateway.receive(f.msg('Run', { chatType: 'group', chatId: 'oc_group', mentionedBot: true })); assert.equal(f.calls.length, 0);
  await f.gateway.configure({ allowedChatIds: ['oc_group'] });
  await f.gateway.receive(f.msg('Run', { chatType: 'group', chatId: 'oc_group', mentionedBot: false })); assert.equal(f.calls.length, 0);
  await f.gateway.receive(f.msg('Run', { chatType: 'group', chatId: 'oc_group', mentionedBot: true })); assert.equal(f.calls.length, 1);
});

test('paired users, selections and processed receipts survive a gateway restart', async t => {
  const f = await fixture(t); await f.pair(); await f.gateway.receive(f.msg('/sessions')); await f.gateway.receive(f.msg('/switch 2'));
  const task = f.msg('Persisted task'); await f.gateway.receive(task); const id = f.calls.at(-1).sessionId;
  await f.gateway.stop(); const restored = createFeishuGateway(f.options); await restored.start();
  try {
    await restored.receive(task); assert.equal(f.calls.length, 1);
    await restored.receive(f.msg('Continue after restart')); assert.equal(f.calls.at(-1).sessionId, id);
  } finally { await restored.stop(); }
});

test('expired pairing codes cannot authorize a new user', async t => {
  const f = await fixture(t), command = f.gateway.newPairing().command; f.advance(11 * 60 * 1000);
  await f.gateway.receive(f.msg(command)); assert.equal(f.gateway.status().config.allowedUserIds.length, 0);
});


test('explicit switches and new sessions override the session of a replied-to card', async t => {
  const f = await fixture(t); await f.pair(); await f.gateway.receive(f.msg('/sessions')); await f.gateway.receive(f.msg('/switch 1'));
  const oldCard = f.sent.at(-1).messageId, oldId = f.rows[0].id;
  await f.gateway.receive(f.msg('/switch 2', { replyToMessageId: oldCard }));
  await f.gateway.receive(f.msg('Continue the selected session'));
  assert.equal(f.calls.at(-1).sessionId, f.rows[1].id);
  await f.gateway.receive(f.msg('/new 1', { replyToMessageId: oldCard }));
  await f.gateway.receive(f.msg('Continue the new project'));
  assert.notEqual(f.calls.at(-1).sessionId, oldId);
});

test('a transient final card update failure is retried instead of losing the completed reply', async t => {
  const f = await fixture(t); await f.pair();
  const update = f.channel.updateCard; let attempts = 0;
  f.channel.updateCard = async (...args) => { if (++attempts === 1) throw new Error('temporary rate limit'); return update(...args); };
  await f.gateway.receive(f.msg('Retry card delivery'));
  await new Promise(resolve => setTimeout(resolve, 1150));
  assert.equal(attempts, 2); assert.match(JSON.stringify(f.updated.at(-1).card), /A complete response/);
});

test('unknown groups and senders are recorded before authorization and can then be selected explicitly', async t => {
  const f = await fixture(t);
  const group = { chatType: 'group', chatId: 'oc_discovered', senderId: 'ou_discovered', senderName: '发现的用户', mentionedBot: true };
  await f.gateway.receive(f.msg('还未放行的消息', group));
  assert.equal(f.calls.length, 0);
  assert.equal(f.gateway.status().inbox.groups[0].id, 'oc_discovered');
  assert.equal(f.gateway.status().inbox.users[0].name, '发现的用户');
  assert.equal((await f.gateway.messages()).items[0].content, '还未放行的消息');
  assert.equal(f.policies[0].groupAllowlist, undefined, 'SDK must not discard undiscovered groups before the gateway can record them');
  await f.gateway.configure({ allowedChatIds: ['oc_discovered'], allowedUserIds: ['ou_discovered'] });
  await f.gateway.receive(f.msg('现在可以执行', group));
  assert.equal(f.calls.length, 1);
  assert.equal((await f.gateway.messages()).items[0].access, 'allowed');
});

test('open group and user modes are independent, retain mention requirements, and can be revoked', async t => {
  const f = await fixture(t); await f.pair();
  const group = { chatType: 'group', chatId: 'oc_any_group', senderId: 'ou_any_user', mentionedBot: true };
  await f.gateway.configure({ allowAllGroups: true });
  await f.gateway.receive(f.msg('放行群内无需单独授权', group)); assert.equal(f.calls.length, 1);
  await f.gateway.configure({ allowAllUsers: true });
  await f.gateway.receive(f.msg('仍需要提及', { ...group, mentionedBot: false })); assert.equal(f.calls.length, 1);
  assert.equal((await f.gateway.messages()).items[0].access, 'needs_mention');
  await f.gateway.receive(f.msg('公开模式允许执行', group)); assert.equal(f.calls.length, 2);
  await f.gateway.configure({ allowAllGroups: false, allowAllUsers: false });
  await f.gateway.receive(f.msg('权限已撤回', group)); assert.equal(f.calls.length, 2);
});

test('group card clicks cannot bypass a revoked group permission by masquerading as a private chat', async t => {
  const f = await fixture(t); await f.pair(); await f.gateway.configure({ allowedChatIds: ['oc_group'] });
  await f.gateway.receive(f.msg('/sessions', { chatType: 'group', chatId: 'oc_group', mentionedBot: true }));
  await f.gateway.configure({ allowedChatIds: [] });
  const before = f.sent.length;
  await f.gateway.action({ action: { value: { action: 'switch', id: f.rows[0].id, owner: 'ou_owner', key: JSON.stringify(['ou_owner', 'oc_group', 'main']) } }, operator: { openId: 'ou_owner' }, chatId: 'oc_group', messageId: 'old-card' });
  assert.equal(f.sent.length, before);
});

test('session pagination callbacks keep visible global numbers consistent with /switch', async t => {
  const f = await fixture(t); await f.pair();
  for (let i = 2; i < 33; i++) f.rows.push({ id: `session-${i}`, title: `会话 ${i}`, project: f.dir });
  await f.gateway.receive(f.msg('/sessions'));
  await f.gateway.action({ action: { value: { action: 'sessions', page: 1, owner: 'ou_owner', key: contextKey(f.msg('')) } }, operator: { openId: 'ou_owner' }, chatId: 'oc_private', messageId: 'list-card' });
  assert.match(JSON.stringify(f.sent.at(-1)), /6\. /);
  await f.gateway.receive(f.msg('/switch 6'));
  await f.gateway.receive(f.msg('继续分页选择的会话'));
  assert.equal(f.calls.at(-1).sessionId, f.rows[5].id);
});

test('changing access permissions preserves the live connection and task card updates', async t => {
  const f = await fixture(t); await f.pair();
  let disconnects = 0;
  f.channel.disconnect = async () => { disconnects++; };
  await f.gateway.receive(f.msg('保持任务卡片更新'));
  await f.gateway.configure({ allowAllUsers: true, allowAllGroups: true });
  assert.equal(disconnects, 0);
  assert.equal(f.policies.length, 1);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.match(JSON.stringify(f.updated.at(-1).card), /A complete response/);
});

test('private chats, groups and topics create separate default-project sessions and share bindings within a group', async t => {
  const f = await fixture(t); await f.pair(); await f.pair('ou_second');
  await f.gateway.configure({ allowAllGroups: true });
  const group = { chatType: 'group', chatId: 'oc_group', mentionedBot: true };
  await f.gateway.receive(f.msg('私聊'));
  const privateId = f.calls.at(-1).sessionId;
  await f.gateway.receive(f.msg('普通群', group));
  const groupId = f.calls.at(-1).sessionId;
  await f.gateway.receive(f.msg('普通回复', { ...group, rootId: 'om_ordinary', replyToMessageId: 'om_ordinary', senderId: 'ou_second' }));
  assert.equal(f.calls.at(-1).sessionId, groupId);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.sent.at(-1).options.replyInThread, false);
  await f.gateway.receive(f.msg('话题一首条', { ...group, threadId: 'omt_one' }));
  const oneId = f.calls.at(-1).sessionId;
  await f.gateway.receive(f.msg('话题二首条', { ...group, threadId: 'omt_two' }));
  const twoId = f.calls.at(-1).sessionId;
  await f.gateway.receive(f.msg('话题一回复', { ...group, threadId: 'omt_one', rootId: 'om_topic_root', senderId: 'ou_second' }));
  assert.equal(f.calls.at(-1).sessionId, oneId);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.sent.at(-1).options.replyInThread, true);
  await f.gateway.receive(f.msg('另一个群', { ...group, chatId: 'oc_other_group' }));
  assert.equal(new Set([privateId, groupId, oneId, twoId, f.calls.at(-1).sessionId]).size, 5);
  assert.ok(f.calls.every(call => call.cwd === fs.realpathSync(f.dir)));
  assert.equal((await f.gateway.messages({ chatId: 'oc_group' })).items[0].threadId, 'omt_one');
});

test('topic card switches affect only their original topic and survive restart', async t => {
  const f = await fixture(t); await f.pair(); await f.gateway.configure({ allowAllGroups: true, allowedChatIds: ['oc_group'] });
  const group = { chatType: 'group', chatId: 'oc_group', mentionedBot: true };
  const topic = { ...group, threadId: 'omt_one' };
  await f.gateway.receive(f.msg('话题一', topic)); const original = f.calls.at(-1).sessionId;
  await f.gateway.receive(f.msg('话题二', { ...group, threadId: 'omt_two' })); const other = f.calls.at(-1).sessionId;
  await f.gateway.receive(f.msg('/sessions', topic));
  const sent = f.sent.at(-1), key = contextKey(f.msg('', topic)), selected = f.rows.find(row => row.id !== original && row.id !== other);
  await f.gateway.action({ messageId: sent.messageId, chatId: group.chatId, operator: { openId: 'ou_owner' }, action: { value: { owner: 'ou_owner', key, action: 'switch', id: selected.id } } });
  assert.equal(f.sent.at(-1).options.replyInThread, true);
  await f.gateway.receive(f.msg('继续话题一', topic)); assert.equal(f.calls.at(-1).sessionId, selected.id);
  await f.gateway.receive(f.msg('继续话题二', { ...group, threadId: 'omt_two' })); assert.equal(f.calls.at(-1).sessionId, other);
  await f.gateway.stop(); const restored = createFeishuGateway(f.options); await restored.start();
  try {
    await restored.receive(f.msg('重启后继续话题一', topic)); assert.equal(f.calls.at(-1).sessionId, selected.id);
    await restored.receive(f.msg('重启后继续话题二', { ...group, threadId: 'omt_two' })); assert.equal(f.calls.at(-1).sessionId, other);
  } finally { await restored.stop(); }
});

test('/current and /new use the default project without rebinding other conversations', async t => {
  const f = await fixture(t); await f.pair();
  await f.gateway.receive(f.msg('/current'));
  const first = JSON.parse(fs.readFileSync(path.join(f.dir, 'panel-feishu-state.json'))).bindings[contextKey(f.msg(''))];
  assert.equal(first.cwd, fs.realpathSync(f.dir));
  await f.gateway.receive(f.msg('使用当前绑定')); assert.equal(f.calls.at(-1).sessionId, first.id);
  await f.gateway.receive(f.msg('/new'));
  await f.gateway.receive(f.msg('使用新绑定')); assert.notEqual(f.calls.at(-1).sessionId, first.id);
  assert.equal(f.calls.at(-1).cwd, fs.realpathSync(f.dir));
});

test('legacy bindings migrate only within their original group and never leak into a topic', async t => {
  const f = await fixture(t); await f.pair(); await f.gateway.configure({ allowAllGroups: true });
  await f.gateway.stop();
  const file = path.join(f.dir, 'panel-feishu-state.json'), saved = JSON.parse(fs.readFileSync(file));
  saved.bindings[JSON.stringify(['ou_owner', 'oc_group', 'main'])] = { id: f.rows[0].id, cwd: f.dir };
  fs.writeFileSync(file, JSON.stringify(saved));
  const restored = createFeishuGateway(f.options); await restored.start();
  try {
    const group = { chatType: 'group', chatId: 'oc_group', mentionedBot: true };
    await restored.receive(f.msg('继续旧群会话', group)); assert.equal(f.calls.at(-1).sessionId, f.rows[0].id);
    await restored.receive(f.msg('独立的新话题', { ...group, threadId: 'omt_fresh' }));
    assert.notEqual(f.calls.at(-1).sessionId, saved.bindings[JSON.stringify(['ou_owner', 'oc_group', 'main'])].id);
  } finally { await restored.stop(); }
});

test('open groups hide session controls and tool details while explicitly selected groups retain them', async t => {
  const f = await fixture(t); await f.pair(); await f.gateway.configure({ allowAllGroups: true });
  const group = { chatType: 'group', chatId: 'oc_open', mentionedBot: true, threadId: 'omt_open' };
  await f.gateway.receive(f.msg('公开群任务', group));
  await new Promise(resolve => setTimeout(resolve, 30));
  let rendered = JSON.stringify(f.sent.at(-1).content);
  assert.equal(f.sent.at(-1).content.post.zh_cn.content[0][0].text, 'A complete response.\n\n本机 · Claude Code · /codex 或 /claude 切换引擎 · 模型：默认（CLI 配置） · /model 切换模型');
  assert.equal(f.updated.length, 0);
  assert.deepEqual(f.reactions.map(x => x.action), ['add', 'remove']);
  assert.match(rendered, /A complete response/);
  assert.doesNotMatch(rendered, /README contents|README.md|会话信息|会话列表|查看会话|behaviors/);
  assert.equal(rendered.includes(f.dir), false);
  await f.gateway.receive(f.msg('/sessions', group)); assert.equal(f.sent.at(-1).content.card, undefined);
  await f.gateway.configure({ allowedChatIds: ['oc_open'] });
  await f.gateway.receive(f.msg('逐项授权群任务', group));
  await new Promise(resolve => setTimeout(resolve, 30));
  rendered = JSON.stringify(f.updated.at(-1).card);
  assert.match(rendered, /README contents/); assert.match(rendered, /会话信息/); assert.match(rendered, /查看最近对话/);
  await f.gateway.receive(f.msg('/sessions', group)); assert.ok(f.sent.at(-1).content.card);
});

test('delivery capabilities keep each turn in its original chat/topic and enforce expiration and current access', async t => {
  const f = await fixture(t); await f.pair(); await f.gateway.configure({ allowAllGroups: true });
  const tokenOf = call => call.gatewayContext.match(/"token":"([a-f0-9]+)"/)[1];
  await f.gateway.receive(f.msg('私聊发卡片'));
  const dmToken = tokenOf(f.calls.at(-1));
  const group = { chatType: 'group', chatId: 'oc_group', threadId: 'omt_one', mentionedBot: true };
  await f.gateway.receive(f.msg('话题一发卡片', group)); const one = tokenOf(f.calls.at(-1));
  await f.gateway.receive(f.msg('话题二发卡片', { ...group, threadId: 'omt_two' })); const two = tokenOf(f.calls.at(-1));
  assert.notEqual(one, two);
  assert.equal(f.calls.at(-1).prompt, '话题二发卡片');
  assert.equal(f.calls.at(-1).gatewayContext.includes('fake-test-secret'), false);
  let result = await f.gateway.sendReply({ token: one, text: '原话题回复' });
  assert.equal(result.threadId, 'omt_one'); assert.equal(f.sent.at(-1).chatId, 'oc_group'); assert.equal(f.sent.at(-1).options.replyInThread, true);
  result = await f.gateway.sendReply({ token: dmToken, text: '原私聊回复' }); assert.equal(result.chatId, 'oc_private'); assert.equal(f.sent.at(-1).options.replyInThread, false);
  await assert.rejects(f.gateway.sendReply({ token: two, text: '不能改目标', chatId: 'oc_private' }), /不能覆盖/);
  await f.gateway.configure({ allowAllGroups: false });
  await assert.rejects(f.gateway.sendReply({ token: two, text: '撤权后禁止' }), /未获准/);
  f.advance(2 * 60 * 60 * 1000 + 1);
  await assert.rejects(f.gateway.sendReply({ token: dmToken, text: '过期后禁止' }), /过期/);
});

test('anyone may mention the bot in allowed groups, while disabled users remain blocked everywhere and logged', async t => {
  const f = await fixture(t);
  await f.gateway.configure({ allowedChatIds: ['oc_group'] });
  const group = { senderId: 'ou_visitor', chatId: 'oc_group', chatType: 'group', threadId: 'omt_topic', mentionedBot: true };
  await f.gateway.receive(f.msg('访客首次提及', group)); assert.equal(f.calls.length, 1);
  const originalToken = f.calls.at(-1).gatewayContext.match(/"token":"([a-f0-9]+)"/)[1];
  assert.equal(f.gateway.status().inbox.users.find(item => item.id === group.senderId).mentionCount, 1);
  await f.gateway.receive(f.msg('访客私聊', { senderId: group.senderId })); assert.equal(f.calls.length, 1);
  await f.gateway.configure({ disabledUserIds: [group.senderId], allowAllUsers: true, allowAllGroups: true });
  const before = f.sent.length;
  await f.gateway.receive(f.msg('被禁用后在群里提及', group));
  await f.gateway.receive(f.msg('被禁用后私聊', { senderId: group.senderId }));
  await f.gateway.receive(f.msg(f.gateway.newPairing().command, { senderId: group.senderId }));
  await assert.rejects(f.gateway.sendReply({ token: originalToken, text: '禁用后禁止额外发送' }), /未获准/);
  assert.equal(f.calls.length, 1); assert.equal(f.sent.length, before);
  const records = (await f.gateway.messages()).items;
  assert.equal(records[0].access, 'disabled_user'); assert.equal(records[2].access, 'disabled_user');
  const card = { messageId: 'old-card', chatId: group.chatId, operator: { openId: group.senderId }, action: { value: { owner: group.senderId, key: contextKey(f.msg('', group)), action: 'switch', id: f.rows[0].id } } };
  await f.gateway.action(card); assert.equal(f.sent.length, before);
  await f.gateway.stop(); const restored = createFeishuGateway(f.options); await restored.start();
  try {
    await restored.receive(f.msg('重启后禁用仍在', group)); assert.equal(f.calls.length, 1);
    await restored.configure({ disabledUserIds: [], allowAllUsers: false, allowAllGroups: false });
    await restored.receive(f.msg('解除禁用后群里可用', group)); assert.equal(f.calls.length, 2);
    await restored.receive(f.msg('私聊仍需授权', { senderId: group.senderId })); assert.equal(f.calls.length, 2);
  } finally { await restored.stop(); }
});

test('idle sockets are not reported as connected and can be restarted; reconnection clears stale DNS errors', async t => {
  const f = await fixture(t);
  f.channel.getConnectionStatus = () => ({ state: 'idle' });
  assert.equal(f.gateway.status().phase, 'reconnecting');
  const connections = f.policies.length;
  await f.gateway.start(); assert.equal(f.policies.length, connections + 1);
  f.handlers.error(new Error('[ws],getaddrinfo ENOTFOUND open.feishu.cn'));
  assert.match(f.gateway.status().lastError, /ENOTFOUND/);
  f.channel.getConnectionStatus = () => ({ state: 'connected' });
  f.handlers.reconnected(); assert.equal(f.gateway.status().phase, 'connected'); assert.equal(f.gateway.status().lastError, '');
});

test('/new codex starts a Codex binding and adopts the thread ID the panel returns', async t => {
  const f = await fixture(t); await f.pair();
  const original = f.panel.submit, requested = [];
  f.panel.submit = async input => {
    requested.push(input);
    const sessionId = input.engine === 'codex' && !input.sessionId.startsWith('thread-') ? 'thread-0001-codex' : input.sessionId;
    await original({ ...input, sessionId }); return { sessionId };
  };
  await f.gateway.receive(f.msg('/new codex'));
  assert.match(JSON.stringify(f.sent.at(-1).content), /Codex · /);
  await f.gateway.receive(f.msg('first codex turn'));
  await f.gateway.receive(f.msg('second codex turn'));
  assert.equal(requested[0].engine, 'codex'); assert.equal(requested[0].model, '');
  assert.notEqual(requested[0].sessionId, 'thread-0001-codex');
  assert.equal(requested[1].sessionId, 'thread-0001-codex');
  await f.gateway.receive(f.msg('/projects'));
  assert.match(JSON.stringify(f.sent.at(-1).content), /改用 Codex/);
});

test('/route switches proxy accounts, modes, cooldowns, pins and Codex capture inside the gateway without invoking a model', async t => {
  const f = await fixture(t); await f.pair();
  const router = require('../proxy-router').createRouter({ dir: f.dir, port: 49999 });
  router.save({ mode: 'manual', selected: '', accounts: [
    { id: 'acc-a', name: 'Primary', url: 'https://a.example.com', token: 'secret-token-a', authType: 'bearer' },
    { id: 'acc-b', name: 'Backup', url: 'https://b.example.com', token: 'secret-token-b', authType: 'bearer' },
  ], selected: 'acc-a' });
  let capture = true;
  Object.assign(f.panel, {
    routes: () => ({ ...router.status(), pins: router.sessions().routes }), route: input => router.route(input), resetRoutes: () => router.reset(),
    pinRoute: (id, accountId) => router.setSessionRoute(id, accountId), codex: () => ({ version: '0.167.0', authMode: 'chatgpt', capture }), setCodexCapture: value => { capture = value; },
  });
  await f.gateway.receive(f.msg('/route'));
  let card = JSON.stringify(f.sent.at(-1).content);
  assert.match(card, /账号与连接/); assert.match(card, /Primary/); assert.match(card, /● 当前/); assert.doesNotMatch(card, /secret-token/);
  await f.gateway.receive(f.msg('/route 2'));
  assert.equal(router.status().selected, 'acc-b'); assert.equal(router.status().mode, 'manual');
  assert.match(JSON.stringify(f.sent.at(-1).content), /已切到「Backup」/);
  await f.gateway.receive(f.msg('/route auto')); assert.equal(router.status().mode, 'failover');
  await f.gateway.receive(f.msg('/route rr')); assert.equal(router.status().mode, 'round-robin');
  await f.gateway.receive(f.msg('/route primary')); assert.equal(router.status().selected, 'acc-a'); assert.equal(router.status().mode, 'manual');
  await f.gateway.receive(f.msg('/route codex direct')); assert.equal(capture, false);
  await f.gateway.receive(f.msg('/sessions')); await f.gateway.receive(f.msg('/switch 1'));
  await f.gateway.receive(f.msg('/route pin 2')); assert.equal(router.sessions().routes[f.rows[0].id], 'acc-b');
  await f.gateway.receive(f.msg('/route pin off')); assert.equal(router.sessions().routes[f.rows[0].id], undefined);
  await f.gateway.receive(f.msg('/route nobody')); assert.match(JSON.stringify(f.sent.at(-1).content), /没有找到该账号/);
  // tokens survive switching
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'panel-proxy.json'), 'utf8')).accounts[1].token, 'secret-token-b');
  // card buttons
  const key = contextKey(f.msg(''));
  await f.gateway.action({ action: { value: { owner: 'ou_owner', key, action: 'route', mode: 'failover' } }, operator: { openId: 'ou_owner' }, chatId: 'oc_private', messageId: 'card_route' });
  assert.equal(router.status().mode, 'failover');
  await f.gateway.action({ action: { value: { owner: 'ou_owner', key, action: 'route', selected: 'acc-b' } }, operator: { openId: 'ou_owner' }, chatId: 'oc_private', messageId: 'card_route' });
  assert.equal(router.status().selected, 'acc-b'); assert.equal(router.status().mode, 'manual');
  await f.gateway.action({ action: { value: { owner: 'ou_owner', key, action: 'route', codexCapture: true } }, operator: { openId: 'ou_owner' }, chatId: 'oc_private', messageId: 'card_route' });
  assert.equal(capture, true);
  assert.equal(f.calls.filter(call => call.prompt !== undefined).length, 0);
});

test('different topics keep Claude and Codex engines, real session IDs and model choices across restart', async t => {
  const f = await fixture(t); await f.pair(); await f.gateway.configure({ allowedChatIds: ['oc_group'], model: 'claude-model' });
  const group = { chatType: 'group', chatId: 'oc_group', mentionedBot: true };
  const claude = { ...group, threadId: 'omt_claude' }, codex = { ...group, threadId: 'omt_codex' };
  const original = f.panel.submit;
  f.panel.submit = async input => { const id = input.engine === 'codex' ? 'codex-real-thread' : input.sessionId; await original({ ...input, sessionId: id }); return { sessionId: id }; };
  await f.gateway.receive(f.msg('/new claude', claude));
  await f.gateway.receive(f.msg('/new codex', codex));
  await Promise.all([f.gateway.receive(f.msg('Claude first', claude)), f.gateway.receive(f.msg('Codex first', codex))]);
  const one = f.calls.find(call => call.prompt === 'Claude first'), two = f.calls.find(call => call.prompt === 'Codex first');
  assert.notEqual(one.sessionId, two.sessionId);
  assert.equal(one.engine || 'claude', 'claude'); assert.equal(one.model, 'claude-model');
  assert.equal(two.engine, 'codex'); assert.equal(two.model, ''); assert.equal(two.sessionId, 'codex-real-thread');
  const saved = JSON.parse(fs.readFileSync(path.join(f.dir, 'panel-feishu-state.json'))).bindings;
  assert.equal(saved[contextKey(f.msg('', claude))].engine, 'claude');
  assert.equal(saved[contextKey(f.msg('', codex))].engine, 'codex');
  assert.equal(saved[contextKey(f.msg('', codex))].id, 'codex-real-thread');
  await f.gateway.stop(); const restored = createFeishuGateway(f.options); await restored.start();
  try {
    await restored.receive(f.msg('Claude after restart', claude));
    assert.equal(f.calls.at(-1).sessionId, one.sessionId); assert.equal(f.calls.at(-1).model, 'claude-model');
    await restored.receive(f.msg('Codex after restart', { ...codex, senderId: 'ou_second' }));
    assert.equal(f.calls.at(-1).sessionId, two.sessionId); assert.equal(f.calls.at(-1).engine, 'codex'); assert.equal(f.calls.at(-1).model, '');
  } finally { await restored.stop(); }
});

test('switch commands and card switches persist the target engine and repair legacy bindings before submission', async t => {
  const f = await fixture(t); await f.pair(); await f.gateway.configure({ allowedChatIds: ['oc_group'], model: 'claude-only-model' });
  const codex = { id: '33333333-3333-4333-8333-333333333333', engine: 'codex', title: 'Codex existing', project: f.dir }; f.rows.push(codex);
  const topic = { chatType: 'group', chatId: 'oc_group', threadId: 'omt_switch', mentionedBot: true };
  const key = contextKey(f.msg('', topic));
  await f.gateway.receive(f.msg('/switch ' + codex.id, topic));
  let saved = JSON.parse(fs.readFileSync(path.join(f.dir, 'panel-feishu-state.json')));
  assert.equal(saved.bindings[key].engine, 'codex');
  await f.gateway.receive(f.msg('Existing Codex', topic)); assert.equal(f.calls.at(-1).engine, 'codex'); assert.equal(f.calls.at(-1).model, '');
  await f.gateway.receive(f.msg('/sessions', topic)); const card = f.sent.at(-1);
  await f.gateway.action({ messageId: card.messageId, chatId: topic.chatId, operator: { openId: 'ou_owner' }, action: { value: { owner: 'ou_owner', key, action: 'switch', id: f.rows.find(row => row.id !== codex.id).id } } });
  saved = JSON.parse(fs.readFileSync(path.join(f.dir, 'panel-feishu-state.json'))); assert.equal(saved.bindings[key].engine, 'claude');
  await f.gateway.receive(f.msg('/switch ' + codex.id, topic));
  await f.gateway.stop(); saved = JSON.parse(fs.readFileSync(path.join(f.dir, 'panel-feishu-state.json'))); delete saved.bindings[key].engine;
  fs.writeFileSync(path.join(f.dir, 'panel-feishu-state.json'), JSON.stringify(saved));
  const restored = createFeishuGateway(f.options); await restored.start();
  try { await restored.receive(f.msg('Legacy Codex', topic)); assert.equal(f.calls.at(-1).engine, 'codex'); assert.equal(f.calls.at(-1).model, ''); }
  finally { await restored.stop(); }
});

test('default engine controls new topics and /new, preserves existing bindings and survives restart', async t => {
  const f = await fixture(t); await f.pair();
  await f.gateway.receive(f.msg('Existing Claude'));
  const existing = f.calls.at(-1).sessionId;
  await f.gateway.configure({ defaultEngine: 'codex', allowAllGroups: true });
  assert.equal(f.gateway.status().config.defaultEngine, 'codex');
  await f.gateway.receive(f.msg('Continue existing')); assert.equal(f.calls.at(-1).sessionId, existing); assert.notEqual(f.calls.at(-1).engine, 'codex');
  const topic = { chatType: 'group', chatId: 'oc_default', threadId: 'omt_default', mentionedBot: true };
  await f.gateway.receive(f.msg('Fresh topic', topic)); assert.equal(f.calls.at(-1).engine, 'codex');
  await f.gateway.receive(f.msg('/new', topic)); await f.gateway.receive(f.msg('Default new', topic)); assert.equal(f.calls.at(-1).engine, 'codex');
  await f.gateway.receive(f.msg('/new claude', topic)); await f.gateway.receive(f.msg('Explicit Claude', topic)); assert.notEqual(f.calls.at(-1).engine, 'codex');
  await assert.rejects(f.gateway.configure({ defaultEngine: 'unknown' }), /默认引擎/);
  await new Promise(resolve => setTimeout(resolve, 30));
  await f.gateway.stop(); const restored = createFeishuGateway(f.options);
  try { await restored.messages({}); assert.equal(restored.status().config.defaultEngine, 'codex'); } finally { await restored.stop(); }
});

test('simple topics can inspect and change engines with short hints and no detailed session data', async t => {
  const f = await fixture(t); await f.pair(); await f.gateway.configure({ allowAllGroups: true, defaultEngine: 'codex' });
  const one = { chatType: 'group', chatId: 'oc_simple_engines', threadId: 'omt_one', mentionedBot: true };
  const two = { ...one, threadId: 'omt_two' };
  await f.gateway.receive(f.msg('/engine', one));
  assert.match(JSON.stringify(f.sent.at(-1).content), /默认引擎：Codex/); assert.equal(f.sent.at(-1).content.card, undefined);
  await f.gateway.receive(f.msg('Other topic', two)); const other = f.calls.at(-1).sessionId;
  await f.gateway.receive(f.msg('/engine claude', one));
  assert.match(JSON.stringify(f.sent.at(-1).content), /Claude Code/);
  await f.gateway.receive(f.msg('First topic', one)); assert.notEqual(f.calls.at(-1).engine, 'codex');
  await new Promise(resolve => setTimeout(resolve, 30));
  let reply = JSON.stringify(f.sent.at(-1).content); assert.match(reply, /Claude Code · \/codex/); assert.equal(reply.includes(f.dir), false);
  await f.gateway.receive(f.msg('/engine codex', one)); await f.gateway.receive(f.msg('First topic Codex', one)); assert.equal(f.calls.at(-1).engine, 'codex');
  await f.gateway.receive(f.msg('Other topic again', two)); assert.equal(f.calls.at(-1).sessionId, other); assert.equal(f.calls.at(-1).engine, 'codex');
  await f.gateway.receive(f.msg('/current', one)); reply = JSON.stringify(f.sent.at(-1).content); assert.match(reply, /Codex/); assert.equal(reply.includes(f.dir), false);
  await new Promise(resolve => setTimeout(resolve, 30));
});

test('engine picker cards start explicit engines without changing another topic binding', async t => {
  const f = await fixture(t); await f.pair(); await f.gateway.configure({ allowedChatIds: ['oc_engine_card'], defaultEngine: 'codex' });
  const topic = { chatType: 'group', chatId: 'oc_engine_card', threadId: 'omt_engine_card', mentionedBot: true };
  await f.gateway.receive(f.msg('/engine', topic)); const card = f.sent.at(-1), key = contextKey(f.msg('', topic));
  assert.match(JSON.stringify(card.content), /切换聊天程序/);
  await f.gateway.action({ messageId: card.messageId, chatId: topic.chatId, operator: { openId: 'ou_owner' }, action: { value: { owner: 'ou_owner', key, action: 'new', cwd: f.dir, engine: 'claude' } } });
  await f.gateway.receive(f.msg('Picked Claude', topic)); assert.notEqual(f.calls.at(-1).engine, 'codex');
  await f.gateway.receive(f.msg('/new', { ...topic, threadId: 'omt_other' }));
  await f.gateway.receive(f.msg('Default Codex', { ...topic, threadId: 'omt_other' })); assert.equal(f.calls.at(-1).engine, 'codex');
});

test('@bot new/engine/current commands are handled locally in detailed and simple topics', async t => {
  const f = await fixture(t); await f.pair(); f.channel.botIdentity = { name: 'Timi', openId: 'ou_bot' };
  await f.gateway.configure({ allowAllGroups: true, allowedChatIds: ['oc_detail_commands'] });
  for (const chatId of ['oc_detail_commands', 'oc_simple_commands']) {
    const topic = { chatType: 'group', chatId, threadId: 'omt_commands', mentionedBot: true };
    const before = f.calls.length;
    await f.gateway.receive(f.msg('@Timi /new codex', topic)); assert.equal(f.calls.length, before);
    assert.match(JSON.stringify(f.sent.at(-1).content), /Codex/);
    await f.gateway.receive(f.msg('Use Codex now', topic)); assert.equal(f.calls.at(-1).engine, 'codex');
    const after = f.calls.length;
    await f.gateway.receive(f.msg('@_user_1 /engine claude', { ...topic, mentions: [{ key: '@_user_1', openId: 'ou_bot', isBot: true }] })); assert.equal(f.calls.length, after);
    await f.gateway.receive(f.msg('@Timi /current', topic)); assert.equal(f.calls.length, after); assert.match(JSON.stringify(f.sent.at(-1).content), /Claude Code/);
    await f.gateway.receive(f.msg('Use Claude now', topic)); assert.notEqual(f.calls.at(-1).engine, 'codex');
    await new Promise(resolve => setTimeout(resolve, 30));
  }
});

test('discovered contacts resolve names and permit local labels without changing access rules', async t => {
  const f = await fixture(t); await f.pair();
  f.channel.getChatInfo = async () => ({ name: '研发群' });
  f.channel.rawClient = { contact: { v3: { user: { get: async () => ({ data: { user: { name: '张三' } } }) } } } };
  const group = { chatType: 'group', chatId: 'oc_names', mentionedBot: true };
  await f.gateway.receive(f.msg('Discovery only', group)); // blocked groups are recorded, never submitted.
  const result = await f.gateway.refreshContacts();
  assert.equal(result.inbox.groups.find(item => item.id === 'oc_names').displayName, '研发群');
  assert.equal(result.inbox.users.find(item => item.id === 'ou_owner').displayName, '张三');
  const labelled = await f.gateway.labelContact({ id: 'ou_owner', label: '我的工作账号' });
  assert.equal(labelled.inbox.users.find(item => item.id === 'ou_owner').displayName, '我的工作账号');
  assert.deepEqual(labelled.config.allowedChatIds, []); assert.equal(f.calls.length, 0);
  await assert.rejects(f.gateway.labelContact({ id: 'ou_unknown', label: 'Unknown' }), /已发现/);
});

test('short engine commands resume separate contexts, accept prompts and keep real Codex IDs across restart', async t => {
  const f = await fixture(t); await f.pair(); await f.gateway.configure({ allowedChatIds: ['oc_shortcuts'] });
  f.channel.botIdentity = { name: 'Timi', openId: 'ou_bot' };
  const topic = { chatType: 'group', chatId: 'oc_shortcuts', threadId: 'omt_shortcuts', mentionedBot: true };
  const original = f.panel.submit; let count = 0;
  f.panel.submit = async input => { const id = input.engine === 'codex' && !input.sessionId.startsWith('real-codex-') ? 'real-codex-' + ++count : input.sessionId; await original({ ...input, sessionId: id }); return { sessionId: id }; };
  await f.gateway.receive(f.msg('@Timi /codex 检查项目', topic));
  const codexId = f.calls.at(-1).sessionId; assert.equal(f.calls.at(-1).engine, 'codex'); assert.equal(f.calls.at(-1).prompt, '检查项目');
  await f.gateway.receive(f.msg('@Timi /claude 分析结果', topic)); const claudeId = f.calls.at(-1).sessionId; assert.notEqual(claudeId, codexId); assert.notEqual(f.calls.at(-1).engine, 'codex');
  await f.gateway.receive(f.msg('@Timi /codex 继续检查', topic)); assert.equal(f.calls.at(-1).sessionId, codexId); assert.equal(f.calls.at(-1).prompt, '继续检查');
  const before = f.calls.length; await f.gateway.receive(f.msg('/codex', topic)); assert.equal(f.calls.length, before);
  await f.gateway.receive(f.msg('/new codex', topic)); await f.gateway.receive(f.msg('Fresh Codex', topic)); const freshCodex = f.calls.at(-1).sessionId; assert.notEqual(freshCodex, codexId);
  assert.ok(f.rows.some(row => row.id === codexId));
  await f.gateway.receive(f.msg('/claude 继续分析', topic)); assert.equal(f.calls.at(-1).sessionId, claudeId);
  await f.gateway.receive(f.msg('/claude Other topic', { ...topic, threadId: 'omt_other' })); assert.notEqual(f.calls.at(-1).sessionId, claudeId);
  await f.gateway.stop(); const restored = createFeishuGateway(f.options); await restored.start();
  try {
    await restored.receive(f.msg('/codex Restored Codex', topic)); assert.equal(f.calls.at(-1).sessionId, freshCodex);
    await restored.receive(f.msg('/claude Restored Claude', topic)); assert.equal(f.calls.at(-1).sessionId, claudeId);
  } finally { await restored.stop(); }
});

test('SDK error objects produce meaningful redacted status instead of object coercion', async t => {
  const { errorMessage } = require('../feishu-gateway');
  assert.equal(errorMessage([{ message: 'Connection closed' }, { code: 'ECONNRESET' }]), 'Connection closed · 飞书请求失败（ECONNRESET）');
  assert.equal(errorMessage({ response: { data: { msg: 'Scope unavailable' } } }), 'Scope unavailable');
  assert.equal(errorMessage('[object Object],[object Object]'), '');
  const f = await fixture(t); await f.pair(); f.handlers.error([{ unknown: {} }, { another: {} }]);
  assert.doesNotMatch(f.gateway.status().lastError, /object Object/); assert.match(f.gateway.status().lastError, /服务日志/);
});

test('/session is a local alias for /sessions, including after a bot mention', async t => {
  const f = await fixture(t); await f.pair(); f.channel.botIdentity = { name: 'Timi', openId: 'ou_bot' };
  await f.gateway.receive(f.msg('@Timi /session First'));
  assert.equal(f.calls.length, 0); assert.match(JSON.stringify(f.sent.at(-1).content), /First session/);
  assert.doesNotMatch(JSON.stringify(f.sent.at(-1).content), /未知网关命令/);
});

test('/new without a default project offers interactive engine and project selection before any model call', async t => {
  const f = await fixture(t); await f.pair(); await f.gateway.configure({ defaultProject: '' });
  const callbacks = value => value && typeof value === 'object' ? [...(value.type === 'callback' ? [value.value] : []), ...Object.values(value).flatMap(callbacks)] : [];
  await f.gateway.receive(f.msg('/new codex'));
  const sent = f.sent.at(-1), actions = callbacks(sent.content), start = actions.find(value => value.action === 'new');
  assert.equal(f.calls.length, 0); assert.equal(start.engine, 'codex'); assert.equal(start.cwd, f.dir);
  assert.ok(actions.some(value => value.action === 'projects' && value.engine === 'claude'));
  await f.gateway.action({ messageId: sent.messageId, chatId: 'oc_private', operator: { openId: 'ou_owner' }, action: { value: start } });
  assert.equal(f.calls.length, 0); assert.match(JSON.stringify(f.sent.at(-1).content), /Codex/);
  await f.gateway.receive(f.msg('Use the chosen project'));
  assert.equal(f.calls.at(-1).engine, 'codex'); assert.equal(f.calls.at(-1).cwd, f.dir);
});

test('pending history cards are safe and old Codex card IDs resolve without changing the active engine', async t => {
  const f = await fixture(t); await f.pair();
  const original = f.panel.submit;
  f.panel.submit = async input => { const sessionId = input.engine === 'codex' ? 'codex-card-real' : input.sessionId; await original({ ...input, sessionId }); return { sessionId }; };
  await f.gateway.receive(f.msg('/new codex'));
  const card = f.sent.at(-1), key = contextKey(f.msg(''));
  const pendingId = JSON.parse(fs.readFileSync(path.join(f.dir, 'panel-feishu-state.json'))).bindings[key].id;
  const history = () => f.gateway.action({ messageId: card.messageId, chatId: 'oc_private', operator: { openId: 'ou_owner' }, action: { value: { owner: 'ou_owner', key, action: 'history', id: pendingId } } });
  await history(); assert.doesNotMatch(JSON.stringify(f.sent.at(-1).content), /会话不存在/); assert.equal(f.calls.length, 0);
  await f.gateway.receive(f.msg('Start Codex'));
  await f.gateway.receive(f.msg('/claude Start Claude')); const claudeId = f.calls.at(-1).sessionId;
  await history(); assert.match(JSON.stringify(f.sent.at(-1).content), /Saved reply/);
  await f.gateway.receive(f.msg('Continue current Claude')); assert.equal(f.calls.at(-1).sessionId, claudeId); assert.notEqual(f.calls.at(-1).engine, 'codex');
});

test('gateway context identifies the selected CLI version instead of another executable on PATH', async t => {
  const f = await fixture(t); await f.pair();
  f.panel.engineInfo = () => ({ path: '/custom/npm/bin/claude', version: '2.1.283' });
  await f.gateway.receive(f.msg('Which Claude version is running?'));
  assert.match(f.calls.at(-1).gatewayContext, /实际运行版本为 2\.1\.283/);
  assert.match(f.calls.at(-1).gatewayContext, /\$CLAUDE_CLI/);
});

test('history callback reports audit failure instead of failing silently', async t => {
  const f = await fixture(t); await f.pair(); await f.gateway.receive(f.msg('/sessions')); await f.gateway.receive(f.msg('/switch 1'));
  f.panel.history = () => [{ role: 'assistant', text: 'blocked-history-body' }];
  const original = f.channel.send;
  f.channel.send = async (...args) => { if (JSON.stringify(args).includes('blocked-history-body')) throw new Error('The messages do NOT pass the audit, ext=contain sensitive data: EMAIL_ADDRESS'); return original(...args); };
  await f.gateway.action({ messageId: f.sent.at(-1).messageId, chatId: 'oc_private', operator: { openId: 'ou_owner' }, action: { value: { owner: 'ou_owner', key: contextKey(f.msg('')), action: 'history', id: f.rows[0].id } } });
  assert.match(JSON.stringify(f.sent.at(-1).content), /飞书审核拦截/);
  assert.equal(f.calls.length, 0);
});

test('history previews redact emails and shorten long messages without mutating saved history', async t => {
  const f = await fixture(t); await f.pair(); await f.gateway.receive(f.msg('/sessions')); await f.gateway.receive(f.msg('/switch 1'));
  const history = [{ role: 'assistant', text: 'Contact person@example.invalid\n' + '长'.repeat(1000) }], original = JSON.stringify(history);
  f.panel.history = () => history;
  await f.gateway.receive(f.msg('/history'));
  const text = JSON.stringify(f.sent.at(-1).content);
  assert.doesNotMatch(text, /person@example/); assert.match(text, /邮箱已隐藏/); assert.match(text, /前 600 字/);
  assert.equal(JSON.stringify(history), original);
  f.panel.history = () => [];
  await f.gateway.receive(f.msg('/history')); assert.match(JSON.stringify(f.sent.at(-1).content), /暂无已保存的对话/);
  f.panel.history = () => { throw new Error('read failed'); };
  await f.gateway.receive(f.msg('/history')); assert.match(JSON.stringify(f.sent.at(-1).content), /读取或发送最近对话失败/);
});

test('fresh Feishu sessions request isolation and retain the resolved workspace across engine switches', async t => {
  const f = await fixture(t); await f.pair();
  const workspaceDir = path.join(f.dir, 'task-workspace'); fs.mkdirSync(workspaceDir);
  const workspace = { cwd: workspaceDir, path: workspaceDir, branch: 'my-agents/task-one', repository: f.dir };
  const original = f.panel.submit;
  f.panel.submit = async input => { await original({ ...input, cwd: workspaceDir }); return { sessionId: input.sessionId, cwd: workspaceDir, worktree: workspace }; };
  await f.gateway.receive(f.msg('/new claude')); await f.gateway.receive(f.msg('First isolated task'));
  assert.equal(f.calls.at(-1).worktree, true);
  await f.gateway.receive(f.msg('Continue'));
  assert.equal(f.calls.at(-1).cwd, workspaceDir); assert.equal(f.calls.at(-1).worktree, false);
  await f.gateway.receive(f.msg('/codex')); await f.gateway.receive(f.msg('/claude'));
  await f.gateway.receive(f.msg('Back to Claude')); assert.equal(f.calls.at(-1).cwd, workspaceDir);
  await f.gateway.configure({ worktree: false });
  await f.gateway.receive(f.msg('/new claude')); await f.gateway.receive(f.msg('Shared task'));
  assert.equal(f.calls.at(-1).worktree, false);
});

test('/node moves a topic to a remote node; turns, engine switches and project lists stay on that node', async t => {
  const f = await fixture(t); await f.pair();
  let online = true;
  f.panel.nodes = () => [{ id: 'devbox', label: '开发机', connected: online, home: '/home/me' }];
  f.panel.engineInfo = (engine, node) => ({ path: `/${node}/bin/${engine}`, version: '9.9' });
  const original = f.panel.submit;
  f.panel.submit = async input => { await original(input); const row = f.rows.find(item => item.id === input.sessionId); if (input.node) row.node = input.node; return { sessionId: input.sessionId, cwd: input.cwd.replace('~', '/home/me') }; };

  await f.gateway.receive(f.msg('/node'));
  const picker = JSON.stringify(f.sent.at(-1).content);
  assert.match(picker, /切换执行机器/); assert.match(picker, /开发机/); assert.match(picker, /use_node/);
  await f.gateway.receive(f.msg('/node devbox ~/repos/app'));
  assert.match(JSON.stringify(f.sent.at(-1).content), /开发机 · app/);
  await f.gateway.receive(f.msg('Run on the dev machine'));
  assert.equal(f.calls.at(-1).node, 'devbox'); assert.equal(f.calls.at(-1).cwd, '~/repos/app');
  assert.match(f.calls.at(-1).gatewayContext, /远程节点「开发机」上的 Claude Code CLI，实际运行版本为 9\.9，可执行文件为 "\/devbox\/bin\/claude"/);
  const devboxClaude = f.calls.at(-1).sessionId;
  await f.gateway.receive(f.msg('Continue there'));
  assert.equal(f.calls.at(-1).sessionId, devboxClaude); assert.equal(f.calls.at(-1).cwd, '/home/me/repos/app', 'the resolved remote directory is kept');

  await f.gateway.receive(f.msg('/codex Codex on the dev machine'));
  assert.equal(f.calls.at(-1).engine, 'codex'); assert.equal(f.calls.at(-1).node, 'devbox'); assert.equal(f.calls.at(-1).cwd, '/home/me/repos/app');
  await f.gateway.receive(f.msg('/projects'));
  const projects = JSON.stringify(f.sent.at(-1).content);
  assert.match(projects, /\/home\/me\/repos/); assert.ok(!projects.includes(f.dir), 'local folders are not offered for the remote node');
  await f.gateway.receive(f.msg('/claude'));
  await f.gateway.receive(f.msg('Back to Claude')); assert.equal(f.calls.at(-1).sessionId, devboxClaude);

  await f.gateway.receive(f.msg('/node local'));
  await f.gateway.receive(f.msg('Now on the Mac'));
  assert.equal(f.calls.at(-1).node, undefined); assert.equal(fs.realpathSync(f.calls.at(-1).cwd), fs.realpathSync(f.dir));
  await f.gateway.receive(f.msg('/node devbox'));
  await f.gateway.receive(f.msg('Back on the dev machine')); assert.equal(f.calls.at(-1).sessionId, devboxClaude, 'returning resumes that node\'s session');

  online = false;
  await f.gateway.receive(f.msg('/node local')); await f.gateway.receive(f.msg('/node devbox'));
  assert.match(JSON.stringify(f.sent.at(-1).content), /未连接/);
  await f.gateway.receive(f.msg('/node nowhere')); assert.match(JSON.stringify(f.sent.at(-1).content), /没有找到节点/);
  await f.gateway.receive(f.msg('/node devbox relative/path')); assert.match(JSON.stringify(f.sent.at(-1).content), /未连接|绝对路径/);
});

test('node picker card buttons switch the topic to the chosen machine', async t => {
  const f = await fixture(t); await f.pair();
  f.panel.nodes = () => [{ id: 'devbox', label: '开发机', connected: true, home: '/home/me' }];
  const key = contextKey(f.msg(''));
  const click = value => f.gateway.action({ action: { value: { owner: 'ou_owner', key, ...value } }, operator: { openId: 'ou_owner' }, chatId: 'oc_private', messageId: 'card_' + Math.random() });
  await click({ action: 'use_node', node: 'devbox' });
  const card = JSON.stringify(f.sent.at(-1).content);
  assert.match(card, /选择工作项目/); assert.match(card, /\/home\/me/);
  await click({ action: 'new', node: 'devbox', cwd: '/home/me', engine: 'claude' });
  await f.gateway.receive(f.msg('hello devbox'));
  assert.equal(f.calls.at(-1).node, 'devbox'); assert.equal(f.calls.at(-1).cwd, '/home/me');
  await click({ action: 'new', node: 'devbox', cwd: '/etc', engine: 'claude' });
  assert.match(JSON.stringify(f.sent.at(-1).content), /不可用/);
  await click({ action: 'use_node', node: 'evil' });
  assert.match(JSON.stringify(f.sent.at(-1).content), /节点无效/);
});

test('session accordions enrich only the current page and browsing user messages preserves bindings and list filters', async t => {
  const f = await fixture(t); await f.pair();
  for (let i = 2; i < 33; i++) f.rows.push({ id: `session-details-${i}`, title: `work ${i}`, project: f.dir });
  f.rows.forEach(item => { item.title = 'work ' + item.title; });
  const history = { messages: Array.from({ length: 12 }, (_, i) => ({ role: 'user', text: `question ${i + 1}`, timestamp: '2026-11-09T01:00:00Z' })) };
  const { sessionPreview, userMessagePage } = require('../core/session-previews');
  let enriched = [];
  f.panel.sessionPreviews = async items => { enriched = items.map(item => item.id); return items.map(item => sessionPreview(history, item)); };
  f.panel.sessionUserPage = async (item, page) => userMessagePage(history, page, item);
  await f.gateway.receive(f.msg('/sessions work')); await f.gateway.receive(f.msg('/switch 1'));
  const key = contextKey(f.msg(''));
  const binding = () => JSON.parse(fs.readFileSync(path.join(f.dir, 'panel-feishu-state.json'))).bindings[key].id;
  const original = binding();
  const click = (card, value, owner = 'ou_owner') => f.gateway.action({ messageId: card.messageId, chatId: 'oc_private', operator: { openId: owner }, action: { value: { owner: 'ou_owner', key, ...value } } });
  await f.gateway.receive(f.msg('/sessions work'));
  await click(f.sent.at(-1), { action: 'sessions', page: 1, query: 'work' });
  assert.equal(enriched.length, 5); assert.equal(enriched[0], f.rows[5].id);
  const list = f.sent.at(-1), before = f.sent.length;
  await click(list, { action: 'user_messages', id: f.rows[5].id }, 'ou_stranger'); assert.equal(f.sent.length, before);
  await click(list, { action: 'user_messages', id: f.rows[5].id });
  assert.match(JSON.stringify(f.sent.at(-1).content), /第 12 轮/); assert.equal(binding(), original);
  await click(f.sent.at(-1), { action: 'user_messages', id: f.rows[5].id, page: 1 });
  assert.match(JSON.stringify(f.sent.at(-1).content), /第 7 轮/); assert.equal(binding(), original);
  const allNodes = value => value && typeof value === 'object' ? [value, ...Object.values(value).flatMap(allNodes)] : [];
  const back = allNodes(f.sent.at(-1).content).find(node => node.type === 'callback' && node.value.action === 'sessions').value;
  assert.equal(back.page, 1); assert.equal(back.query, 'work');
  await click(f.sent.at(-1), back); assert.match(JSON.stringify(f.sent.at(-1).content), /6\. /);
  assert.equal(f.calls.length, 0); assert.equal(binding(), original);
});

test('stopping immediately after completion drains the final card instead of leaving thinking status', async t => {
  const f = await fixture(t); await f.pair();
  await f.gateway.receive(f.msg('Finish before restart'));
  await f.gateway.stop();
  assert.equal(f.updated.at(-1).card.header.title.content, '已完成');
  assert.equal(f.updated.at(-1).card.header.template, 'green');
  assert.match(JSON.stringify(f.updated.at(-1).card), /A complete response/);
  const state = JSON.parse(fs.readFileSync(path.join(f.dir, 'panel-feishu-state.json')));
  assert.equal(Object.keys(state.taskCards).length, 0);
});

test('closing an unfinished monitor records a truthful connection-ended state and removes task actions', async t => {
  const f = await fixture(t); await f.pair();
  f.panel.watch = (id, listener) => { listener('turn', { messageId: f.calls.at(-1).messageId }); listener('text', { messageId: f.calls.at(-1).messageId, text: 'Work so far' }); return () => {}; };
  await f.gateway.receive(f.msg('Still working during restart')); await f.gateway.stop();
  const card = f.updated.at(-1).card;
  assert.equal(card.header.title.content, '进度同步已中断'); assert.match(JSON.stringify(card), /Work so far/);
  assert.doesNotMatch(JSON.stringify(card), /停止任务/); assert.match(JSON.stringify(card), /确认结果后再继续/);
});

test('failed final delivery is persisted and repaired after gateway restart', async t => {
  const f = await fixture(t); await f.pair();
  const update = f.channel.updateCard;
  f.channel.updateCard = async () => { throw new Error('temporary transport failure'); };
  await f.gateway.receive(f.msg('Result must survive reconnect')); await f.gateway.stop();
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(f.dir, 'panel-feishu-state.json'))).taskCards).length, 1);
  f.channel.updateCard = update;
  const restored = createFeishuGateway(f.options); await restored.start();
  try {
    assert.equal(f.updated.at(-1).card.header.title.content, '已完成');
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(f.dir, 'panel-feishu-state.json'))).taskCards).length, 0);
  } finally { await restored.stop(); }
});

test('terminal events cannot be overwritten by late thinking events', async t => {
  const f = await fixture(t); await f.pair();
  f.panel.watch = (id, listener) => {
    const messageId = f.calls.at(-1).messageId;
    listener('text', { messageId, text: 'Final result' }); listener('done', { messageId });
    listener('reasoning', { messageId, id: 'late', text: 'late diagnostic' }); listener('turn', { messageId });
    return () => {};
  };
  await f.gateway.receive(f.msg('Terminal status is final')); await f.gateway.stop();
  assert.equal(f.updated.at(-1).card.header.title.content, '已完成');
  assert.doesNotMatch(JSON.stringify(f.updated.at(-1).card), /late diagnostic/);
});

test('a task card left by an abrupt exit is recovered without claiming the task completed', async t => {
  const f = await fixture(t); await f.pair(); await f.gateway.stop();
  const filename = path.join(f.dir, 'panel-feishu-state.json'), state = JSON.parse(fs.readFileSync(filename));
  const cards = require('../feishu-cards');
  state.taskCards = { abandoned: { appId: 'cli_test_app', done: false, card: cards.task({ owner: 'ou_owner', key: contextKey(f.msg('')), binding: { id: f.rows[0].id, cwd: f.dir }, title: 'Abandoned task', elapsed: 1000, view: { phase: '正在思考', text: 'Saved partial output', done: false, tools: new Map(), permissions: new Map() } }) } };
  fs.writeFileSync(filename, JSON.stringify(state));
  const restored = createFeishuGateway(f.options); await restored.start();
  try {
    const card = f.updated.at(-1).card;
    assert.equal(card.header.title.content, '进度同步已中断'); assert.notEqual(card.header.template, 'green');
    assert.match(JSON.stringify(card), /Saved partial output/); assert.doesNotMatch(JSON.stringify(card), /停止任务/);
  } finally { await restored.stop(); }
});

test('shutdown waits for an older card update before writing the terminal state', async t => {
  const f = await fixture(t); await f.pair();
  let listener, release, started;
  const began = new Promise(resolve => { started = resolve; });
  f.panel.watch = (id, next) => { listener = next; listener('turn', { messageId: f.calls.at(-1).messageId }); return () => {}; };
  const original = f.channel.updateCard; let first = true;
  f.channel.updateCard = async (...args) => { if (first) { first = false; started(); await new Promise(resolve => { release = resolve; }); } return original(...args); };
  await f.gateway.receive(f.msg('Slow card transport'));
  await began;
  listener('done', { messageId: f.calls.at(-1).messageId });
  const stopping = f.gateway.stop(); release(); await stopping;
  assert.equal(f.updated.at(-1).card.header.title.content, '已完成');
});

test('a follower cannot connect the Feishu gateway through start or configure', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-follower-'));
  let connects = 0;
  const leadership = { canStart: () => false };
  const gateway = createFeishuGateway({ dir, leadership, panel: { engines: () => [{ id: 'claude', label: 'Claude', capabilities: {} }] }, runtime: { status: () => ({}), keepAwake() {} }, channelFactory: () => ({ on() {}, async connect() { connects++; }, async disconnect() {} }) });
  t.after(async () => { await gateway.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  await gateway.configure({ enabled: true, appId: 'cli_follower', appSecret: 'secret', defaultEngine: 'claude' });
  assert.equal(connects, 0, 'configure only saves on a follower');
  await assert.rejects(gateway.start(), { status: 409 });
  assert.equal(connects, 0);
});

test('cold startup and cluster reload restore the configured Mac keep-awake state', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-awake-')), calls = [];
  fs.writeFileSync(path.join(dir, 'panel-feishu.json'), JSON.stringify({ keepAwake: true }));
  const runtime = { status: () => ({}), keepAwake: enabled => calls.push(enabled) };
  const gateway = createFeishuGateway({ dir, panel: { engines: () => [{ id: 'claude', label: 'Claude', capabilities: {} }] }, runtime });
  t.after(async () => { await gateway.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

  gateway.bootstrapRuntime();
  assert.deepEqual(calls, [true]);

  fs.writeFileSync(path.join(dir, 'panel-feishu.json'), JSON.stringify({ keepAwake: false }));
  await gateway.reload();
  assert.deepEqual(calls, [true, false]);
});

function enableFormFixture(f) {
  f.panel.machineId=()=> 'mac';
  f.panel.workspaces=()=>({selfId:'mac',machines:[{id:'mac',label:'Mac',online:true,home:f.dir},{id:'linux',label:'Linux',online:false}],config:{defaults:{mac:f.dir},projects:[{id:'app',name:'App',paths:{mac:f.dir}}]}});
  f.panel.resolveDirectory=async (_id,dir)=>dir;
}
function formSubmitValue(sent) {
  return sent.content.card.body.elements.find(e=>e.tag==='form').elements.find(e=>e.tag==='button').behaviors[0].value;
}
function formFields(prompt) {return {machineId:'mac',workspaceId:'app',engine:'claude',model:'__default__',worktree:'original',prompt};}

test('/new query opens one prefilled form; an SDK raw form submission starts once',async t=>{
  const f=await fixture(t);await f.pair();enableFormFixture(f);
  await f.gateway.receive(f.msg('/new 今天天气怎样？'));
  const sent=f.sent.at(-1),form=sent.content.card.body.elements.find(e=>e.tag==='form');
  assert.equal(form.elements.find(e=>e.name==='prompt').default_value,'今天天气怎样？');assert.equal(f.calls.length,0);
  const value=formSubmitValue(sent);
  const raw={operator:{open_id:'ou_owner'},context:{open_message_id:sent.messageId,open_chat_id:'oc_private'},action:{tag:'button',value,form_value:formFields('改成明天天气怎样？')}};
  const evt=require('@larksuiteoapi/node-sdk').normalizeCardAction(raw,{includeRaw:true});
  await f.gateway.action(evt);await f.gateway.action(evt);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].prompt,'改成明天天气怎样？');assert.equal(f.calls[0].machineId,'mac');
});

test('failed form submission preserves fields and the old binding, and a corrected retry starts once',async t=>{
  const f=await fixture(t);await f.pair();await f.gateway.receive(f.msg('/new'));enableFormFixture(f);
  const key=contextKey(f.msg('')),read=()=>JSON.parse(fs.readFileSync(path.join(f.dir,'panel-feishu-state.json')));
  const old=read().bindings[key].id;
  await f.gateway.receive(f.msg('/new 保留这条问题'));
  let sent=f.sent.at(-1),value=formSubmitValue(sent);
  const click=(card,v,fields)=>f.gateway.action({messageId:card.messageId,chatId:'oc_private',operator:{openId:'ou_owner'},action:{value:v,form_value:fields}});
  await click(sent,value,{...formFields('保留这条问题'),machineId:'linux'});
  assert.equal(f.calls.length,0);assert.equal(read().bindings[key].id,old);
  sent=f.sent.at(-1);assert.match(JSON.stringify(sent.content),/所选执行机器未连接/);assert.match(JSON.stringify(sent.content),/保留这条问题/);
  value=formSubmitValue(sent);await click(sent,value,formFields('修正后提交'));
  assert.equal(f.calls.length,1);assert.notEqual(read().bindings[key].id,old);
});

test('an engine startup error returns an editable form instead of replacing the old binding',async t=>{
  const f=await fixture(t);await f.pair();await f.gateway.receive(f.msg('/new'));enableFormFixture(f);
  const read=()=>JSON.parse(fs.readFileSync(path.join(f.dir,'panel-feishu-state.json'))),key=contextKey(f.msg('')),old=read().bindings[key].id;
  await f.gateway.receive(f.msg('/new Start'));const sent=f.sent.at(-1),value=formSubmitValue(sent),submit=f.panel.submit;
  f.panel.submit=async()=>{throw Error('CLI is unavailable')};
  await f.gateway.action({messageId:sent.messageId,chatId:'oc_private',operator:{openId:'ou_owner'},action:{value,form_value:formFields('Start')}});
  assert.equal(read().bindings[key].id,old);assert.match(JSON.stringify(f.sent.at(-1).content),/CLI is unavailable/);
  f.panel.submit=submit;
});

test('runtime failure keeps the submitted session and continues it once without reopening /new',async t=>{
  const f=await fixture(t);await f.pair();await f.gateway.receive(f.msg('/new'));enableFormFixture(f);
  const read=()=>JSON.parse(fs.readFileSync(path.join(f.dir,'panel-feishu-state.json'))),key=contextKey(f.msg('')),old=read().bindings[key].id;
  await f.gateway.receive(f.msg('/new Keep this query'));const form=f.sent.at(-1),value=formSubmitValue(form);let input;
  const submit=f.panel.submit,watch=f.panel.watch;
  f.panel.submit=async data=>{input=data;f.calls.push(data);return{sessionId:data.sessionId}};
  f.panel.watch=(_id,listener)=>{listener('error',{messageId:input.messageId,error:'provider rejected the model'});return()=>{}};
  await f.gateway.action({messageId:form.messageId,chatId:'oc_private',operator:{openId:'ou_owner'},action:{value,form_value:formFields('Keep this query')}});
  for(let i=0;i<50&&!f.updated.some(x=>JSON.stringify(x.card).includes('continue_task'));i++)await new Promise(r=>setTimeout(r,10));
  const failed=f.updated.find(x=>JSON.stringify(x.card).includes('continue_task'));
  assert.ok(failed);assert.match(JSON.stringify(failed.card),/provider rejected the model/);
  assert.notEqual(read().bindings[key].id,old);assert.equal(read().bindings[key].id,input.sessionId);
  assert.equal(read().drafts[value.draftId].status,'submitted');assert.equal(f.calls.length,1);
  assert.equal(f.sent.filter(x=>x.content.card?.body?.elements.some(e=>e.tag==='form')).at(-1).messageId,form.messageId);
  const find=node=>{if(!node||typeof node!=='object')return null;if(node.action==='continue_task')return node;for(const v of Object.values(node)){const result=find(v);if(result)return result;}return null};
  const resume=find(failed.card),evt={messageId:failed.id,chatId:'oc_private',operator:{openId:'ou_owner'},action:{value:resume}};
  // Another user cannot resume this task; duplicate clicks cannot replay it.
  await f.gateway.action({...evt,operator:{openId:'ou_other'}});assert.equal(f.calls.length,1);
  f.panel.submit=async()=>{throw Error('execution node is offline')};
  await f.gateway.action(evt);assert.equal(read().cards[failed.id].canContinue,true);
  assert.equal(read().drafts[value.draftId].status,'submitted');assert.equal(read().bindings[key].id,input.sessionId);
  assert.equal(f.sent.filter(x=>x.content.card?.body?.elements.some(e=>e.tag==='form')).at(-1).messageId,form.messageId);
  f.panel.submit=submit;f.panel.watch=watch;
  await f.gateway.action(evt);await f.gateway.action(evt);
  assert.equal(f.calls.length,2);assert.equal(f.calls[1].sessionId,f.calls[0].sessionId);
  assert.equal(f.calls[1].cwd,f.calls[0].cwd);assert.equal(f.calls[1].machineId,f.calls[0].machineId);
  assert.notEqual(f.calls[1].messageId,f.calls[0].messageId);assert.match(f.calls[1].prompt,/不要重复执行/);
});

test('a first engine shortcut keeps its query and uses the configured remote default machine',async t=>{
 const f=await fixture(t);await f.pair();f.panel.machineId=()=> 'linux';f.panel.nodes=()=>[{id:'mac',label:'Mac',connected:true}];
 await f.gateway.configure({defaultMachine:'mac'});
 await f.gateway.receive(f.msg('/claude Keep the first query'));
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].node,'mac');assert.equal(f.calls[0].machineId,'mac');assert.equal(f.calls[0].prompt,'Keep the first query');
});

for (const simple of [false, true]) test(`form turns keep real Feishu reply targets in ${simple ? 'simple' : 'detailed'} mode`,async t=>{
 const f=await fixture(t);await f.pair();enableFormFixture(f);
 const group=simple?{chatType:'group',chatId:'oc_form_ids',threadId:'omt_form_ids',mentionedBot:true}:{};
 if(simple)await f.gateway.configure({allowAllGroups:true});
 const send=f.channel.send;
 f.channel.send=async(chat,content,options)=>{assert.ok(!options?.replyTo?.startsWith('form_'),'internal form IDs cannot be reply targets');return send(chat,content,options)};
 const react=f.channel.addReaction;
 f.channel.addReaction=async(id,...args)=>{assert.ok(!id.startsWith('form_'),'reactions need a real Feishu message ID');return react(id,...args)};
 await f.gateway.receive(f.msg('/new Check IDs',group));
 const sent=f.sent.at(-1),value=formSubmitValue(sent),before=f.sent.length;
 await f.gateway.action({messageId:sent.messageId,chatId:group.chatId||'oc_private',chatType:group.chatType||'p2p',operator:{openId:'ou_owner'},action:{value,form_value:formFields('Check IDs')}});
 for(let i=0;i<30&&f.sent.length===before;i++)await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(f.calls.length,1);
 assert.equal(f.calls[0].messageId,messageUUID('form_'+value.draftId+':'+value.revision));
 assert.ok(f.calls[0].gatewayContext.includes('"messageId":"'+sent.messageId+'"'));
 assert.ok(f.sent.slice(before).some(message=>message.options.replyTo===sent.messageId));
});

test('Codex IM routes operate on the shared subscription pool and pin a manual choice to the conversation', async t => {
  const f = await fixture(t); await f.pair();
  f.panel.engines = () => [{ id: 'claude', label: 'Claude Code', capabilities: { accounts: true } }, { id: 'codex', label: 'Codex', capabilities: { accounts: true } }];
  f.rows[0].engine = 'codex';
  const accountCalls = [], pins = [], accounts = [{ id: 'sub-a', name: 'Subscription A', enabled: true }, { id: 'sub-b', name: 'Subscription B', enabled: true }];
  Object.assign(f.panel, {
    routes: engine => { accountCalls.push(['view', engine]); return { engine, mode: 'round-robin', accounts, pins: {} }; },
    route: (input, engine) => { accountCalls.push(['choose', engine, input]); return {}; },
    pinRoute: (id, account, engine) => pins.push([id, account, engine]),
  });
  await f.gateway.receive(f.msg('/sessions')); await f.gateway.receive(f.msg('/switch 1'));
  await f.gateway.receive(f.msg('/route')); assert.match(JSON.stringify(f.sent.at(-1).content), /Codex 账号池/);
  await f.gateway.receive(f.msg('/route 2'));
  assert.ok(accountCalls.some(call => call[0] === 'choose' && call[1] === 'codex' && call[2].selected === 'sub-b'));
  assert.equal(pins.at(-1)[1], 'sub-b'); assert.equal(pins.at(-1)[2], 'codex');
  await f.gateway.receive(f.msg('/route pin off')); assert.equal(pins.at(-1)[1], '');
});

test('an old remote card continues its own session after /new selects another executor', async t => {
  const f = await fixture(t); await f.pair();
  f.panel.machineId = () => 'sg';
  const old = { id: '33333333-3333-4333-8333-333333333333', machineId: 'mac', engine: 'claude', cwd: '/mac/original' };
  const lookups = [], reads = [];
  f.panel.resolveSession = async (id, hint) => { lookups.push({ id, hint }); return id === old.id ? { ...old, project: old.cwd } : null; };
  f.panel.history = async (id, machineId) => { reads.push({ id, machineId }); return [{ role: 'assistant', text: 'Original saved response' }]; };
  await f.gateway.receive(f.msg('/new'));
  const active = JSON.parse(fs.readFileSync(path.join(f.dir, 'panel-feishu-state.json'))).bindings[contextKey(f.msg(''))];
  const click = action => f.gateway.action({ messageId: 'old_evicted_card', chatId: 'oc_private', chatType: 'p2p', operator: { openId: 'ou_owner' }, action: { value: { owner: 'ou_owner', key: contextKey(f.msg('')), action, id: old.id } } });
  // No new payload hints: this card predates the fix and has left the cache.
  await click('history');
  assert.deepEqual(reads.at(-1), { id: old.id, machineId: 'mac' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'panel-feishu-state.json'))).bindings[contextKey(f.msg(''))].id, active.id);
  await click('switch'); await f.gateway.receive(f.msg('Continue the old task'));
  assert.equal(f.calls.at(-1).sessionId, old.id); assert.equal(f.calls.at(-1).machineId, 'mac'); assert.equal(f.calls.at(-1).cwd, old.cwd);
  assert.ok(lookups.some(item => item.id === old.id));
});

test('a never-started legacy card offers same-topic histories without changing the current binding', async t=>{
 const f=await fixture(t);await f.pair();await f.gateway.receive(f.msg('/sessions'));await f.gateway.receive(f.msg('/switch 1'));
 const key=contextKey(f.msg('')),before=JSON.parse(fs.readFileSync(path.join(f.dir,'panel-feishu-state.json'))).bindings[key].id;
 f.panel.resolveSession=async()=>null;
 await f.gateway.action({messageId:'legacy-orphan',chatId:'oc_private',chatType:'p2p',operator:{openId:'ou_owner'},action:{value:{owner:'ou_owner',key,action:'view',id:'33333333-3333-4333-8333-333333333333'}}});
 const card=f.sent.at(-1).content.card;
 assert.equal(card.header.title.content,'恢复旧会话');assert.match(JSON.stringify(card),new RegExp(before));
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'panel-feishu-state.json'))).bindings[key].id,before);
 assert.equal(f.calls.length,0);
});

test('a verified repair restores one orphan card and saves a backup without submitting any task', async t=>{
 const f=await fixture(t);await f.pair();const original='33333333-3333-4333-8333-333333333333',target=f.rows[0];
 const result=await f.gateway.repairCard({messageId:'om_legacy_failed',originalSessionId:original,targetSessionId:target.id,senderId:'ou_owner',chatId:'oc_private',chatType:'p2p'});
 assert.equal(result.sessionId,target.id);assert.ok(fs.existsSync(path.join(result.backup,'panel-feishu-state.json')));assert.equal(f.calls.length,0);
 const reads=[];f.panel.history=async(id,machineId)=>{reads.push({id,machineId});return[{role:'assistant',text:'Original history remains'}];};
 await f.gateway.action({messageId:'om_legacy_failed',chatId:'oc_private',chatType:'p2p',operator:{openId:'ou_owner'},action:{value:{owner:'ou_owner',key:contextKey(f.msg('')),action:'history',id:original}}});
 assert.equal(reads.at(-1).id,target.id);assert.equal(f.calls.length,0);
});

test('Feishu session search refreshes the cluster directory and searches native terminal labels', async t => {
  const f = await fixture(t); await f.pair(); let options;
  f.panel.sessionCatalog = async input => { options = input; return { sessions: [{ id: 'terminal-session-1234', title: 'project-plugin-recommendations', project: '/repo/.claude/worktrees/isolated-task', repository: '/repo', gitBranch: 'worktree-isolated-task', machineId: 'mac', latestPrompt: '需要新建表吗', native: true }], unavailable: [] }; };
  await f.gateway.receive(f.msg('/sessions isolated-task'));
  assert.deepEqual(options, { refresh: true, query: 'isolated-task' });
  const text = JSON.stringify(f.sent.at(-1).content); assert.match(text, /project-plugin-recommendations/); assert.match(text, /worktree-isolated-task/); assert.match(text, /需要新建表吗/);
  const key = contextKey(f.msg(''));
  await f.gateway.action({ messageId: f.sent.at(-1).messageId, chatId: 'oc_private', operator: { openId: 'ou_owner' }, action: { value: { owner: 'ou_owner', key, action: 'sessions_search' }, form_value: { query: '新建表' } } });
  assert.equal(options.query, '新建表'); assert.equal(f.calls.length, 0, 'searching never submits work');
});


test('SDK session switches retain machine and directory after a leader loses its local session cache',async t=>{
 const f=await fixture(t);await f.pair();
 f.panel.machineId=()=> 'sgdev';
 const native={id:'33333333-3333-4333-8333-333333333333',machineId:'mac',engine:'claude',project:'/Users/example/project/.claude/worktrees/native',title:'project-plugin-recommendations'};
 f.panel.sessionCatalog=async()=>({sessions:[native],unavailable:[]});
 await f.gateway.receive(f.msg('/sessions'));
 const list=f.sent.at(-1),nodes=value=>value&&typeof value==='object'?[value,...Object.values(value).flatMap(nodes)]:[];
 const value=nodes(list.content).find(n=>n.type==='callback'&&n.value.action==='switch').value;
 let hint;f.panel.resolveSession=async(id,input)=>{hint=input;return{...input,id,project:input.cwd,started:true}};
 value.key=JSON.stringify(['ou_owner','oc_fresh_private','main']);
 const raw={operator:{open_id:'ou_owner'},context:{open_message_id:'om_card_from_previous_leader',open_chat_id:'oc_fresh_private'},action:{tag:'button',value}};
 await f.gateway.action(require('@larksuiteoapi/node-sdk').normalizeCardAction(raw,{includeRaw:true}));
 assert.equal(hint.cwd,native.project);assert.equal(hint.machineId,'mac');
 assert.equal(f.sent.at(-1).content.card.header.title.content,'已切换到此会话');assert.match(JSON.stringify(f.sent.at(-1).content),/project-plugin-recommendations/);
 const binding=JSON.parse(fs.readFileSync(path.join(f.dir,'panel-feishu-state.json'))).bindings[value.key];
 assert.equal(binding.id,native.id);assert.equal(binding.cwd,native.project);assert.equal(binding.machineId,'mac');assert.equal(f.calls.length,0);
});

test('invalid card context explains how to refresh instead of silently ignoring the click',async t=>{
 const f=await fixture(t);await f.pair();
 await f.gateway.action({messageId:'bad-card',chatId:'oc_private',operator:{openId:'ou_owner'},action:{value:{action:'switch',id:f.rows[0].id,owner:'ou_owner',key:'{}'}}});
 assert.match(JSON.stringify(f.sent.at(-1).content),/卡片上下文无效/);assert.equal(f.calls.length,0);
});

test('an accepted native handover shows waiting instead of failure and keeps the original query',async t=>{
 const f=await fixture(t);await f.pair();await f.gateway.receive(f.msg('/sessions'));await f.gateway.receive(f.msg('/switch 1'));
 let input,listener;f.panel.submit=async value=>{input=value;f.calls.push(value);return{sessionId:value.sessionId}};
 f.panel.watch=(_id,fn)=>{listener=fn;fn('warning',{messageId:input.messageId,kind:'native_handoff',warning:'问题已接收，等待原机器本轮结束后接续'});return()=>{}};
 await f.gateway.receive(f.msg('前面聊了什么'));
 for(let i=0;i<100&&!f.updated.some(x=>x.card.header.title.content==='等待原会话接续');i++)await new Promise(r=>setTimeout(r,20));
 const waiting=f.updated.find(x=>x.card.header.title.content==='等待原会话接续');assert.ok(waiting);assert.match(JSON.stringify(waiting.card),/问题已接收/);
 assert.equal(input.sessionId,f.rows[0].id);assert.equal(input.prompt,'前面聊了什么');assert.equal(f.calls.length,1);
 listener('text',{messageId:input.messageId,text:'我们前面聊的是插件推荐。'});listener('done',{messageId:input.messageId});
 for(let i=0;i<50&&f.updated.at(-1).card.header.title.content!=='已完成';i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(f.updated.at(-1).card.header.title.content,'已完成');
});

test('a held original-terminal message keeps its card pending and receives the later answer',async t=>{
 const f=await fixture(t);await f.pair();await f.gateway.receive(f.msg('/sessions'));await f.gateway.receive(f.msg('/switch 1'));
 let input,listener;f.panel.submit=async value=>{input=value;f.calls.push(value);return{sessionId:value.sessionId}};
 f.panel.watch=(_id,fn)=>{listener=fn;fn('warning',{messageId:input.messageId,kind:'native_attachment',warning:'原终端已连接'});fn('warning',{messageId:input.messageId,kind:'native_approval',warning:'问题已接收，等待原窗口接收授权'});return()=>{}};
 await f.gateway.receive(f.msg('前面聊了什么'));
 for(let i=0;i<100&&!f.updated.some(x=>x.card.header.title.content==='等待原窗口确认');i++)await new Promise(r=>setTimeout(r,20));
 const waiting=f.updated.find(x=>x.card.header.title.content==='等待原窗口确认');assert.ok(waiting);assert.equal(waiting.card.header.template,'orange');assert.match(JSON.stringify(waiting.card),/问题已接收/);
 assert.equal(input.sessionId,f.rows[0].id);assert.equal(input.prompt,'前面聊了什么');assert.equal(f.calls.length,1);
 listener('turn',{messageId:input.messageId});listener('text',{messageId:input.messageId,text:'我们前面聊的是插件推荐。'});listener('done',{messageId:input.messageId});
 for(let i=0;i<50&&f.updated.at(-1).card.header.title.content!=='已完成';i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(f.updated.at(-1).card.header.title.content,'已完成');
});

test('settings opened from an old card stay read-only until explicitly switching to that conversation', async t => {
  const f = await fixture(t); await f.pair();
  await f.gateway.receive(f.msg('/new'));
  const original = f.sent.at(-1), oldState = JSON.parse(fs.readFileSync(path.join(f.dir, 'panel-feishu-state.json'))), oldBinding = oldState.bindings[contextKey(f.msg(''))];
  await f.gateway.receive(f.msg('/new'));
  const before = JSON.parse(fs.readFileSync(path.join(f.dir, 'panel-feishu-state.json'))).bindings[contextKey(f.msg(''))];
  for (const action of ['models', 'engine', 'nodes', 'route']) {
    await f.gateway.action({ messageId: original.messageId, chatId: 'oc_private', operator: { openId: 'ou_owner' }, action: { value: { owner: 'ou_owner', key: contextKey(f.msg('')), action, id: oldBinding.id } } });
    assert.match(JSON.stringify(f.sent.at(-1).content), /会话已切换|不是当前会话/);
  }
  const after = JSON.parse(fs.readFileSync(path.join(f.dir, 'panel-feishu-state.json'))).bindings[contextKey(f.msg(''))];
  assert.equal(after.id, before.id);
  assert.equal(f.calls.length, 0);
});
