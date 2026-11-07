const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { stripGatewayContext } = require('../codex-sessions');

test('new shell setup replaces both legacy and duplicate blocks without touching user settings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-agents-shell-'));
  try {
    const rc = path.join(dir, '.zshrc');
    fs.writeFileSync(rc, 'export USER_PREFERENCE=yes\n# >>> claude-code-panel >>>\nold function\n# <<< claude-code-panel <<<\n# >>> my-agents >>>\nduplicate function\n# <<< my-agents <<<\n');
    const run = command => execFileSync(process.execPath, [path.join(__dirname, '../server.js'), command], { env: { ...process.env, MY_AGENTS_RC_FILE: rc, CCP_RC_FILE: path.join(dir, 'unused') }, stdio: 'pipe' });
    run('install-proxy'); const once = fs.readFileSync(rc, 'utf8'); run('install-proxy');
    assert.equal(fs.readFileSync(rc, 'utf8'), once); assert.equal(once.match(/# >>> my-agents >>>/g).length, 1);
    assert.ok(!once.includes('claude-code-panel')); assert.match(once, /export USER_PREFERENCE=yes/);
    assert.equal(fs.existsSync(path.join(dir, 'unused')), false);
    run('uninstall-proxy'); assert.match(fs.readFileSync(rc, 'utf8'), /USER_PREFERENCE/); assert.ok(!fs.readFileSync(rc, 'utf8').includes('>>>'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('old and new Feishu context markers stay hidden in resumed Codex transcripts', () => {
  for (const brand of ['Claude Panel', 'my-agents']) assert.equal(stripGatewayContext(`[${brand} 飞书发送上下文，本轮有效]\nprivate routing metadata\n[/${brand} 飞书发送上下文]\nHello`), 'Hello');
});

test('shell wrapper discovers npm global Claude even when an older binary appears earlier in PATH', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-agents-cli-shell-'));
  try {
    const old = path.join(dir, 'old'), npm = path.join(dir, 'npm'), prefix = path.join(dir, 'custom npm'), rc = path.join(dir, '.zshrc');
    for (const folder of [old, npm, path.join(prefix, 'bin')]) fs.mkdirSync(folder, { recursive: true });
    const script = (file, text) => { fs.writeFileSync(file, '#!/bin/sh\n' + text + '\n', { mode: 0o755 }); };
    script(path.join(old, 'claude'), 'echo old-version'); script(path.join(prefix, 'bin', 'claude'), 'echo npm-version');
    script(path.join(npm, 'npm'), 'printf "%s\\n" "$TEST_NPM_PREFIX"');
    const env = { ...process.env, MY_AGENTS_RC_FILE: rc, PATH: [old, npm, process.env.PATH].join(path.delimiter), TEST_NPM_PREFIX: prefix, ANTHROPIC_BASE_URL: 'http://example.invalid' }; delete env.CLAUDE_CLI;
    execFileSync(process.execPath, [path.join(__dirname, '../server.js'), 'install-proxy'], { env, stdio: 'pipe' });
    const result = execFileSync('/bin/sh', ['-c', '. "$1"; claude --version', 'test', rc], { env, encoding: 'utf8' });
    assert.equal(result.trim(), 'npm-version');
    const override = execFileSync('/bin/sh', ['-c', '. "$1"; claude --version', 'test', rc], { env: { ...env, CLAUDE_CLI: path.join(old, 'claude') }, encoding: 'utf8' });
    assert.equal(override.trim(), 'old-version');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
