const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSessionResolver } = require('../core/session-reference');
const id = '11111111-1111-4111-8111-111111111111';
function fixture(meta = {}) {
  const calls = [];
  const options = { metadata: () => meta, selfId: () => 'sg', nodes: () => [{ id: 'local', engines: ['claude', 'codex'] }, { id: 'mac', engines: ['claude', 'codex'] }], owns: async (node, engine) => { calls.push([node, engine]); return node === 'mac' && engine === 'claude'; }, history: async (_, machine) => ({ project: '/original/' + machine }) };
  return { calls, options, resolve: createSessionResolver(options) };
}
test('legacy IDs discover native ownership after a different machine becomes leader', async () => {
  const f = fixture({ node: 'local', project: '/stale/default' });
  const owner = await f.resolve(id);
  assert.equal(owner.machineId, 'mac'); assert.equal(owner.project, '/original/mac'); assert.equal(owner.engine, 'claude');
});
test('recorded session ownership survives changed defaults and offline owners', async () => {
  const f = fixture({ machineId: 'dev', engine: 'codex', project: '/dev/repo' });
  const owner = await f.resolve(id, { machineId: 'sg', cwd: '/sg/default' });
  assert.equal(owner.machineId, 'dev'); assert.equal(owner.project, '/dev/repo'); assert.equal(f.calls.length, 0);
});
test('self contained old card resolves after the card cache is evicted', async () => {
  const f = fixture();
  const owner = await f.resolve(id, { machineId: 'mac', engine: 'claude', cwd: '/mac/repo' });
  assert.equal(owner.node, 'mac'); assert.equal(owner.project, '/mac/repo'); assert.equal(f.calls.length, 0);
});
test('ambiguous and unavailable legacy owners never silently become a new local session', async () => {
  const f = fixture(); f.options.owns = async () => true;
  await assert.rejects(createSessionResolver(f.options)(id), /多个机器/);
  f.options.owns = async () => { throw new Error('offline'); };
  await assert.rejects(createSessionResolver(f.options)(id), /原执行机器/);
  f.options.metadata = () => ({ deleted: true });
  await assert.rejects(createSessionResolver(f.options)(id), /明确删除/);
});
test('an unknown draft with no native transcript remains a fresh session', async () => {
  const f = fixture(); f.options.owns = async () => false;
  assert.equal(await createSessionResolver(f.options)(id), null);
});

test('recovered ownership is persisted so a later offline owner still supports handoff', async () => {
  const f = fixture(); let saved;
  f.options.remember = async owner => { saved = owner; };
  const resolve = createSessionResolver(f.options);
  await resolve(id);
  assert.equal(saved.machineId, 'mac'); assert.equal(saved.project, '/original/mac');
  f.options.metadata = () => saved; f.options.owns = async () => { throw Error('offline'); };
  assert.equal((await createSessionResolver(f.options)(id)).machineId, 'mac');
});
