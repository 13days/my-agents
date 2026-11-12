const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createWorktree, worktreeFailure } = require('../core/worktrees');
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-test-'));
  const root = path.join(dir, 'project with spaces'), baseDir = path.join(dir, 'workspaces');
  fs.mkdirSync(root); git(root, 'init'); git(root, 'config', 'user.email', 'test@example.invalid'); git(root, 'config', 'user.name', 'Test');
  fs.mkdirSync(path.join(root, 'src')); fs.writeFileSync(path.join(root, 'src/file'), 'committed');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'initial');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { root: fs.realpathSync(root), baseDir };
}
test('parallel tasks get separate branches/files and preserve uncommitted source changes', async t => {
  const { root, baseDir } = repo(t);
  fs.writeFileSync(path.join(root, 'src/file'), 'unfinished source');
  fs.writeFileSync(path.join(root, '.env'), 'private-local-data');
  const before = git(root, 'status', '--porcelain');
  const workspaces = await Promise.all(Array.from({ length: 3 }, () => createWorktree(path.join(root, 'src'), { baseDir })));
  assert.equal(new Set(workspaces.map(w => w.path)).size, 3);
  assert.equal(new Set(workspaces.map(w => w.branch)).size, 3);
  for (const w of workspaces) {
    assert.equal(git(w.cwd, 'branch', '--show-current'), w.branch);
    assert.equal(fs.readFileSync(path.join(w.cwd, 'file'), 'utf8'), 'committed');
    assert.equal(fs.existsSync(path.join(w.path, '.env')), false);
    fs.writeFileSync(path.join(w.cwd, 'file'), w.branch);
  }
  assert.equal(fs.readFileSync(path.join(root, 'src/file'), 'utf8'), 'unfinished source');
  assert.equal(git(root, 'status', '--porcelain'), before);
  for (const w of workspaces) assert.equal(fs.readFileSync(path.join(w.cwd, 'file'), 'utf8'), w.branch);
  assert.equal(git(root, 'worktree', 'list', '--porcelain').match(/^worktree /gm).length, 4);
});
test('plain directories stay usable and empty Git repositories report a useful failure', async t => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-workspace-'));
  t.after(() => fs.rmSync(plain, { recursive: true, force: true }));
  assert.equal(await createWorktree(plain), null);
  git(plain, 'init');
  await assert.rejects(createWorktree(plain), /HEAD/);
});

test('worktree failures put the actual disk or timeout cause ahead of long checkout progress', () => {
  const progress = Array.from({ length: 100 }, (_, i) => `Updating files: ${i}% (${i}/11847)`).join('\r');
  const disk = worktreeFailure({ stderr: 'Preparing worktree (new branch)\n' + progress + '\nfatal: cannot create directory: No space left on device' });
  assert.match(disk.message.slice(0, 150), /磁盘空间不足.*No space left on device/);
  assert.doesNotMatch(disk.message, /Updating files|Preparing worktree/);
  assert.match(worktreeFailure({ killed: true, stderr: progress }).message, /Git 检出超时/);
  assert.match(worktreeFailure({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true, stderr: progress }).message, /输出超过大小限制/);
});
