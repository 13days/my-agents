const test = require('node:test');
const assert = require('node:assert/strict');
const { npmGlobalPrefix, globalCliCandidates } = require('../cli-installations');
const { resolveClaude } = require('../claude-cli');
test('npm installation directories are discovered instead of assuming a home, Homebrew or system prefix', () => {
  const calls = [];
  const prefix = npmGlobalPrefix({ env: { PATH: '/custom/node/bin' }, execute: (cmd, args) => { calls.push([cmd, args]); return '/arbitrary/npm/prefix\n'; } });
  assert.equal(prefix, '/arbitrary/npm/prefix'); assert.deepEqual(calls, [['npm', ['prefix', '--global']]]);
  assert.deepEqual(globalCliCandidates(prefix, 'claude'), ['/arbitrary/npm/prefix/bin/claude']);
  assert.deepEqual(globalCliCandidates('D:\\Apps\\npm', 'claude', 'win32'), ['D:\\Apps\\npm\\claude.cmd', 'D:\\Apps\\npm\\claude.exe', 'D:\\Apps\\npm\\claude']);
  assert.equal(npmGlobalPrefix({ env: { npm_config_prefix: '/configured/npm' }, execute: () => { throw Error('must not run'); } }), '/configured/npm');
});
test('Claude prefers the detected npm global install even when a service PATH starts with an older install', () => {
  const info = resolveClaude({ env: { PATH: '/old/bin:/native/bin' }, globalPrefix: '/custom/npm', probe: file => ({ '/old/bin/claude': '2.1.31', '/native/bin/claude': '2.1.197', '/custom/npm/bin/claude': '2.1.283' })[file] || '' });
  assert.equal(info.path, '/custom/npm/bin/claude'); assert.equal(info.version, '2.1.283'); assert.equal(info.source, 'npm');
});
test('explicit overrides work and a missing npm installation falls back to runnable PATH candidates', () => {
  assert.equal(resolveClaude({ env: { CLAUDE_CLI: '/explicit/claude' }, probe: () => { throw Error('must not run'); } }).path, '/explicit/claude');
  const info = resolveClaude({ env: { PATH: '/old:/new' }, globalPrefix: '/missing', probe: file => { if (file === '/old/claude') return '2.1.31'; if (file === '/new/claude') return '2.1.283'; throw Error('not installed'); } });
  assert.equal(info.path, '/new/claude'); assert.equal(info.source, 'path');
  assert.equal(npmGlobalPrefix({ env: {}, execute: () => { throw Error('npm missing'); } }), '');
});

test('tool subprocesses inherit the selected Claude install without losing other environment values', () => {
  const { claudeEnvironment } = require('../claude-cli');
  const env = { PATH: '/old/bin:/custom/npm/bin:/usr/bin', EXTRA_SETTING: 'kept' };
  const next = claudeEnvironment(env, { path: '/custom/npm/bin/claude', version: '2.1.283' });
  assert.equal(next.PATH, '/custom/npm/bin:/old/bin:/usr/bin');
  assert.equal(next.CLAUDE_CLI, '/custom/npm/bin/claude'); assert.equal(next.MY_AGENTS_CLAUDE_VERSION, '2.1.283');
  assert.equal(next.EXTRA_SETTING, 'kept'); assert.equal(env.PATH, '/old/bin:/custom/npm/bin:/usr/bin');
  assert.deepEqual(claudeEnvironment(env, { path: 'claude' }), env);
});
