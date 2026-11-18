// Sign in to a Claude or Codex subscription from the panel, without a terminal.
// Each attempt runs the official CLI login in a fresh my-agents-logins/<id> profile directory,
// which the account pool already discovers, so a finished login joins the pool automatically and
// never replaces the machine's default login.
//   Codex:  device-code flow: the panel shows the link and the one-time code.
//   Claude: the panel shows the sign-in link; the user pastes back the code the page shows.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawn } = require('child_process');
const { PROFILE_DIRECTORY } = require('./login-profiles');

const clean = text => String(text).replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, ' ').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const firstUrl = text => (clean(text).match(/https:\/\/[^\s\x1b\x07]+/) || [])[0] || '';

function createSubscriptionLogin({ codexHome, claudeDir, codexCli = 'codex', claudeCli = 'claude', onComplete = async () => {}, spawnImpl = spawn, timeoutMs = 15 * 60 * 1000, now = Date.now }) {
  const jobs = new Map();
  const view = job => job && { id: job.id, engine: job.engine, phase: job.phase, url: job.url, userCode: job.userCode, needsCode: job.engine === 'claude' && job.phase === 'waiting', error: job.error, startedAt: job.startedAt };
  const finish = (job, phase, error = '') => {
    if (['complete', 'error', 'cancelled'].includes(job.phase)) return;
    job.phase = phase; job.error = error; clearTimeout(job.timer);
    if (phase !== 'complete') fs.rmSync(job.dir, { recursive: true, force: true });
  };
  function start(engine) {
    if (!['claude', 'codex'].includes(engine)) throw new Error('引擎无效');
    for (const job of jobs.values()) if (job.engine === engine && ['starting', 'waiting', 'verifying'].includes(job.phase)) return view(job);
    const id = crypto.randomUUID(), root = engine === 'codex' ? codexHome : claudeDir, dir = path.join(root, PROFILE_DIRECTORY, id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const job = { id, engine, dir, phase: 'starting', url: '', userCode: '', error: '', output: '', startedAt: now() };
    jobs.set(id, job);
    for (const [key, old] of jobs) if (now() - old.startedAt > 2 * timeoutMs) jobs.delete(key);
    const env = { ...process.env, BROWSER: 'true', NO_COLOR: '1' };
    const child = job.child = engine === 'codex'
      ? spawnImpl(codexCli, ['-c', 'cli_auth_credentials_store="file"', 'login', '--device-auth'], { env: { ...env, CODEX_HOME: dir }, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawnImpl(claudeCli, ['auth', 'login'], { env: { ...env, CLAUDE_CONFIG_DIR: dir }, stdio: ['pipe', 'pipe', 'pipe'] });
    const read = chunk => {
      job.output = (job.output + chunk).slice(-16000);
      if (!job.url) job.url = firstUrl(job.output);
      if (engine === 'codex' && !job.userCode) job.userCode = (clean(job.output).match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/) || [])[0] || '';
      if (job.phase === 'starting' && job.url && (engine === 'claude' || job.userCode)) job.phase = 'waiting';
    };
    child.stdout.on('data', read); child.stderr.on('data', read);
    child.stdin.on('error', () => {});
    child.on('error', () => finish(job, 'error', `未找到 ${engine === 'codex' ? 'Codex' : 'Claude Code'} CLI，请先在这台机器安装`));
    child.on('close', async code => {
      if (code !== 0 || job.phase === 'cancelled') {
        const reason = clean(job.output).split('\n').map(line => line.trim()).filter(line => /fail|error|denied|expired|wasn't accepted|失败/i.test(line)).pop();
        return finish(job, job.phase === 'cancelled' ? 'cancelled' : 'error', reason ? '登录未完成：' + reason.slice(0, 200) : '登录未完成，请重试');
      }
      job.phase = 'verifying';
      try { await onComplete(engine, dir); finish(job, 'complete'); }
      catch (error) { finish(job, 'error', '登录成功，但加入账号池失败：' + error.message); }
    });
    job.timer = setTimeout(() => { child.kill(); finish(job, 'error', '登录已超时，请重新开始'); }, timeoutMs); job.timer.unref?.();
    return view(job);
  }
  function submitCode(id, code) {
    const job = jobs.get(id);
    if (!job || job.engine !== 'claude' || job.phase !== 'waiting') throw new Error('没有等待授权码的登录，请重新开始');
    const value = String(code || '').trim();
    if (!value || value.length > 2000 || /[\r\n]/.test(value)) throw new Error('请粘贴网页上显示的完整授权码');
    job.phase = 'verifying'; job.child.stdin.write(value + '\n');
    return view(job);
  }
  function cancel(id) { const job = jobs.get(id); if (job) { finish(job, 'cancelled'); job.child?.kill(); } return view(job); }
  return { start, submitCode, cancel, status: id => view(jobs.get(id)), close: () => { for (const job of jobs.values()) cancel(job.id); } };
}
module.exports = { createSubscriptionLogin, firstUrl };
