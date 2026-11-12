const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const exec = promisify(execFile);
const checkoutQueues = new Map(), estimates = new Map();
const WORKTREE_TIMEOUT_MS = 10 * 60 * 1000;
const git = async (cwd, args, timeout = 120000, signal) => (await exec('git', ['-C', cwd, ...args], { timeout, ...(signal ? { signal } : {}), maxBuffer: 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();

function worktreeFailure(error) {
  const lines = String(error.stderr || error.message || '').split(/[\r\n]+/).map(line => line.trim()).filter(Boolean);
  const useful = lines.filter(line => !/^(Updating files:|Checking out files:|Preparing worktree)/.test(line));
  const detail = useful.slice(-5).join('；').slice(-1800);
  let reason = 'Git 检出未完成';
  if (error.name === 'AbortError') reason = '已取消创建工作区';
  else if (error.code === 'ENOSPC' || /no space left on device|ENOSPC/i.test(lines.join(' '))) reason = '磁盘空间不足';
  else if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') reason = 'Git 输出超过大小限制';
  else if (error.killed || error.code === 'ETIMEDOUT') reason = 'Git 检出超时（最多等待 10 分钟）';
  else if (error.signal) reason = 'Git 进程被终止（' + error.signal + '）';
  return new Error('创建独立工作区失败：' + reason + (detail ? '。' + detail : '') + '。原项目文件未改动，请排除原因后重新提交。', { cause: error });
}

// A workspace owns its branch and files. Existing files and branches are never
// reset, merged or deleted here. A failed CLI launch leaves the worktree intact.
async function createWorktree(cwd, { baseDir = path.join(require('./data-dir').resolveDataDir({ claudeDir: process.env.CLAUDE_DIR }).dir, 'workspaces'), signal } = {}) {
  let root;
  try { root = await git(cwd, ['rev-parse', '--show-toplevel']); }
  catch (error) {
    if (/not a git repository/i.test(error.stderr || '')) return null;
    throw new Error('无法检查 Git 工作目录：' + (error.stderr || error.message));
  }
  const common = await fs.promises.realpath(path.resolve(root, await git(root, ['rev-parse', '--git-common-dir'])));
  const base = await git(root, ['rev-parse', '--verify', 'HEAD']);
  const repo = path.basename(root).replace(/[^\p{L}\p{N}._-]/gu, '-').slice(0, 60) || 'project';
  const hash = crypto.createHash('sha256').update(common).digest('hex').slice(0, 10);
  const name = crypto.randomUUID(), branch = `my-agents/task-${name}`;
  const parent = path.join(baseDir, `${repo}-${hash}`), target = path.join(parent, name);
  await fs.promises.mkdir(parent, { recursive: true });
  // Git scans the common worktree registry while adding a new entry. Concurrent
  // additions can expose another entry before its commondir file is written.
  const previous = checkoutQueues.get(common) || Promise.resolve();
  const checkout = previous.catch(() => {}).then(async () => {
    if (signal?.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' });
    let estimate = estimates.get(base);
    if (estimate === undefined) {
      try { const sizes = await git(root, ['ls-tree', '-r', '--format=%(objectsize)', base]); estimate = sizes.split('\n').reduce((sum, value) => sum + (Number(value) || 0), 0); estimates.set(base, estimate); if (estimates.size > 100) estimates.delete(estimates.keys().next().value); }
      catch { estimate = null; }
    }
    if (typeof fs.promises.statfs === 'function') {
      const space = await fs.promises.statfs(parent), available = space.bavail * space.bsize;
      if (available < (estimate || 0) + 100 * 1024 * 1024) throw Object.assign(new Error(`可用空间约 ${Math.floor(available / 1024 / 1024)} MiB，检出文件估计 ${Math.ceil((estimate || 0) / 1024 / 1024)} MiB，另需保留至少 100 MiB；请释放空间或选择项目原目录`), { code: 'ENOSPC' });
    }
    await git(root, ['worktree', 'add', '--quiet', '-b', branch, target, base], WORKTREE_TIMEOUT_MS, signal);
  });
  checkoutQueues.set(common, checkout);
  const cleanup = () => { if (checkoutQueues.get(common) === checkout) checkoutQueues.delete(common); };
  checkout.then(cleanup, cleanup);
  let cancel;
  try {
    if (!signal) await checkout;
    else await Promise.race([checkout, new Promise((_, reject) => {
      cancel = () => reject(Object.assign(new Error('已取消'), { name: 'AbortError' }));
      if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
    })]);
  } catch (error) { throw worktreeFailure(error); }
  finally { if (cancel) signal.removeEventListener('abort', cancel); }
  const relative = path.relative(root, cwd);
  const dir = path.join(target, relative);
  // The chosen subdirectory can contain only untracked files and be absent in HEAD.
  if (relative && !fs.existsSync(dir)) await fs.promises.mkdir(dir, { recursive: true });
  return { cwd: dir, path: target, repository: root, branch, base };
}
module.exports = { createWorktree, WORKTREE_TIMEOUT_MS, worktreeFailure };
