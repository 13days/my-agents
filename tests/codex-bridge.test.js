const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createCodexBridge, toResponses } = require('../core/codex-bridge');
const body = extra => ({ model: 'gpt-test', max_tokens: 100, messages: [{ role: 'user', content: '你好' }], ...extra });
async function fixture(t, events) {
  const calls = [];
  const upstream = http.createServer(async (req, res) => {
    const data = []; for await (const chunk of req) data.push(chunk);
    calls.push({ headers: req.headers, url: req.url, body: JSON.parse(Buffer.concat(data)) });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (typeof events === 'function') return events(res);
    // Byte-by-byte chunks deliberately split UTF-8 characters and SSE lines.
    for (const event of events) { const bytes = Buffer.from('data: ' + JSON.stringify(event) + '\r\n\r\n'); for (const byte of bytes) res.write(Buffer.from([byte])); }
    res.end();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const bridge = createCodexBridge({ token: 'public-key', relayToken: 'private-relay', port: upstream.address().port, models: async () => ({ models: [{ id: 'gpt-test' }] }) });
  const server = http.createServer(bridge.handle); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); upstream.closeAllConnections(); upstream.close(); });
  const url = `http://127.0.0.1:${server.address().port}/codex-subscription`;
  const post = (data, headers = {}) => fetch(url + '/v1/messages', { method: 'POST', headers: { authorization: 'Bearer public-key', ...headers }, body: JSON.stringify(data) });
  return { post, calls, bridge, url };
}
const completed = { type: 'response.completed', response: { output: [], usage: { input_tokens: 12, output_tokens: 3, input_tokens_details: { cached_tokens: 4 } } } };
test('bridge converts ordered messages, images and tool round trips without changing tool IDs', () => {
  const r = toResponses(body({ system: [{ type: 'text', text: 'system' }], tools: [{ name: 'Read', input_schema: { type: 'object' } }], messages: [
    { role: 'user', content: [{ type: 'text', text: 'read' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'private' }, { type: 'tool_use', id: 'call-1', name: 'Read', input: { file_path: 'a' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'contents' }, { type: 'text', text: 'continue' }] },
  ] }));
  assert.deepEqual(r.input.map(i => i.type || i.role), ['user', 'function_call', 'function_call_output', 'user']);
  assert.equal(r.input[1].call_id, r.input[2].call_id); assert.equal(r.store, false); assert.equal(r.tools[0].strict, false);
  assert.equal(r.instructions, 'system'); assert.ok(!JSON.stringify(r).includes('private'));
});
test('bridge rejects unsupported content and malformed histories before spending quota', () => {
  for (const extra of [{ model: 'claude-opus' }, { tools: [{ type: 'web_search_20250305', name: 'web_search' }] }, { stop_sequences: ['end'] }, { messages: [{ role: 'user', content: [{ type: 'document' }] }] }, { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'missing', content: 'x' }] }] }]) assert.throws(() => toResponses(body(extra)));
});
test('bridge handles non-stream output, split UTF-8 and usage; only private relay credential reaches transport', async t => {
  const f = await fixture(t, [{ type: 'response.output_text.delta', delta: '你好😀' }, completed]);
  const r = await f.post(body()); assert.equal(r.status, 200); const value = await r.json();
  assert.equal(value.content[0].text, '你好😀'); assert.equal(value.usage.input_tokens, 8); assert.equal(value.usage.cache_read_input_tokens, 4);
  assert.equal(f.calls[0].headers.authorization, 'Bearer private-relay'); assert.equal(f.calls[0].url, '/codex-subscription/internal/responses');
  assert.equal(f.calls[0].body.stream, true); assert.ok(f.bridge.sessions().every(s => !s.running));
});
test('stream emits a valid tool block and terminal tool_use; ignores duplicate final tool', async t => {
  const item = { type: 'function_call', call_id: 'call-a', name: 'Read', arguments: '{"file_path":"a"}' };
  const f = await fixture(t, [{ type: 'response.output_item.done', item }, { ...completed, response: { output: [item] } }]);
  const r = await f.post(body({ stream: true, tools: [{ name: 'Read', input_schema: { type: 'object' } }] }));
  const value = await r.text(); assert.equal((value.match(/event: content_block_start/g) || []).length, 1);
  assert.ok(value.includes('"stop_reason":"tool_use"')); assert.ok(value.indexOf('content_block_stop') < value.indexOf('event: message_stop'));
});
test('failed, incomplete and truncated responses never produce successful message_stop', async t => {
  for (const end of [null, { type: 'response.failed', response: { error: { message: 'failed' } } }, { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }]) {
    const f = await fixture(t, [{ type: 'response.output_text.delta', delta: 'partial' }, ...(end ? [end] : [])]);
    const r = await f.post(body({ stream: true })); const value = await r.text(); assert.ok(value.includes('event: error')); assert.ok(!value.includes('event: message_stop'));
  }
});
test('invalid tool JSON and undeclared tool calls fail closed', async t => {
  for (const item of [{ type: 'function_call', call_id: 'a', name: 'Read', arguments: '{' }, { type: 'function_call', call_id: 'b', name: 'Unknown', arguments: '{}' }]) {
    const f = await fixture(t, [{ type: 'response.output_item.done', item }, completed]);
    const r = await f.post(body({ tools: [{ name: 'Read', input_schema: { type: 'object' } }] })); assert.equal(r.status, 502);
    assert.ok(!(await r.text()).includes('message_stop'));
  }
});
test('proxy requires a dedicated credential even on loopback, denies browser origins, exposes only model metadata', async t => {
  const f = await fixture(t, [completed]);
  assert.equal((await f.post(body(), { authorization: 'Bearer bad' })).status, 401);
  assert.equal((await f.post(body(), { origin: 'http://evil.test' })).status, 403);
  const r = await fetch(f.url + '/v1/models', { headers: { 'x-api-key': 'public-key' } }); assert.equal(r.status, 200); assert.equal((await r.json()).data[0].id, 'gpt-test');
  assert.equal(f.calls.length, 0);
});
test('client cancellation closes upstream and clears running status', async t => {
  let closed = false;
  const f = await fixture(t, res => { res.on('close', () => { closed = true; }); res.write('data: {"type":"response.output_text.delta","delta":"hi"}\n\n'); });
  const controller = new AbortController(); const r = await fetch(f.url + '/v1/messages', { method: 'POST', headers: { authorization: 'Bearer public-key' }, body: JSON.stringify(body({ stream: true })), signal: controller.signal });
  await r.body.getReader().read(); controller.abort();
  for (let i = 0; i < 100 && !closed; i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(closed); assert.ok(f.bridge.sessions().every(s => !s.running));
});
