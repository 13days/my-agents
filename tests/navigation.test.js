const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const source = html.slice(html.indexOf('let routeView ='), html.indexOf('async function restoreRoute()'));
  const location = { pathname: '/stats', search: '' };
  const changes = [];
  const context = vm.createContext({ URLSearchParams, location, state: { type: 'stats', current: null, scope: '' },
    CAPS: { stats: {}, inspector: {}, commands: {}, sessions: {}, im: {} }, SCOPED: ['commands'], ui: (_zh, en) => en,
    IM_CHANNELS: [{ id: 'feishu' }, { id: 'wecom' }], imSelectedChannel: 'feishu',
    history: Object.fromEntries(['pushState', 'replaceState'].map(method => [method, (_state, _title, url) => {
      changes.push({ method, url });
      const parsed = new URL(url, 'http://localhost'); location.pathname = parsed.pathname; location.search = parsed.search;
    }])),
  });
  vm.runInContext(source, context);
  return { context, location, changes };
}

test('resource URLs round-trip nested names, Unicode, percent signs, and project scope', () => {
  const { context, location } = fixture();
  context.state = { type: 'commands', current: '插件/搜索 ?#%你好', scope: '/Users/name/项目 a' };
  const url = vm.runInContext('routePath()', context);
  const parsed = new URL(url, 'http://localhost');
  location.pathname = parsed.pathname; location.search = parsed.search;
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext('readRoute()', context))), {
    type: 'commands', key: context.state.current, scope: context.state.scope, view: '',
  });
});

test('session replay and details have distinct URLs; global pages exclude project scope', () => {
  const { context } = fixture();
  context.state = { type: 'sessions', current: 'session-1', scope: '/a/project' };
  assert.equal(vm.runInContext("routePath('sessions', state.current, 'replay')", context), '/sessions/session-1?view=replay');
  assert.equal(vm.runInContext("routePath('sessions', state.current, 'detail')", context), '/sessions/session-1?view=detail');
  assert.equal(vm.runInContext("routePath('stats', null)", context), '/stats');
});

test('restoring the same URL does not create duplicate history entries', () => {
  const { context, changes } = fixture();
  vm.runInContext('writeRoute()', context);
  assert.equal(changes.length, 0);
  context.state.type = 'inspector'; context.state.current = '42';
  vm.runInContext('writeRoute(); writeRoute()', context);
  assert.deepEqual(changes, [{ method: 'pushState', url: '/inspector/42' }]);
});

test('IM routes identify channels and keep existing Feishu bookmarks working', () => {
  const { context, location } = fixture();
  location.pathname = '/feishu';
  const legacy = JSON.parse(JSON.stringify(vm.runInContext('readRoute()', context)));
  assert.equal(legacy.type, 'im'); assert.equal(legacy.channel, 'feishu');
  context.state.type = 'im'; context.imSelectedChannel = 'wecom';
  assert.equal(vm.runInContext('routePath()', context), '/im?channel=wecom');
  location.pathname = '/im'; location.search = '?channel=wecom';
  assert.equal(vm.runInContext('readRoute().channel', context), 'wecom');
  location.search = '?channel=unknown';
  assert.throws(() => vm.runInContext('readRoute()', context), /Channel not found/);
});

test('unknown sections and malformed resource paths are rejected', () => {
  const { context, location } = fixture();
  for (const pathname of ['/constructor', '/unknown', '/commands/a/b', '/commands/%ZZ']) {
    location.pathname = pathname;
    assert.throws(() => vm.runInContext('readRoute()', context));
  }
  location.pathname = '/';
  assert.equal(vm.runInContext('readRoute()', context), null);
});
