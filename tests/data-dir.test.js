const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { resolveDataDir, migrateDataDir } = require('../core/data-dir');
const { createUpstreams } = require('../core/upstreams');
const { createLocalHost } = require('../hosts/local');

test('data dir: env wins, ~/.my-agents once present, otherwise the legacy Claude dir', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-')), claudeDir = path.join(home, '.claude');
  assert.deepEqual(resolveDataDir({ env: {}, home, claudeDir }), { dir: claudeDir, legacy: true });
  fs.mkdirSync(path.join(home, '.my-agents'));
  assert.equal(resolveDataDir({ env: {}, home, claudeDir }).dir, path.join(home, '.my-agents'));
  assert.equal(resolveDataDir({ env: { MY_AGENTS_HOME: '/srv/agents' }, home, claudeDir }).dir, '/srv/agents');
});

test('migration copies only panel files, keeps originals and never overwrites', () => {
  const from = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-')), to = path.join(from, '..', path.basename(from) + '-new');
  fs.writeFileSync(path.join(from, 'panel-config.json'), '{"a":1}');
  fs.writeFileSync(path.join(from, 'panel-proxy.json'), '{"old":true}');
  fs.writeFileSync(path.join(from, 'settings.json'), '{}');
  fs.mkdirSync(path.join(from, 'lark-cli')); fs.writeFileSync(path.join(from, 'lark-cli', 'config.json'), '{}');
  fs.mkdirSync(to); fs.writeFileSync(path.join(to, 'panel-proxy.json'), '{"new":true}');
  const result = migrateDataDir({ from, to });
  assert.deepEqual(result.copied.sort(), ['lark-cli', 'panel-config.json']);
  assert.deepEqual(result.skipped, ['panel-proxy.json']);
  assert.equal(fs.readFileSync(path.join(to, 'panel-proxy.json'), 'utf8'), '{"new":true}');
  assert.ok(fs.existsSync(path.join(from, 'panel-config.json')), 'originals stay as backup');
  assert.ok(!fs.existsSync(path.join(to, 'settings.json')), "Claude's own files are not copied");
});

test('upstreams dispatch by path with a default and expose their parser', () => {
  const upstreams = createUpstreams(), hits = [];
  upstreams.add({ id: 'anthropic', engine: 'claude', handle: () => hits.push('anthropic') }, { isDefault: true });
  upstreams.add({ id: 'openai', engine: 'codex', match: url => url.startsWith('/backend-api/'), handle: () => hits.push('openai'), extract() {} });
  upstreams.handle({ url: '/v1/messages' }, {});
  upstreams.handle({ url: '/backend-api/codex/responses' }, {});
  assert.deepEqual(hits, ['anthropic', 'openai']);
  assert.equal(typeof upstreams.for('/backend-api/x').extract, 'function');
  assert.equal(upstreams.for('/v1/messages').extract, undefined);
  assert.deepEqual(upstreams.list().map(u => u.id), ['openai', 'anthropic']);
});

test('local host reads files for history lookups', async () => {
  const host = createLocalHost(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello'); fs.mkdirSync(path.join(dir, 'sub'));
  assert.equal(host.exists(path.join(dir, 'a.txt')), true);
  assert.equal(await host.readFile(path.join(dir, 'a.txt')), 'hello');
  assert.deepEqual((await host.readdir(dir)).sort((a, b) => a.name.localeCompare(b.name)), [{ name: 'a.txt', dir: false }, { name: 'sub', dir: true }]);
});
