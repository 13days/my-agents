const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createFeishuBots } = require('../feishu-bots');

// Fake gateways record what each bot was asked to do, keyed by its config file.
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-bots-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const made = [];
  const create = ({ files = {}, runtime, inboxDir }) => {
    const file = path.join(dir, files.config || 'panel-feishu.json');
    let config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}, phase = 'disabled';
    const gateway = { file, runtime, inboxDir, starts: 0, replies: new Set(),
      status: () => ({ config, phase, lastError: '' }),
      async configure(input) { config = { ...config, ...input }; fs.writeFileSync(file, JSON.stringify(config)); phase = 'connected'; return gateway.status(); },
      async start() { gateway.starts++; if (config.appId === 'cli_broken_bot') throw new Error('boom'); phase = 'connected'; },
      async stop() { phase = 'disabled'; }, async reload() { config = JSON.parse(fs.readFileSync(file, 'utf8')); }, async bootstrap() { return gateway.start(); },
      hasReplyTarget: token => gateway.replies.has(token), async sendReply(input) { return { from: config.appId, token: input.token }; },
      async welcome(openId) { gateway.welcomed = openId; } };
    made.push(gateway); return gateway;
  };
  return { dir, made, bots: () => createFeishuBots({ dir, create, runtime: { keepAwake() { throw new Error('extras must not touch runtime'); } } }) };
}

test('a second bot is added next to the primary one instead of replacing it, and inherits portable settings', async t => {
  const f = fixture(t), bots = f.bots();
  await bots.addOrConfigure({ appId: 'cli_timi_bot', appSecret: 's1', allowedUserIds: ['ou_me'], defaultProject: '/repo', allowedChatIds: ['oc_team'] });
  await bots.addOrConfigure({ appId: 'cli_second_bot', appSecret: 's2', allowedUserIds: ['ou_scanner'] });
  assert.equal(bots.status().config.appId, 'cli_timi_bot', 'primary untouched');
  const second = JSON.parse(fs.readFileSync(path.join(f.dir, 'panel-feishu-bot-cli_second_bot.json'), 'utf8'));
  assert.equal(second.defaultProject, '/repo'); assert.deepEqual(second.allowedChatIds, ['oc_team']);
  assert.deepEqual(second.allowedUserIds, ['ou_scanner'], 'open ids are per app and are not copied');
  assert.deepEqual(bots.bots().map(b => [b.appId, b.primary]), [['cli_timi_bot', true], ['cli_second_bot', false]]);
  assert.doesNotThrow(() => f.made[1].runtime.keepAwake(), 'extra bots get a no-op runtime');
  assert.ok(f.made[1].inboxDir.includes(path.join('feishu-bots', 'cli_second_bot')), 'each bot has a private inbox');
  // Replies route to the bot that issued the token.
  f.made[1].replies.add('tok-2');
  assert.equal((await bots.sendReply({ token: 'tok-2' })).from, 'cli_second_bot');
  assert.equal((await bots.sendReply({ token: 'unknown' })).from, 'cli_timi_bot');
  await bots.welcome('ou_scanner', { appId: 'cli_second_bot' }); assert.equal(f.made[1].welcomed, 'ou_scanner');
});

test('bots survive a restart, a broken extra does not block the primary, and removal deletes its files', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, 'panel-feishu.json'), JSON.stringify({ appId: 'cli_timi_bot' }));
  fs.writeFileSync(path.join(f.dir, 'panel-feishu-bot-cli_broken_bot.json'), JSON.stringify({ appId: 'cli_broken_bot' }));
  fs.writeFileSync(path.join(f.dir, 'panel-feishu-bot-cli_broken_bot-state.json'), '{}');
  const bots = f.bots();
  await bots.start();
  assert.deepEqual(bots.bots().map(b => b.appId), ['cli_timi_bot', 'cli_broken_bot']);
  assert.equal(bots.bots()[0].phase, 'connected');
  await bots.removeBot('cli_broken_bot');
  assert.equal(fs.existsSync(path.join(f.dir, 'panel-feishu-bot-cli_broken_bot.json')), false);
  assert.equal(fs.existsSync(path.join(f.dir, 'panel-feishu-bot-cli_broken_bot-state.json')), false);
  await assert.rejects(bots.removeBot('cli_timi_bot'), /主机器人/);
});
