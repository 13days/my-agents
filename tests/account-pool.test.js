const test = require('node:test');
const assert = require('node:assert/strict');
const { createAccountPool } = require('../core/account-pool');

test('cluster pools union owner accounts, expose no provider credentials and remove offline sources', async () => {
  let shared = [], online = true, relayCount = 0;
  const ownerCatalog = { claude: { token: 'proxy-only-token', accounts: [{ id: 'api', name: 'Work', modelMap: { sonnet: 'custom' } }, { id: 'trae', name: 'TRAE', modelMap: {} }] }, codex: { token: 'codex-relay-only', modes: ['chatgpt'] } };
  const peer = { call: async method => { assert.equal(method, 'accounts.catalog'); return ownerCatalog; } };
  const pool = createAccountPool({
    accounts: { sharedCatalog: () => ({ accounts: [], token: 'own-proxy' }), setShared: value => { shared = value; } },
    codex: { catalog: () => ({ token: 'own-relay', modes: ['api-key'] }) }, identity: () => ({ id: 'self', label: 'Self' }),
    peers: () => online ? [{ id: 'owner', label: 'Owner', peer }] : [],
    relayClient: () => { relayCount++; return { url: async () => 'http://127.0.0.1:54321' }; },
  });
  await pool.refresh(); await pool.refresh();
  assert.equal(relayCount, 1);
  assert.deepEqual(shared.map(a => a.id), ['cluster:owner:api', 'cluster:owner:trae']);
  assert.equal(shared[1].url, 'http://127.0.0.1:54321');
  assert.equal(shared[1].token, 'proxy-only-token');
  assert.equal(pool.codexRoute('chatgpt', 'thread').id, 'owner');
  assert.equal(pool.codexRoute('api-key').id, 'self');
  assert.equal(pool.codexRoute('chatgpt', 'thread', ['owner']), null);
  assert.ok(!JSON.stringify(pool.status()).includes('token'));
  assert.equal(pool.catalog().claude.accounts.length, 0, 'never re-export imported accounts and create a loop');
  online = false; await pool.refresh();
  assert.deepEqual(shared, []); assert.equal(pool.codexRoute('chatgpt'), null);
});
