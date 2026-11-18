const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createLarkSetup, readCreatedApp, findLarkCLI, generateQRCode } = require('../lark-setup');

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-lark-'));
  const children = [], executions = [], configured = [], spawns = [];
  const setup = createLarkSetup({ dir, findCLI: () => '/fake/lark-cli',
    spawnCLI(cli, args, opts) {
      spawns.push({ cli, args, opts });
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => { child.killed = true; };
      children.push(child); return child;
    },
    execute: async (cli, args, opts) => { executions.push({ cli, args, opts }); fs.writeFileSync(path.join(opts.cwd, 'setup-qr.png'), Buffer.from('qr-image')); },
    configure: async data => configured.push(data), ...options,
  });
  t.after(() => { setup.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, setup, children, executions, configured, spawns };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

// A registration the test approves or rejects by hand.
function pendingRegistration() {
  const r = { calls: [] };
  r.registerApp = options => { r.calls.push(options); options.onQRCodeReady({ url: r.url || 'https://accounts.feishu.cn/setup?opaque=a%2Fb+1', expireIn: 600 }); return new Promise((resolve, reject) => { r.approve = resolve; r.reject = reject; }); };
  return r;
}
const settle = async () => { for (let i = 0; i < 20; i++) await flush(); };

test('one scan creates the app with callbacks, pairs the scanner and greets them, without exposing secrets', async t => {
  const r = pendingRegistration(), steps = [], greeted = [];
  r.url = 'https://accounts.larksuite.com/setup?code=a%2Fb+z&state=x%3Dy';
  const f = fixture(t, { registerApp: r.registerApp, settleMs: 0, patchCallbacks: async app => steps.push(['patch', app.appId]), welcome: async (id, options) => greeted.push([id, options]) });
  await f.setup.start('lark'); await f.setup.start('lark'); await settle();
  assert.equal(r.calls.length, 1, 'a running setup is not started twice');
  const options = r.calls[0];
  assert.equal(options.createOnly, true); assert.equal(options.domain, 'accounts.larksuite.com');
  assert.deepEqual(options.addons.callbacks.items, ['card.action.trigger']);
  assert.ok(options.addons.events.items.tenant.includes('im.message.receive_v1'));
  assert.ok(options.addons.scopes.tenant.includes('application:application:patch'));
  assert.equal(f.children.length, 0, 'the CLI is only used to render the QR image');
  assert.equal(f.setup.status().verificationUrl, r.url);
  assert.equal(f.executions.length, 0, 'the page draws the QR code; no CLI is run');
  r.approve({ client_id: 'cli_new_test', client_secret: 'private-app-secret', user_info: { open_id: 'ou_owner_123', tenant_brand: 'lark' } }); await settle();
  assert.deepEqual(steps, [['patch', 'cli_new_test']]);
  assert.deepEqual(f.configured, [{ appId: 'cli_new_test', appSecret: 'private-app-secret', domain: 'lark', enabled: true, cardCallbacksReady: true, allowedUserIds: ['ou_owner_123'] }]);
  assert.deepEqual(greeted, [['ou_owner_123', { callbacks: true, appId: 'cli_new_test' }]]);
  const status = f.setup.status();
  assert.equal(status.phase, 'complete'); assert.equal(status.owner, true); assert.equal(status.welcomed, true);
  assert.equal(status.verificationUrl, '');
  assert.ok(!JSON.stringify(status).includes('private-app-secret'));
});

test('a new app that is not visible yet is retried; a failed callback patch still connects and says so', async t => {
  const r = pendingRegistration(), greeted = []; let connects = 0;
  const f = fixture(t, { registerApp: r.registerApp, settleMs: 0, patchCallbacks: async () => { throw new Error('scope not granted'); },
    configure: async data => { if (++connects < 3) throw new Error('app not found'); f.configured.push(data); }, welcome: async (id, options) => greeted.push(options) });
  await f.setup.start(); await settle();
  r.approve({ client_id: 'cli_slow_app', client_secret: 'secret', user_info: { open_id: 'ou_owner_456' } }); await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(connects, 3, 'connection retried until the new app is visible');
  assert.equal(f.configured[0].cardCallbacksReady, false);
  assert.deepEqual(greeted, [{ callbacks: false, appId: 'cli_slow_app' }], 'the welcome tells the owner how to enable card buttons');
  assert.equal(f.setup.status().purpose, 'callbacks', 'goes straight to the card-callback scan'); assert.equal(f.setup.status().afterCreate, true);
});

const installedCLI = findLarkCLI();
test('installed Lark CLI can generate a PNG outside its protected config directory', { skip: !installedCLI }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-qr-real-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const image = await generateQRCode(installedCLI, 'https://example.com/?code=opaque%2Ftest+value', { ...process.env, LARKSUITE_CLI_CONFIG_DIR: dir, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' });
  assert.deepEqual([...Buffer.from(image.split(',')[1], 'base64').subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});

test('cancelled and failed jobs never import credentials or expose raw output', async t => {
  const r = pendingRegistration();
  const f = fixture(t, { registerApp: r.registerApp, settleMs: 0 });
  await f.setup.start(); await settle(); f.setup.cancel();
  assert.equal(r.calls[0].signal.aborted, true);
  r.approve({ client_id: 'cli_cancelled', client_secret: 'do-not-expose' }); await settle();
  assert.equal(f.configured.length, 0);
  await f.setup.start(); await settle();
  r.reject(new Error('access_denied appSecret=do-not-expose')); await settle();
  assert.equal(f.setup.status().phase, 'error');
  assert.ok(!JSON.stringify(f.setup.status()).includes('do-not-expose'));
  assert.equal(f.setup.status().verificationUrl, '');
});

test('setup works without lark-cli installed', async t => {
  const r = pendingRegistration();
  const f = fixture(t, { findCLI: () => '', registerApp: r.registerApp });
  assert.equal(f.setup.status().available, true);
  await f.setup.start(); await settle();
  assert.equal(f.setup.status().phase, 'waiting');
  assert.match(f.setup.status().verificationUrl, /^https:\/\//);
  assert.equal(findLarkCLI({ LARK_CLI: '/nonexistent-lark-cli', PATH: '' }), '');
});

test('CLI encrypted app references are read without modifying the CLI keychain or config', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-lark-key-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const storage = path.join(dir, 'Library/Application Support/lark-cli'); fs.mkdirSync(storage, { recursive: true });
  const key = crypto.randomBytes(32), nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([nonce, cipher.update('encrypted-app-secret'), cipher.final(), cipher.getAuthTag()]);
  fs.writeFileSync(path.join(storage, 'appsecret_cli_new_test.enc'), encrypted);
  const config = JSON.stringify({ apps: [{ name: 'claude-panel', appId: 'cli_new_test', appSecret: { source: 'keychain', id: 'appsecret:cli_new_test' }, brand: 'feishu' }] });
  fs.writeFileSync(path.join(dir, 'config.json'), config);
  const calls = [];
  const encoded = key.toString('base64');
  for (const stored of [encoded, 'go-keyring-base64:' + Buffer.from(encoded).toString('base64'), 'go-keyring-encoded:' + Buffer.from(encoded).toString('hex')]) {
    const app = await readCreatedApp(dir, { platform: 'darwin', home: dir, execute: async (file, args) => { calls.push({ file, args }); return { stdout: stored }; } });
    assert.equal(app.appSecret, 'encrypted-app-secret');
  }
  assert.deepEqual(calls[0].args, ['find-generic-password', '-s', 'lark-cli', '-a', 'master.key', '-w']);
  assert.equal(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), config);
  fs.writeFileSync(path.join(storage, 'master.key.file'), key);
  assert.equal((await readCreatedApp(dir, { platform: 'darwin', home: dir })).appSecret, 'encrypted-app-secret');
});

 test('an already created app can reconnect without another registration or credential entry', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.dir, 'lark-cli'));
  fs.writeFileSync(path.join(f.dir, 'lark-cli/config.json'), JSON.stringify({ apps: [{ name: 'claude-panel', appId: 'cli_created_app', appSecret: 'created-app-secret', brand: 'feishu' }] }));
  assert.equal(f.setup.status().canRecover, true);
  const result = await f.setup.recover();
  assert.equal(result.phase, 'complete');
  assert.equal(f.children.length, 0);
  assert.equal(f.configured[0].appId, 'cli_created_app');
  assert.ok(!JSON.stringify(result).includes('created-app-secret'));
});

test('callback repair updates the existing app and waits for scan approval before applying configuration', async t => {
  let approve, registration;
  const steps = [];
  const f = fixture(t, {
    readApp: async () => ({ appId: 'cli_existing_bot', appSecret: 'existing-secret', domain: 'feishu' }),
    registerApp: options => { registration = options; options.onQRCodeReady({ url: 'https://accounts.feishu.cn/confirm?clientID=cli_existing_bot' }); return new Promise(resolve => { approve = resolve; }); },
    patchCallbacks: async app => { assert.equal(app.appId, 'cli_existing_bot'); steps.push('patch'); },
    configure: async app => { assert.equal(app.cardCallbacksReady, true); steps.push('connect'); },
  });
  await f.setup.repairCallbacks(); await flush();
  assert.equal(registration.appId, 'cli_existing_bot');
  assert.deepEqual(registration.addons.callbacks.items, ['card.action.trigger']);
  assert.deepEqual(registration.addons.scopes.tenant, ['application:application:patch']);
  assert.equal(f.children.length, 0, 'must not create another CLI app');
  assert.equal(f.setup.status().phase, 'waiting');
  assert.deepEqual(steps, []);
  approve({ client_id: 'cli_existing_bot', client_secret: 'existing-secret' }); await flush();
  assert.deepEqual(steps, ['patch', 'connect']);
  assert.equal(f.setup.status().phase, 'complete');
  assert.equal(f.setup.status().verificationUrl, '');
});

test('the vendored QR encoder sizes long setup URLs and rejects oversize input', () => {
  const QR = require('../vendor/qr.js');
  assert.equal(QR.matrix('hi').length, 21);
  const long = 'https://accounts.feishu.cn/setup?addons=' + 'a'.repeat(600);
  const m = QR.matrix(long); assert.ok(m.length > 21 && m.length <= 177 && m.every(row => row.length === m.length));
  assert.match(QR.svg(long), /^<svg [^>]*viewBox/);
  assert.throws(() => QR.matrix('x'.repeat(5000)), /过长/);
});

test('when callbacks do not take after creation, the extra scan starts at once for the new bot', async t => {
  const calls = []; let approve;
  const registerApp = options => { calls.push(options); options.onQRCodeReady({ url: 'https://accounts.feishu.cn/x?' + calls.length, expireIn: 600 }); return new Promise(resolve => { if (calls.length === 1) resolve({ client_id: 'cli_new_bot_1', client_secret: 'new-secret', user_info: { open_id: 'ou_owner_9' } }); else approve = resolve; }); };
  let patches = 0; const configured = [];
  const f = fixture(t, { registerApp, settleMs: 0, currentApp: () => ({ appId: 'cli_primary_bot', appSecret: 'p', domain: 'feishu' }),
    patchCallbacks: async app => { patches++; if (!approve || app.appId !== 'cli_new_bot_1') throw new Error('not yet'); },
    configure: async data => configured.push(data), welcome: async () => {} });
  await f.setup.start();
  await new Promise(r => setTimeout(r, 100));
  assert.equal(calls.length, 2, 'repair scan started automatically');
  assert.equal(calls[1].appId, 'cli_new_bot_1', 'targets the new bot, not the primary');
  const status = f.setup.status();
  assert.equal(status.purpose, 'callbacks'); assert.equal(status.afterCreate, true); assert.equal(status.phase, 'waiting');
  assert.ok(!JSON.stringify(status).includes('new-secret'));
  approve({ client_id: 'cli_new_bot_1', client_secret: 'new-secret' }); await new Promise(r => setTimeout(r, 50));
  assert.equal(f.setup.status().phase, 'complete');
  assert.equal(configured.at(-1).appId, 'cli_new_bot_1'); assert.equal(configured.at(-1).cardCallbacksReady, true);
});
