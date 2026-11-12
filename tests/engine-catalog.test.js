const test = require('node:test');
const assert = require('node:assert/strict');
const { engineCatalog } = require('../channels/engine-catalog');
const cards = require('../feishu-cards');

const THREE = [
  { id: 'claude', label: 'Claude Code', short: 'Claude', aliases: ['cc'], capabilities: { accounts: true } },
  { id: 'codex', label: 'Codex', short: 'Codex', capabilities: { accounts: false, permissions: 'none' } },
  { id: 'gemini', label: 'Gemini CLI', short: 'Gemini', aliases: ['gm'], capabilities: {} },
];

test('catalog resolves names and aliases, falls back safely and lists switch targets', () => {
  const engines = engineCatalog(THREE);
  assert.equal(engines.find('CC'), 'claude');
  assert.equal(engines.find('gemini cli'), 'gemini');
  assert.equal(engines.find('nope'), '');
  assert.equal(engines.fallback('nope', 'codex'), 'codex');
  assert.equal(engines.can('codex', 'permissions'), false);
  assert.equal(engines.can('claude', 'accounts'), true);
  assert.equal(engines.switchHint('claude'), '/codex 或 /gemini 或 /claude');
  assert.deepEqual(engineCatalog().ids(), ['claude', 'codex'], 'built-in fallback without a registry');
});

test('cards offer every registered engine without special cases', () => {
  const engines = engineCatalog(THREE), context = { owner: 'ou', key: 'k', engines };
  const picker = JSON.stringify(cards.enginePicker({ ...context, engine: 'gemini', cwd: '/tmp' }));
  assert.match(picker, /当前聊天程序：Gemini CLI/);
  for (const label of ['切到 Claude Code 会话', '切到 Codex 会话']) assert.ok(picker.includes(label), label);
  const projects = JSON.stringify(cards.projectList({ ...context, rows: ['/tmp/a'], total: 1, page: 0, engine: 'gemini' }));
  assert.match(projects, /新建 Gemini CLI 会话/);
  assert.match(projects, /改用 Claude Code/);
  assert.match(projects, /改用 Codex/);
  assert.match(projects, /"engine":"gemini"/);
});
