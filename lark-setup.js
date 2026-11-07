const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const run = promisify(execFile);

async function generateQRCode(cli, url, env, execute = run) {
  // The CLI denies output beneath its config directory, even when it is cwd.
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-lark-qr-'));
  try {
    await execute(cli, ['auth', 'qrcode', url, '--output', 'setup-qr.png'], { cwd: temp, env, timeout: 15000 });
    return 'data:image/png;base64,' + fs.readFileSync(path.join(temp, 'setup-qr.png')).toString('base64');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

function findLarkCLI(env = process.env) {
  const names = env.LARK_CLI ? [env.LARK_CLI] : ['lark-cli'];
  const dirs = [...(env.PATH || '').split(path.delimiter), path.join(os.homedir(), '.npm-global/bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const name of names) for (const candidate of path.isAbsolute(name) ? [name] : dirs.map(dir => path.join(dir, name))) {
    try { fs.accessSync(candidate, fs.constants.X_OK); if (fs.statSync(candidate).isFile()) return candidate; } catch {}
  }
  return '';
}

// Reads the CLI's own SecretRef format without changing its credential storage.
// Format: github.com/larksuite/cli/internal/{core/secret_resolve,keychain/keychain_darwin}.go
async function readCreatedApp(configDir, { home = os.homedir(), platform = process.platform, env = process.env, execute = run } = {}) {
  const config = JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8'));
  const app = config.apps?.find(item => item.name === 'my-agents') || config.apps?.find(item => item.name === 'claude-panel') || config.apps?.find(item => item.appId === config.currentApp) || config.apps?.[0] || config;
  if (!/^[\w-]{8,100}$/.test(app.appId || '')) throw new Error('未能读取新建应用的信息');
  let secret = app.appSecret;
  if (secret?.source === 'file') secret = fs.readFileSync(path.resolve(configDir, secret.id), 'utf8').trim();
  if (secret?.source === 'keychain') {
    if (secret.id !== `appsecret:${app.appId}`) throw new Error('应用密钥引用不匹配');
    const serviceDir = platform === 'darwin' ? path.join(home, 'Library/Application Support/lark-cli') : path.join(env.LARKSUITE_CLI_DATA_DIR || path.join(home, '.local/share'), 'lark-cli');
    const encrypted = fs.readFileSync(path.join(serviceDir, secret.id.replace(/[^a-zA-Z0-9._-]/g, '_') + '.enc'));
    let key;
    try { key = fs.readFileSync(path.join(serviceDir, platform === 'darwin' ? 'master.key.file' : 'master.key')); }
    catch (e) {
      if (platform !== 'darwin' || e.code !== 'ENOENT') throw new Error('无法读取 CLI 的应用密钥');
      try {
        const result = await execute('/usr/bin/security', ['find-generic-password', '-s', 'lark-cli', '-a', 'master.key', '-w'], { timeout: 15000 });
        // go-keyring wraps the stored base64 key in its own encoding envelope.
        // https://github.com/zalando/go-keyring/blob/v0.2.8/keyring_darwin.go
        let encoded = result.stdout.trim();
        if (encoded.startsWith('go-keyring-base64:')) encoded = Buffer.from(encoded.slice('go-keyring-base64:'.length), 'base64').toString('utf8');
        else if (encoded.startsWith('go-keyring-encoded:')) encoded = Buffer.from(encoded.slice('go-keyring-encoded:'.length), 'hex').toString('utf8');
        key = Buffer.from(encoded, 'base64');
      } catch { throw new Error('请允许系统钥匙串访问，然后重试接入'); }
    }
    if (key.length !== 32 || encrypted.length < 28) throw new Error('CLI 应用密钥格式无效');
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, encrypted.subarray(0, 12));
      decipher.setAuthTag(encrypted.subarray(-16));
      secret = Buffer.concat([decipher.update(encrypted.subarray(12, -16)), decipher.final()]).toString('utf8');
    } finally { key.fill(0); }
  }
  if (typeof secret !== 'string' || !secret || secret === '****') throw new Error('无法读取新建应用的密钥');
  return { appId: app.appId, appSecret: secret, domain: app.brand === 'lark' ? 'lark' : 'feishu' };
}

async function patchCardCallbacks(credentials) {
  const sdk = require('@larksuiteoapi/node-sdk');
  const client = new sdk.Client({ appId: credentials.appId, appSecret: credentials.appSecret, domain: credentials.domain === 'lark' ? sdk.Domain.Lark : sdk.Domain.Feishu, loggerLevel: sdk.LoggerLevel.error, logger: { error() {}, warn() {}, info() {}, debug() {}, trace() {} } });
  const result = await client.application.v7.applicationConfig.patch({ path: { app_id: credentials.appId }, data: { callback: { callback_type: 'websocket', add_callbacks: ['card.action.trigger'] } } });
  if (result.code !== 0) throw new Error('卡片回调配置未生效');
}

function createLarkSetup({ dir, configure, findCLI = findLarkCLI, spawnCLI = spawn, execute = run, readApp = readCreatedApp, registerApp = options => require('@larksuiteoapi/node-sdk').registerApp(options), patchCallbacks = patchCardCallbacks, timeoutMs = 10 * 60 * 1000 }) {
  const configDir = path.join(dir, 'lark-cli');
  let job = null;
  const status = () => ({ available: !!findCLI(), phase: job?.phase || 'idle', purpose: job?.purpose || 'create', verificationUrl: job?.url || '', qrImage: job?.qrImage || '', error: job?.error || '', canRecover: fs.existsSync(path.join(configDir, 'config.json')) });
  const clearQR = current => { current.url = ''; current.qrImage = ''; current.buffer = ''; };
  const stopChild = child => {
    // npm's launcher forks the native CLI; stop the entire owned process group.
    if (!child) return;
    if (process.platform !== 'win32' && child.pid && child.exitCode === null) {
      try { process.kill(-child.pid, 'SIGTERM'); return; } catch {}
    }
    child.kill('SIGTERM');
  };
  function cancel() {
    if (!job || !['starting', 'waiting', 'completing'].includes(job.phase)) return;
    job.phase = 'cancelled'; clearQR(job); clearTimeout(job.timer); job.abort?.abort(); stopChild(job.child);
  }
  async function start(domain = 'feishu') {
    if (job && ['starting', 'waiting', 'completing'].includes(job.phase)) return status();
    if (!['feishu', 'lark'].includes(domain)) throw new Error('请选择飞书或 Lark');
    const cli = findCLI();
    if (!cli) throw new Error('未检测到 lark-cli，请使用手动配置');
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const current = job = { phase: 'starting', url: '', qrImage: '', error: '', buffer: '' };
    const env = { ...process.env, LARKSUITE_CLI_CONFIG_DIR: configDir, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' };
    const fail = message => {
      if (job !== current || ['complete', 'cancelled', 'error'].includes(current.phase)) return;
      current.phase = 'error'; current.error = message; clearQR(current); clearTimeout(current.timer);
    };
    const output = chunk => {
      if (job !== current || !['starting', 'waiting'].includes(current.phase)) return;
      current.buffer = (current.buffer + chunk.toString()).slice(-65536);
      const lines = current.buffer.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/);
      current.buffer = lines.pop();
      for (const line of lines) {
        const url = line.match(/https:\/\/[^\s<>"\x1b]+/)?.[0];
        if (!url || current.url) continue;
        // Keep the original URL byte-for-byte for both the link and QR code.
        current.url = url; current.phase = 'waiting';
        generateQRCode(cli, url, env, execute).then(image => {
          if (job === current && current.phase === 'waiting') current.qrImage = image;
        }).catch(() => {
          if (job === current && current.phase === 'waiting') current.error = '二维码生成失败，可打开下方链接继续创建，或取消后重试';
        });
      }
    };
    try {
      const child = current.child = spawnCLI(cli, ['config', 'init', '--new', '--brand', domain, '--name', 'my-agents'], { cwd: configDir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
      child.stdout.on('data', output); child.stderr.on('data', output);
      child.on('error', () => fail('无法启动 lark-cli，请检查安装后重试'));
      child.on('close', async code => {
        clearTimeout(current.timer);
        if (job !== current || !['starting', 'waiting'].includes(current.phase)) return;
        if (code !== 0) return fail('创建未完成或二维码已过期，请重新扫码创建');
        current.phase = 'completing'; clearQR(current);
        try {
          const credentials = await readApp(configDir);
          if (job !== current || current.phase !== 'completing') return;
          await configure({ ...credentials, enabled: true });
          if (current.phase === 'completing') current.phase = 'complete';
        } catch { fail('应用已创建，但自动接入失败，请检查系统钥匙串权限或使用手动配置'); }
      });
      current.timer = setTimeout(() => { fail('二维码已过期，请重新扫码创建'); stopChild(child); }, timeoutMs); current.timer.unref();
    } catch { fail('无法启动 lark-cli，请检查安装后重试'); }
    return status();
  }
  async function recover() {
    if (job && ['starting', 'waiting', 'completing'].includes(job.phase)) return status();
    const current = job = { phase: 'completing', url: '', qrImage: '', error: '' };
    try {
      const credentials = await readApp(configDir);
      if (job !== current || current.phase !== 'completing') return status();
      await configure({ ...credentials, enabled: true });
      if (current.phase === 'completing') current.phase = 'complete';
    } catch { current.phase = 'error'; current.error = '连接已创建的应用失败，请检查系统钥匙串和网关连接状态后重试'; }
    return status();
  }
  async function repairCallbacks() {
    if (job && ['starting', 'waiting', 'completing'].includes(job.phase)) return status();
    const cli = findCLI();
    if (!cli) throw new Error('请先安装 Lark CLI');
    const current = job = { phase: 'starting', purpose: 'callbacks', url: '', qrImage: '', error: '', abort: new AbortController() };
    try {
      const credentials = await readApp(configDir);
      current.timer = setTimeout(() => { current.phase = 'error'; current.error = '授权二维码已过期，请重试'; clearQR(current); current.abort.abort(); }, timeoutMs); current.timer.unref();
      Promise.resolve().then(() => registerApp({
        appId: credentials.appId,
        domain: credentials.domain === 'lark' ? 'accounts.larksuite.com' : 'accounts.feishu.cn',
        addons: { scopes: { tenant: ['application:application:patch'] }, callbacks: { items: ['card.action.trigger'] } },
        signal: current.abort.signal,
        onQRCodeReady: info => {
          if (job !== current || current.abort.signal.aborted) return;
          current.url = info.url; current.phase = 'waiting';
          generateQRCode(cli, info.url, { ...process.env, LARKSUITE_CLI_CONFIG_DIR: configDir }, execute).then(image => {
            if (job === current && current.phase === 'waiting') current.qrImage = image;
          }).catch(() => { if (current.phase === 'waiting') current.error = '二维码生成失败，可打开下方链接继续授权'; });
        },
      })).then(async result => {
        if (job !== current || current.abort.signal.aborted) return;
        if (result.client_id !== credentials.appId) throw new Error('授权应用不匹配');
        current.phase = 'completing'; clearQR(current);
        const app = { ...credentials, appSecret: result.client_secret || credentials.appSecret };
        await patchCallbacks(app);
        await configure({ ...app, enabled: true, cardCallbacksReady: true });
        current.phase = 'complete';
      }).catch(() => {
        if (job === current && !current.abort.signal.aborted) { current.phase = 'error'; current.error = '卡片回调授权或配置失败，请重试'; clearQR(current); }
      }).finally(() => clearTimeout(current.timer));
    } catch { current.phase = 'error'; current.error = '无法读取现有机器人，请先完成扫码接入'; }
    return status();
  }
  return { status, start, recover, repairCallbacks, cancel, close: cancel };
}
module.exports = { findLarkCLI, readCreatedApp, createLarkSetup, generateQRCode };
