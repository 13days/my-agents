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

test('QR creation streams an unchanged URL, uses isolated config, and imports credentials without exposing secrets', async t => {
  const f = fixture(t);
  await f.setup.start('lark'); await f.setup.start('lark');
  assert.equal(f.children.length, 1);
  assert.deepEqual(f.spawns[0].args, ['config', 'init', '--new', '--brand', 'lark', '--name', 'my-agents']);
  assert.equal(f.spawns[0].opts.env.LARKSUITE_CLI_CONFIG_DIR, path.join(f.dir, 'lark-cli'));
  const url = 'https://accounts.larksuite.com/setup?code=a%2Fb+z&state=x%3Dy';
  f.children[0].stderr.write('Open:\n  ' + url.slice(0, 35));
  f.children[0].stderr.write(url.slice(35) + '\nWaiting\n'); await flush();
  assert.equal(f.setup.status().verificationUrl, url);
  assert.deepEqual(f.executions[0].args, ['auth', 'qrcode', url, '--output', 'setup-qr.png']);
  assert.notEqual(f.executions[0].opts.cwd, f.spawns[0].opts.env.LARKSUITE_CLI_CONFIG_DIR);
  assert.equal(fs.existsSync(f.executions[0].opts.cwd), false, 'temporary QR files are removed after reading');
  assert.match(f.setup.status().qrImage, /^data:image\/png;base64,/);
  fs.writeFileSync(path.join(f.dir, 'lark-cli/config.json'), JSON.stringify({ apps: [{ name: 'claude-panel', appId: 'cli_new_test', appSecret: 'private-app-secret', brand: 'lark' }] }));
  f.children[0].emit('close', 0); await flush();
  assert.deepEqual(f.configured, [{ appId: 'cli_new_test', appSecret: 'private-app-secret', domain: 'lark', enabled: true }]);
  assert.equal(f.setup.status().phase, 'complete');
  assert.equal(f.setup.status().verificationUrl, '');
  assert.ok(!JSON.stringify(f.setup.status()).includes('private-app-secret'));
});

test('QR failure retains the unchanged setup link and keeps app registration alive', async t => {
  const f = fixture(t, { execute: async () => { throw new Error('unsafe output path'); } });
  await f.setup.start();
  const url = 'https://accounts.feishu.cn/setup?opaque=a%2Fb+1';
  f.children[0].stderr.write(url + '\n'); await flush();
  assert.equal(f.setup.status().phase, 'waiting');
  assert.equal(f.setup.status().verificationUrl, url);
  assert.match(f.setup.status().error, /打开下方链接/);
  assert.equal(f.children[0].killed, undefined);
});

const installedCLI = findLarkCLI();
test('installed Lark CLI can generate a PNG outside its protected config directory', { skip: !installedCLI }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-qr-real-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const image = await generateQRCode(installedCLI, 'https://example.com/?code=opaque%2Ftest+value', { ...process.env, LARKSUITE_CLI_CONFIG_DIR: dir, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' });
  assert.deepEqual([...Buffer.from(image.split(',')[1], 'base64').subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});

test('cancelled and failed jobs never import credentials or expose raw CLI output', async t => {
  const f = fixture(t);
  await f.setup.start(); f.setup.cancel(); f.children[0].emit('close', 0); await flush();
  assert.equal(f.configured.length, 0); assert.equal(f.children[0].killed, true);
  await f.setup.start();
  f.children[1].stderr.write('appSecret=do-not-expose\n'); f.children[1].emit('close', 1);
  assert.equal(f.setup.status().phase, 'error');
  assert.ok(!JSON.stringify(f.setup.status()).includes('do-not-expose'));
  assert.equal(f.setup.status().verificationUrl, '');
});

test('missing CLI is reported without starting configuration', async t => {
  const f = fixture(t, { findCLI: () => '' });
  assert.equal(f.setup.status().available, false);
  await assert.rejects(f.setup.start(), /未检测到/);
  assert.equal(f.children.length, 0);
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
