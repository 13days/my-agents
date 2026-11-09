const test = require('node:test'), assert = require('node:assert/strict');
const { normalizeCodexModels, createModelCatalog } = require('../core/model-catalog');

test('Codex defaults follow the account catalog rather than a stale CLI default', () => {
  const result = normalizeCodexModels({ models: [{ slug: 'supported-second', priority: 5 }, { slug: 'account-recommended', priority: 1 }, { slug: 'reserved-hidden', priority: 0, visibility: 'hide' }, { slug: 'unavailable', priority: 0, supported_in_api: false }] });
  assert.equal(result.defaultModel, 'account-recommended');
  assert.deepEqual(result.models.map(row => row.id), ['account-recommended', 'supported-second']);
  assert.ok(!result.models.some(row => row.id === 'gpt-5.5'));
});

test('model caches are account-specific, coalesce requests and retry failed reads', async () => {
  let calls = 0;
  const cache = createModelCatalog({ load: async id => { calls++; if (id === 'bad') throw new Error('offline'); return { models: [{ slug: id + '-model' }] }; } });
  const [a, b] = await Promise.all([cache.get('first'), cache.get('first')]); assert.equal(calls, 1); assert.equal(a.defaultModel, b.defaultModel);
  assert.equal((await cache.get('second')).defaultModel, 'second-model'); assert.equal(calls, 2);
  await cache.get('first', true); assert.equal(calls, 3);
  await assert.rejects(cache.get('bad'), /offline/); await assert.rejects(cache.get('bad'), /offline/); assert.equal(calls, 5);
});
