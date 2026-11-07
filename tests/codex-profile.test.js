const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createCodexProfile } = require('../engines/codex/profile');
test('capture profile preserves user settings, registers both names, and removes only its managed block', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'my-agents-profile-'));
  try {
    const file = path.join(home, 'config.toml'), original = 'model = "my-model"\n[projects."/work"]\ntrust_level = "trusted"\n';
    fs.writeFileSync(file, original);
    const profile = createCodexProfile({ home, port: 4322 }); profile.install();
    const content = fs.readFileSync(file, 'utf8');
    assert.ok(content.startsWith(original)); assert.match(content, /\[profiles.my-agents\]/); assert.match(content, /\[profiles.claude-panel\]/);
    assert.equal(profile.status().installed, true); profile.install(); assert.equal(fs.readFileSync(file, 'utf8'), content);
    profile.install(true); assert.equal(fs.readFileSync(file, 'utf8'), original);
    fs.writeFileSync(file, '[profiles.my-agents]\nmodel_provider = "custom"\n');
    assert.throws(() => profile.install(), /已有同名/); assert.match(fs.readFileSync(file, 'utf8'), /custom/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('newer Codex uses a separate config layer without changing the base config or old profile', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'my-agents-layer-'));
  try {
    const base = path.join(home, 'config.toml'), old = path.join(home, 'claude-panel.config.toml');
    fs.writeFileSync(base, 'model = "existing-model"\n'); fs.writeFileSync(old, '# old capture profile\n');
    const profile = createCodexProfile({ home, port: 4322, format: () => 'layer' });
    profile.install(); assert.match(profile.status().path, /my-agents\.config\.toml$/); assert.equal(profile.status().installed, true);
    assert.match(fs.readFileSync(profile.status().path, 'utf8'), /model_provider = "panel"/);
    assert.equal(fs.readFileSync(base, 'utf8'), 'model = "existing-model"\n'); assert.equal(fs.readFileSync(old, 'utf8'), '# old capture profile\n');
    profile.install(true); assert.equal(profile.status().installed, false); assert.equal(fs.existsSync(old), true);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
