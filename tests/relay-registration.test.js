const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createPeer } = require('../node/rpc');
const { pairTransports } = require('../node/transports');
const { serveRelay, createRelayClient } = require('../node/relay');

test('cluster account relay works independently of engine registration and registers once per peer', async t => {
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ path: req.url, account: req.headers['x-my-agents-account'], body: Buffer.concat(chunks).toString() }));
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const [a, b] = pairTransports(), owner = createPeer(a), client = createPeer(b);
  const target = `http://127.0.0.1:${upstream.address().port}`;
  let handlers = 0;
  const original = owner.handle.bind(owner); owner.handle = (...args) => { if (args[0] === 'relay.request') handlers++; return original(...args); };
  // No hello/engine registration: an existing SSH runtime must not be required.
  serveRelay({ peer: owner, target }); serveRelay({ peer: owner, target });
  assert.equal(handlers, 1);
  assert.throws(() => serveRelay({ peer: owner, target: 'http://127.0.0.1:1' }), /不能绑定多个/);
  const relay = createRelayClient(client), url = await relay.url();
  t.after(() => { a.close(); b.close(); upstream.closeAllConnections(); upstream.close(); });
  for (const id of ['trae', 'codex']) {
    const response = await fetch(url + '/v1/messages', { method: 'POST', headers: { 'x-my-agents-account': id }, body: 'query' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { path: '/v1/messages', account: id, body: 'query' });
  }
});
