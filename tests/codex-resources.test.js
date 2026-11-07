const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCodexResources } = require('../codex-resources');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-resource-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, '.codex'), agentsHome = path.join(dir, '.agents'), project = path.join(dir, 'project');
  for (const folder of [home, agentsHome, project]) fs.mkdirSync(folder);
  const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  const resources = createCodexResources({ home, agentsHome, summarize: content => content.split('\n')[0], parseFrontmatter: () => ({ meta: {} }) });
  const call = (type, method = 'GET', key = '', input, scope) => resources.execute({ type, method, key, input, scope }).data;
  return { dir, home, agentsHome, project, put, call };
}
test('Codex skills list and address shared, legacy and project files independently', t => {
  const f = fixture(t);
  f.put(path.join(f.agentsHome, 'skills/demo/SKILL.md'), 'Shared skill');
  f.put(path.join(f.home, 'skills/demo/SKILL.md'), 'Codex skill');
  f.put(path.join(f.project, '.agents/skills/local/SKILL.md'), 'Project skill');
  assert.deepEqual(f.call('skills').items.map(i => i.key).sort(), ['agents:demo', 'codex:demo']);
  assert.equal(f.call('skills', 'GET', 'agents:demo').content, 'Shared skill');
  assert.equal(f.call('skills', 'GET', 'codex:demo').content, 'Codex skill');
  assert.deepEqual(f.call('skills', 'GET', '', undefined, f.project).items.map(i => i.key), ['agents:local']);
  f.call('skills', 'PUT', 'agents:demo', { content: 'Updated shared' });
  assert.equal(f.call('skills', 'GET', 'codex:demo').content, 'Codex skill');
  const created = f.call('skills', 'POST', '', { name: 'new-skill', content: '# New' });
  assert.equal(created.key, 'agents:new-skill');
  assert.equal(f.call('skills', 'GET', created.key).content, '# New');
  f.call('skills', 'DELETE', created.key);
  assert.equal(fs.existsSync(path.dirname(created.path)), false);
});
test('installed links, linked files and system skills remain readable and reject mutations', t => {
  const f = fixture(t), external = path.join(f.dir, 'installed');
  f.put(path.join(external, 'SKILL.md'), 'Installed');
  fs.mkdirSync(path.join(f.home, 'skills'), { recursive: true });
  fs.symlinkSync(external, path.join(f.home, 'skills/linked'));
  fs.mkdirSync(path.join(f.home, 'skills/file-link'));
  fs.symlinkSync(path.join(external, 'SKILL.md'), path.join(f.home, 'skills/file-link/SKILL.md'));
  f.put(path.join(f.home, 'skills/.system/builtin/SKILL.md'), 'Built in');
  for (const item of f.call('skills').items) {
    assert.equal(item.origin, 'installed');
    assert.ok(f.call('skills', 'GET', item.key).content);
    assert.throws(() => f.call('skills', 'PUT', item.key, { content: 'Changed' }), { status: 403 });
    assert.throws(() => f.call('skills', 'DELETE', item.key), { status: 403 });
  }
  assert.equal(fs.readFileSync(path.join(external, 'SKILL.md'), 'utf8'), 'Installed');
});
test('Codex resource names and unsupported capabilities cannot access Claude or arbitrary files', t => {
  const f = fixture(t);
  for (const name of ['../escape', '..', 'a/b', '/absolute', 'a..b']) assert.throws(() => f.call('skills', 'POST', '', { name, content: '' }), { status: 400 });
  assert.throws(() => f.call('commands'), { status: 400 });
  assert.throws(() => f.call('config', 'GET', '../auth.json'), { status: 404 });
  assert.throws(() => f.call('skills', 'GET', 'agents:../outside'), { status: 404 });
  fs.mkdirSync(path.join(f.agentsHome, 'skills/existing'), { recursive: true });
  assert.throws(() => f.call('skills', 'POST', '', { name: 'existing', content: '' }), { status: 409 });
  fs.rmSync(path.join(f.agentsHome, 'skills'), { recursive: true });
  fs.symlinkSync(f.project, path.join(f.agentsHome, 'skills'));
  assert.throws(() => f.call('skills', 'POST', '', { name: 'blocked', content: '' }), { status: 403 });
  assert.equal(fs.existsSync(path.join(f.project, 'blocked')), false);
});
test('Codex configuration edits use explicit allowlists and isolate global and project scope', t => {
  const f = fixture(t);
  assert.equal(f.call('config', 'GET', 'settings').lang, 'toml');
  assert.equal(f.call('config', 'GET', 'settings').content, '');
  f.call('config', 'PUT', 'settings', { content: 'model = "global-example"' });
  f.call('config', 'PUT', 'settings', { content: 'model = "project-example"' }, f.project);
  assert.equal(fs.readFileSync(path.join(f.home, 'config.toml'), 'utf8'), 'model = "global-example"');
  assert.equal(fs.readFileSync(path.join(f.project, '.codex/config.toml'), 'utf8'), 'model = "project-example"');
  f.call('config', 'PUT', 'instructions', { content: '# Project instructions' }, f.project);
  assert.equal(fs.readFileSync(path.join(f.project, 'AGENTS.md'), 'utf8'), '# Project instructions');
  assert.throws(() => f.call('config', 'DELETE', 'settings'), { status: 405 });
  fs.rmSync(path.join(f.home, 'config.toml'));
  fs.symlinkSync(path.join(f.project, '.codex/config.toml'), path.join(f.home, 'config.toml'));
  assert.equal(f.call('config', 'GET', 'settings').origin, 'installed');
  assert.throws(() => f.call('config', 'PUT', 'settings', { content: 'blocked' }), { status: 403 });
});
