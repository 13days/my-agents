const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { run } = require('../node/cluster-cli');

test('cluster join reads a validated final member list from stdin and writes it atomically', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-cli-')), prior = process.env.MY_AGENTS_HOME;
  try {
    process.env.MY_AGENTS_HOME = dir;
    const config = { clusterId: 'cluster-test', nodeId: 'dev-a', token: 'a'.repeat(64), members: [{ id: 'mac', url: 'http://10.0.0.1:4321' }, { id: 'dev-a', url: 'http://10.0.0.2:4321' }, { id: 'dev-b', url: 'http://10.0.0.3:4321' }] };
    run(['join', '--stdin'], { input: JSON.stringify(config), out: { log() {} } });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'panel-cluster.json'))), config);
    assert.equal(fs.statSync(path.join(dir, 'panel-cluster.json')).mode & 0o777, 0o600);
    assert.equal(fs.readdirSync(dir).some(name => name.endsWith('.tmp')), false);
  } finally {
    if (prior === undefined) delete process.env.MY_AGENTS_HOME; else process.env.MY_AGENTS_HOME = prior;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cluster join rejects duplicate members, invalid URLs and accidental cluster replacement', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-cli-invalid-')), prior = process.env.MY_AGENTS_HOME;
  try {
    process.env.MY_AGENTS_HOME = dir;
    const base = { clusterId: 'one', nodeId: 'a', token: 'b'.repeat(64), members: [{ id: 'a', url: 'http://10.0.0.1:4321' }] };
    run(['join', '--stdin'], { input: JSON.stringify(base), out: { log() {} } });
    assert.throws(() => run(['join', '--stdin'], { input: JSON.stringify({ ...base, clusterId: 'two' }), out: { log() {} } }), /另一个集群/);
    assert.throws(() => run(['join', '--stdin', '--force'], { input: JSON.stringify({ ...base, members: [{ id: 'a', url: 'file:///tmp/x' }] }), out: { log() {} } }), /http 或 https/);
    assert.throws(() => run(['join', '--stdin', '--force'], { input: JSON.stringify({ ...base, members: [base.members[0], base.members[0]] }), out: { log() {} } }), /重复/);
  } finally {
    if (prior === undefined) delete process.env.MY_AGENTS_HOME; else process.env.MY_AGENTS_HOME = prior;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
