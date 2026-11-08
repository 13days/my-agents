const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const exec = promisify(execFile);
const git = async (cwd, args) => (await exec('git', ['-C', cwd, ...args], { timeout: 120000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();

// A workspace owns its branch and files. Existing files and branches are never
// reset, merged or deleted here. A failed CLI launch leaves the worktree intact.
async function createWorktree(cwd, { baseDir = path.join(require('./data-dir').resolveDataDir({ claudeDir: process.env.CLAUDE_DIR }).dir, 'workspaces') } = {}) {
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
  try { await git(root, ['worktree', 'add', '-b', branch, target, base]); }
  catch (error) { throw new Error('创建独立工作区失败：' + (error.stderr || error.message)); }
  const relative = path.relative(root, cwd);
  const dir = path.join(target, relative);
  // The chosen subdirectory can contain only untracked files and be absent in HEAD.
  if (relative && !fs.existsSync(dir)) await fs.promises.mkdir(dir, { recursive: true });
  return { cwd: dir, path: target, repository: root, branch, base };
}
module.exports = { createWorktree };
