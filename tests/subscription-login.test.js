const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createSubscriptionLogin } = require('../core/subscription-login');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signin-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const children = [], completed = [];
  const login = createSubscriptionLogin({ codexHome: path.join(dir, 'codex'), claudeDir: path.join(dir, 'claude'), onComplete: async (engine, profile) => completed.push([engine, profile]),
    spawnImpl: (cmd, args, opts) => { const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.input = ''; child.stdin = new PassThrough(); child.stdin.on('data', d => { child.input += d; }); child.kill = () => { child.killed = true; }; child.cmd = cmd; child.args = args; child.env = opts.env; children.push(child); return child; } });
  return { dir, login, children, completed };
}
const flush = () => new Promise(r => setImmediate(r));

test('Codex sign-in shows the device link and code, then joins the pool from an isolated profile', async t => {
  const f = fixture(t), job = f.login.start('codex'), child = f.children[0];
  assert.deepEqual(child.args.slice(-2), ['login', '--device-auth']);
  assert.ok(child.env.CODEX_HOME.includes(path.join('codex', 'my-agents-logins')) && fs.existsSync(child.env.CODEX_HOME));
  child.stdout.write('1. Open this link\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n2. Enter this one-time code\n   \x1b[94mAB12-CD34\x1b[0m\n'); await flush();
  assert.deepEqual([f.login.status(job.id).phase, f.login.status(job.id).url, f.login.status(job.id).userCode], ['waiting', 'https://auth.openai.com/codex/device', 'AB12-CD34']);
  assert.equal(f.login.start('codex').id, job.id, 'one running login per engine');
  child.emit('close', 0); await flush(); await flush();
  assert.equal(f.login.status(job.id).phase, 'complete');
  assert.deepEqual(f.completed, [['codex', child.env.CODEX_HOME]]);
});

test('Claude sign-in takes the pasted code; a rejected code or cancel cleans up the profile', async t => {
  const f = fixture(t), job = f.login.start('claude'), child = f.children[0];
  child.stdout.write('visit: \x1b]8;;https://claude.com/cai/oauth/authorize?code=true&x=1\x07https://claude.com/cai/oauth/authorize?code=true&x=1\x1b]8;;\x07\nPaste code here if prompted > '); await flush();
  const status = f.login.status(job.id);
  assert.equal(status.url, 'https://claude.com/cai/oauth/authorize?code=true&x=1'); assert.equal(status.needsCode, true);
  assert.throws(() => f.login.submitCode(job.id, 'a\nb'), /授权码/);
  f.login.submitCode(job.id, 'the-code#state'); assert.equal(child.input, 'the-code#state\n');
  child.stdout.write("Login failed: That code wasn't accepted.\n"); child.emit('close', 1); await flush();
  assert.equal(f.login.status(job.id).phase, 'error'); assert.match(f.login.status(job.id).error, /wasn't accepted/);
  assert.equal(fs.existsSync(child.env.CLAUDE_CONFIG_DIR), false, 'failed profile removed');
  const second = f.login.start('claude'); f.login.cancel(second.id);
  assert.equal(f.children[1].killed, true); assert.equal(f.login.status(second.id).phase, 'cancelled');
  assert.equal(fs.existsSync(f.children[1].env.CLAUDE_CONFIG_DIR), false);
  assert.equal(f.completed.length, 0);
});
