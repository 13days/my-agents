const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '..', 'index.html'), 'utf8');
function context(values = {}) {
  const data = new Map(Object.entries(values));
  return vm.createContext({ localStorage: { getItem: key => data.has(key) ? data.get(key) : null } });
}
test('model preferences stay with their engine, including explicit defaults and legacy Claude settings', () => {
  const source = html.match(/function modelPreference\(engine\) \{[^\n]+/)[0];
  const ctx = context({ 'panel-chat-model': 'legacy-sonnet' });
  vm.runInContext(source, ctx);
  assert.equal(vm.runInContext("modelPreference('claude')", ctx), 'legacy-sonnet');
  assert.equal(vm.runInContext("modelPreference('codex')", ctx), '');
  const separate = context({ 'panel-chat-model': 'legacy-sonnet', 'panel-chat-model-claude': '', 'panel-chat-model-codex': 'gpt-example' });
  vm.runInContext(source, separate);
  assert.equal(vm.runInContext("modelPreference('claude')", separate), '');
  assert.equal(vm.runInContext("modelPreference('codex')", separate), 'gpt-example');
});
test('session engine filtering includes legacy Claude sessions and rejects stale filter values', () => {
  const source = html.slice(html.indexOf('let sessionEngine ='), html.indexOf('function renderSessionEngines()'));
  for (const [saved, expected] of [['all', [true, true]], ['claude', [true, false]], ['codex', [false, true]], ['removed-engine', [true, true]]]) {
    const ctx = context({ 'panel-session-engine': saved }); vm.runInContext(source, ctx);
    assert.deepEqual(Array.from(vm.runInContext("[matchesSessionEngine({}), matchesSessionEngine({engine: 'codex'})]", ctx)), expected);
  }
});

test('capture filters combine engine, call type and session while supporting legacy Claude records', () => {
  const source = html.slice(html.indexOf('function captureEngine(item)'), html.indexOf('function capturePurposeLabel'));
  const ctx = vm.createContext({ state: { inspectorEngine: 'codex', inspectorPurpose: 'model_request', inspectorSession: 'session-a' } });
  vm.runInContext(source, ctx);
  const match = item => { ctx.item = item; return vm.runInContext('matchesCaptureFilters(item)', ctx); };
  assert.equal(match({ engine: 'codex', purpose: 'model_request', sessionId: 'session-a' }), true);
  assert.equal(match({ engine: 'claude', purpose: 'model_request', sessionId: 'session-a' }), false);
  assert.equal(match({ engine: 'codex', purpose: 'models', sessionId: 'session-a' }), false);
  assert.equal(match({ engine: 'codex', purpose: 'model_request', sessionId: 'session-b' }), false);
  ctx.state = { inspectorEngine: 'claude' };
  assert.equal(match({}), true);
  ctx.state = {};
  assert.equal(match({ engine: 'codex' }), true);
});

test('capture category counts ignore the selected category and follow engine, session and keyword filters', () => {
  const source = html.slice(html.indexOf('function captureEngine(item)'), html.indexOf('function capturePurposeLabel'));
  const ctx = vm.createContext({ state: { inspectorEngine: 'codex', inspectorPurpose: 'models', inspectorSession: 'a', keyword: 'match' }, items: [
    { engine: 'codex', purpose: 'model_request', sessionId: 'a', name: 'Match model' },
    { engine: 'codex', purpose: 'title', sessionId: 'a', description: 'match' },
    { engine: 'codex', purpose: 'models', sessionId: 'b', name: 'match' },
    { purpose: 'models', sessionId: 'a', name: 'match' },
    { engine: 'codex', purpose: 'model_request', sessionId: 'a', name: 'unrelated' },
  ] });
  vm.runInContext(source, ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext('captureFilterCounts(items)', ctx))), { '': 2, model_request: 1, title: 1 });
  ctx.state = {};
  assert.equal(vm.runInContext('captureFilterCounts(items)[""]', ctx), 5);
});

test('legacy capture lists identify Codex by proxy provenance, without inferring from GPT model names', () => {
  const source = html.slice(html.indexOf('function captureEngine(item)'), html.indexOf('function matchesCaptureContext'));
  const ctx = vm.createContext({}); vm.runInContext(source, ctx);
  const engine = item => { ctx.item = item; return vm.runInContext('captureEngine(item)', ctx); };
  assert.equal(engine({ description: 'Codex 订阅 · 10:00:00 · 1 msgs' }), 'codex');
  assert.equal(engine({ description: 'Codex API Key · 10:00:00' }), 'codex');
  assert.equal(engine({ upstreamId: 'codex-chatgpt' }), 'codex');
  assert.equal(engine({ name: 'gpt-example · 200', description: 'Claude gateway' }), 'claude');
  assert.equal(engine({ engine: 'claude', description: 'Codex 订阅 · 10:00:00' }), 'claude');
});
