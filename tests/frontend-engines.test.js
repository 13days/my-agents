const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = html.slice(html.indexOf('<script>', html.indexOf('/feishu-ui.js')) + 8, html.lastIndexOf('</script>'));
// i18n lookup + engine registry + network errors, evaluated without the DOM.
const source = html.slice(html.indexOf('// ---------- i18n lookup ----------'), html.indexOf('// ---------- i18n 框架 ----------'));

const ENGINES = {
  default: 'claude',
  nodes: [],
  engines: [
    { id: 'claude', label: 'Claude Code', short: 'Claude', emblem: '✳', color: '#d97757', capabilities: { accounts: true, permissions: 'auto', images: true, resources: ['commands', 'skills', 'agents', 'plugins', 'workflows', 'config'], usage: { cost: true }, search: true, wrapped: true, capture: true } },
    { id: 'codex', label: 'Codex', short: 'Codex', emblem: '◎', color: '#10a37f', capabilities: { accounts: false, permissions: 'none', images: true, resources: ['skills', 'config'], usage: { cost: false }, search: false, wrapped: false, capture: true } },
    { id: 'gemini', label: 'Gemini CLI', capabilities: { resources: [] } },
  ],
};
function load({ lang = 'zh', engines = ENGINES, online = true } = {}) {
  const ctx = vm.createContext({
    lang, navigator: { onLine: online }, state: { resourceEngine: 'claude' }, SCOPED: ['commands', 'skills', 'agents', 'workflows', 'config'],
    esc: value => String(value).replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`), document: undefined,
  });
  vm.runInContext(source, ctx);
  if (engines) { ctx.data = engines; vm.runInContext('setEngines(data)', ctx); }
  return ctx;
}
const run = (ctx, code) => vm.runInContext(code, ctx);

test('the main script parses and no longer declares rt twice', () => {
  assert.doesNotThrow(() => new vm.Script(script));
  assert.equal((script.match(/(?:const|let|var) rt\b|function rt\(/g) || []).length, 1);
});

test('ui() follows the current language, then English, then Chinese', () => {
  assert.equal(run(load({ lang: 'ja' }), "ui('中', 'en', 'ja')"), 'ja');
  assert.equal(run(load({ lang: 'ja' }), "ui('中', 'en')"), 'en');
  assert.equal(run(load({ lang: 'en' }), "rt('中', 'en', 'ja')"), 'en');
  assert.equal(run(load({ lang: 'zh' }), "rt('中', 'en')"), '中');
  assert.equal(run(load({ lang: 'fr' }), "ui('中')"), '中');
});

test('the registry falls back to a single Claude engine when /api/engines is unavailable', () => {
  const ctx = load({ engines: null });
  assert.deepEqual(Array.from(run(ctx, 'engineIds()')), ['claude']);
  assert.equal(run(ctx, 'ENGINE_DEFAULT'), 'claude');
  assert.equal(run(ctx, "can('claude', 'usage.cost')"), true);
  run(ctx, "setEngines({ engines: [] })");
  assert.deepEqual(Array.from(run(ctx, 'engineIds()')), ['claude']);
});

test('can() reads nested capabilities, arrays and the "none" sentinel', () => {
  const ctx = load();
  assert.equal(run(ctx, "can('claude', 'accounts')"), true);
  assert.equal(run(ctx, "can('codex', 'accounts')"), false);
  assert.equal(run(ctx, "can('codex', 'permissions')"), false);
  assert.equal(run(ctx, "can('claude', 'permissions', 'auto')"), true);
  assert.equal(run(ctx, "can('codex', 'usage.cost')"), false);
  assert.equal(run(ctx, "can('codex', 'resources', 'skills')"), true);
  assert.equal(run(ctx, "can('codex', 'resources', 'agents')"), false);
  assert.equal(run(ctx, "can('gemini', 'resources')"), false);
  assert.equal(run(ctx, "can('missing', 'search')"), false);
  assert.deepEqual(Array.from(run(ctx, "enginesWith('search').map(e => e.id)")), ['claude']);
  assert.deepEqual(Array.from(run(ctx, "resourceEngines().map(e => e.id)")), ['claude', 'codex']);
});

test('engine metadata fills gaps and stays readable for unknown engines', () => {
  const ctx = load();
  assert.equal(run(ctx, "engineLabel('gemini', true)"), 'Gemini CLI');
  assert.equal(run(ctx, "engineMeta('gemini').emblem"), 'G');
  assert.equal(run(ctx, "engineLabel('retired')"), 'Retired');
  assert.equal(run(ctx, "engineMeta('retired').unknown"), true);
  assert.equal(run(ctx, "knownEngine('retired')"), 'claude');
  assert.equal(run(ctx, "knownEngine('codex')"), 'codex');
  assert.equal(run(ctx, "engineStyle('codex')"), '--engine-color:#10a37f');
  assert.equal(run(ctx, "engineStyle('gemini')"), '');
  assert.equal(run(ctx, "statsRoute('claude')"), 'stats');
  assert.equal(run(ctx, "statsRoute('codex')"), 'codex/stats');
  assert.equal(run(ctx, "firstResourceType('codex')"), 'skills');
});

test('the default engine comes from the server, else the flagged or first engine', () => {
  const ctx = load({ engines: { default: 'codex', engines: ENGINES.engines } });
  assert.equal(run(ctx, 'ENGINE_DEFAULT'), 'codex');
  run(ctx, "setEngines({ default: 'nope', engines: [{ id: 'a' }, { id: 'b', default: true }] })");
  assert.equal(run(ctx, 'ENGINE_DEFAULT'), 'b');
});

test('friendlyError explains network and server failures in the current language', () => {
  const zh = load();
  run(zh, "globalThis.e = friendlyError(new TypeError('Failed to fetch'))");
  assert.match(run(zh, 'e.message'), /无法连接面板服务/);
  assert.equal(run(zh, 'e.network && e.retryable'), true);
  assert.match(run(load({ online: false }), "friendlyError(new TypeError('Failed to fetch')).message"), /网络已断开/);
  assert.match(run(zh, "friendlyError(new Error('Bad Gateway'), 502).message"), /HTTP 502/);
  assert.equal(run(zh, "friendlyError(new Error('Bad Gateway'), 502).retryable"), true);
  assert.match(run(zh, "friendlyError(new Error('boom'), 500).message"), /服务器出错/);
  assert.equal(run(zh, "friendlyError(Object.assign(new Error('x'), { serverMessage: '此任务已结束' }), 404).message"), '此任务已结束');
  assert.equal(run(zh, "friendlyError(new Error('x'), 404).retryable"), false);
  assert.match(run(load({ lang: 'en' }), "friendlyError(new TypeError('Failed to fetch')).message"), /Cannot reach the panel service/);
  run(zh, "globalThis.abort = Object.assign(new Error('a'), { name: 'AbortError' })");
  assert.equal(run(zh, 'friendlyError(abort) === abort'), true);
});

test('responseError keeps the server message and status', async () => {
  const ctx = load();
  ctx.res = { status: 404, statusText: 'Not Found', json: async () => ({ error: '此任务已结束' }) };
  const error = await run(ctx, 'responseError(res)');
  assert.equal(error.status, 404);
  assert.equal(error.message, '此任务已结束');
});

test('the chat stream applies state events even when the chat is not on screen', () => {
  const body = script.slice(script.indexOf('async function streamChat('), script.indexOf('function updateChatContent('));
  const receive = body.slice(body.indexOf('const receive = raw =>'), body.indexOf('const resetRun ='));
  assert.doesNotMatch(receive.split('\n').slice(0, 3).join('\n'), /return;/, 'receive must not bail out before handling the event');
  assert.match(receive, /kind === 'end'\) \{ run\.ended = true/);
  assert.match(body, /Math\.min\(30000, 1000 \* 2 \*\* attempt\+\+\)/);
  assert.match(body, /lost\.status === 404/);
});
