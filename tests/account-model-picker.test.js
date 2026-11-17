const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const pickerSource = html.slice(html.indexOf('function chatModelOptions('), html.indexOf('async function loadChatModels('));
const envSource = html.slice(html.indexOf('    function readEnv('), html.indexOf("    $('#route-env').addEventListener('input'"));
const submitSource = html.slice(html.indexOf("    $('#route-form').onsubmit = async e => {"), html.indexOf("    $('#account-usage-refresh').onclick"));
const plain = value => JSON.parse(JSON.stringify(value));
const account = (id = 'saved', modelMap = { '*': 'fixed-old', sonnet: 'family-model', 'claude-exact': 'exact-model' }) => ({ id, name: 'Gateway', enabled: true, modelMap });

// Minimal static DOM: execute the production picker without starting a server or probing credentials.
function staticDOM() {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) {
      const listeners = new Map();
      let markup = '', value = '';
      nodes.set(id, {
        disabled: false, textContent: '', hidden: false, open: false,
        get value() { return value; }, set value(next) { value = next; },
        get innerHTML() { return markup; },
        set innerHTML(next) {
          markup = next;
          if (id === '#route-default-model') {
            const options = Array.from(next.matchAll(/<option value="([^"]*)"([^>]*)>/g));
            const selected = options.find(option => /\bselected\b/.test(option[2])) || options[0];
            value = (selected?.[1] || '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
          }
        },
        addEventListener(type, fn) { listeners.set(type, fn); },
        dispatch(type) { return listeners.get(type)?.(); },
      });
    }
    return nodes.get(id);
  };
  const dialog = { isConnected: true, open: true, querySelector: node };
  return { node, dialog };
}
function fixture() {
  const { node, dialog } = staticDOM(), calls = [], pending = [];
  node('#route-models').value = '{}';
  const ctx = vm.createContext({
    rt: text => text,
    URL,
    esc: value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    enhancePanelSelect: select => { select.enhanced = true; },
    api: (method, endpoint, body) => {
      calls.push({ method, endpoint, body });
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
    $: node,
    dialog,
    clearTimeout() {},
  });
  vm.runInContext(pickerSource + '\nconst accountModelPicker = installAccountModelPicker(dialog);', ctx);
  const picker = vm.runInContext('accountModelPicker', ctx);
  return {
    ctx, node, dialog, picker, calls, pending,
    select: node('#route-default-model'), mapping: node('#route-models'), hint: node('#route-model-hint'), refresh: node('#route-model-refresh'),
    open(savedAccount) {
      node('#route-models').value = JSON.stringify(savedAccount?.modelMap || {});
      return picker.reset(savedAccount);
    },
    resolve(data, index = pending.length - 1) { pending[index].resolve(data); },
    reject(index = pending.length - 1) { pending[index].reject(new Error('fixture failure')); },
  };
}
async function loadedFixture() {
  const f = fixture(), loading = f.open(account());
  f.resolve({ available: true, accountName: 'Saved gateway', forcedModel: 'fixed-old', models: [{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }] });
  await loading;
  return f;
}
function installForm(f, savedAccount) {
  Object.assign(f.ctx, {
    busy: false, parsedEnv: undefined, parsedEnvText: undefined, parseTimer: undefined,
    editing: savedAccount?.id || '', editingAccount: savedAccount,
    routeData: { accounts: savedAccount ? [savedAccount] : [], selected: savedAccount?.id || '' },
    crypto: { randomUUID: () => 'new-id' },
    save: async value => f.calls.push({ method: 'SAVE', body: plain(value) }),
    closeForm: () => { f.closed = true; }, draw() {}, toast() {},
  });
  f.node('#route-name').value = 'Gateway';
  f.node('#route-url').value = savedAccount?.url || 'https://gateway.example.test';
  f.node('#route-token').value = '';
  f.node('#route-auth').value = 'bearer';
  f.node('#route-env').value = '';
  f.node('#route-manual').open = true;
  vm.runInContext(envSource + '\n' + submitSource, f.ctx);
  return () => f.node('#route-form').onsubmit({ preventDefault() {} });
}

test('options reuse the chat picker, escape labels, deduplicate IDs, and keep an unknown fixed model', () => {
  const f = fixture();
  const options = vm.runInContext(`chatModelOptions([{id:'a',name:'First'},{id:'a',name:'A <b>'}], 'old"<&', 'Not fixed')`, f.ctx);
  assert.equal((options.match(/value="a"/g) || []).length, 1);
  assert.match(options, /A &lt;b&gt;/);
  assert.match(options, /value="old&quot;&lt;&amp;"[^>]* selected/);
  assert.match(options, /<option value="">Not fixed<\/option>/);
});

test('selecting or clearing a default changes only the wildcard rule', () => {
  const f = fixture(), original = account().modelMap;
  f.ctx.raw = JSON.stringify(original);
  const fixed = vm.runInContext("accountDefaultModelMap(raw, 'alpha')", f.ctx);
  const cleared = vm.runInContext("accountDefaultModelMap(raw, '')", f.ctx);
  assert.deepEqual(plain(fixed), { ...original, '*': 'alpha' });
  const { '*': removed, ...specific } = original;
  assert.equal(removed, 'fixed-old');
  assert.deepEqual(plain(cleared), specific);
  assert.deepEqual(JSON.parse(f.ctx.raw), original);
});

test('invalid mapping shapes cannot be overwritten by a dropdown change or saved', () => {
  const f = fixture();
  for (const raw of ['{', 'null', '[]', '"model"', '{"*":false}', '{"sonnet":" "}', '{"":"a"}']) {
    f.ctx.raw = raw;
    assert.throws(() => vm.runInContext("accountDefaultModelMap(raw, 'alpha')", f.ctx), /JSON/);
  }
});

test('new and disabled accounts show save/enable guidance without a request', async () => {
  for (const savedAccount of [undefined, { ...account(), enabled: false }]) {
    const f = fixture();
    await f.open(savedAccount);
    assert.equal(f.calls.length, 0);
    assert.equal(f.refresh.disabled, true);
    assert.match(f.hint.textContent, /先保存并启用/);
    await f.refresh.onclick();
    assert.equal(f.calls.length, 0);
    if (savedAccount) assert.equal(f.select.value, 'fixed-old');
  }
});

test('saved accounts load their own encoded ID with refresh=1, never form credentials', async () => {
  const f = fixture(), loading = f.open(account('cluster:owner:id /?'));
  f.node('#route-token').value = 'unsaved-fixture-token';
  f.node('#route-url').value = 'https://unsaved.example.test';
  assert.deepEqual(f.calls, [{ method: 'GET', endpoint: 'proxy/models?accountId=cluster%3Aowner%3Aid%20%2F%3F&refresh=1', body: undefined }]);
  assert.equal(f.select.enhanced, true);
  assert.equal(f.refresh.disabled, true);
  f.resolve({ available: true, accountName: 'My gateway', models: [{ id: 'alpha', name: 'Friendly Alpha' }] });
  await loading;
  assert.equal(f.select.value, 'fixed-old');
  assert.match(f.select.innerHTML, /Friendly Alpha/);
  assert.match(f.hint.textContent, /My gateway · 1/);
  assert.equal(f.refresh.disabled, false);
});

test('picker changes preserve specific rules and advanced JSON changes sync the selection', async () => {
  const f = await loadedFixture();
  f.select.value = 'alpha'; f.select.onchange();
  assert.deepEqual(JSON.parse(f.mapping.value), { ...account().modelMap, '*': 'alpha' });
  f.mapping.value = JSON.stringify({ '*': 'manual-model', opus: 'opus-rule', 'exact-id': 'exact-rule' });
  f.mapping.dispatch('input');
  assert.equal(f.select.value, 'manual-model');
  assert.match(f.select.innerHTML, /value="manual-model"[^>]* selected/);
  f.select.value = ''; f.select.onchange();
  assert.deepEqual(JSON.parse(f.mapping.value), { opus: 'opus-rule', 'exact-id': 'exact-rule' });
  assert.equal(f.select.value, '');
});

test('invalid advanced JSON disables selection without discarding mapping or catalogue', async () => {
  const f = await loadedFixture();
  f.mapping.value = '{"sonnet":'; f.mapping.dispatch('input');
  assert.equal(f.select.disabled, true);
  assert.match(f.hint.textContent, /JSON/);
  f.select.value = 'alpha'; f.select.onchange();
  assert.equal(f.mapping.value, '{"sonnet":');
  f.mapping.value = '{"sonnet":"kept"}'; f.mapping.dispatch('input');
  assert.equal(f.select.disabled, false);
  assert.equal(f.select.value, '');
  assert.match(f.select.innerHTML, /value="alpha"/);
});

for (const failure of ['available=false', 'legacy empty', 'transport error']) {
  test(`${failure} preserves previous catalogue, fixed model, and mapping`, async () => {
    const f = await loadedFixture(), before = f.select.innerHTML, raw = f.mapping.value;
    const loading = f.refresh.onclick();
    if (failure === 'transport error') f.reject();
    else f.resolve({ models: [], ...(failure === 'available=false' ? { available: false } : {}) });
    await loading;
    assert.equal(f.select.innerHTML, before);
    assert.equal(f.mapping.value, raw);
    assert.equal(f.select.value, 'fixed-old');
    assert.match(f.hint.textContent, /已保留当前模型/);
    assert.equal(f.refresh.disabled, false);
  });
}

test('an explicitly successful empty catalogue differs from failure but keeps a non-catalogue fixed model', async () => {
  const f = await loadedFixture(), loading = f.refresh.onclick();
  f.resolve({ available: true, models: [] }); await loading;
  assert.match(f.hint.textContent, /目录为空/);
  assert.equal(f.select.value, 'fixed-old');
  assert.doesNotMatch(f.select.innerHTML, /value="alpha"/);
  assert.equal(JSON.parse(f.mapping.value)['*'], 'fixed-old');
});

test('catalogue refresh does not overwrite an edited wildcard with the persisted forcedModel', async () => {
  const f = fixture(), loading = f.open(account());
  f.mapping.value = '{"*":"just-edited","sonnet":"specific"}'; f.mapping.dispatch('input');
  f.resolve({ available: true, forcedModel: 'fixed-old', models: [{ id: 'alpha' }] }); await loading;
  assert.equal(f.select.value, 'just-edited');
  assert.deepEqual(JSON.parse(f.mapping.value), { '*': 'just-edited', sonnet: 'specific' });
});

test('a previous account response or error cannot contaminate a newer editor', async () => {
  for (const rejectOld of [false, true]) {
    const f = fixture(), old = f.open(account('a'));
    const newer = f.open(account('b', { '*': 'b-fixed' }));
    f.resolve({ available: true, accountName: 'B', models: [{ id: 'b-model' }] }, 1); await newer;
    const markup = f.select.innerHTML, hint = f.hint.textContent;
    if (rejectOld) f.reject(0); else f.resolve({ available: true, models: [{ id: 'a-model' }] }, 0);
    await old;
    assert.equal(f.select.innerHTML, markup);
    assert.equal(f.hint.textContent, hint);
    assert.equal(f.select.value, 'b-fixed');
    assert.equal(f.refresh.disabled, false);
  }
});

test('generation guards reopening the same account even when the old response arrives first', async () => {
  const f = fixture(), old = f.open(account());
  f.picker.invalidate(); f.dialog.open = false;
  f.dialog.open = true;
  const newer = f.open(account('saved', { '*': 'new-fixed' }));
  f.resolve({ available: true, models: [{ id: 'stale-model' }] }, 0); await old;
  assert.doesNotMatch(f.select.innerHTML, /stale-model/);
  assert.equal(f.select.value, 'new-fixed');
  assert.equal(f.refresh.disabled, true);
  f.resolve({ available: true, models: [{ id: 'new-model' }] }, 1); await newer;
  assert.match(f.select.innerHTML, /new-model/);
});

test('a newer refresh wins over an earlier request for the same editor', async () => {
  const f = fixture(), old = f.open(account()), newer = f.refresh.onclick();
  f.resolve({ available: true, models: [{ id: 'newest' }] }, 1); await newer;
  f.resolve({ available: true, models: [{ id: 'stale' }] }, 0); await old;
  assert.match(f.select.innerHTML, /newest/);
  assert.doesNotMatch(f.select.innerHTML, /value="stale"/);
});

test('closed or detached dialogs ignore responses and failures', async () => {
  for (const property of ['open', 'isConnected']) {
    for (const reject of [false, true]) {
      const f = fixture(), loading = f.open(account());
      f.dialog[property] = false;
      const markup = f.select.innerHTML, hint = f.hint.textContent;
      if (reject) f.reject(); else f.resolve({ available: true, models: [{ id: 'late' }] });
      await loading;
      assert.equal(f.select.innerHTML, markup);
      assert.equal(f.hint.textContent, hint);
    }
  }
});

test('pasted env synchronizes the picker, and submitting it again preserves later dropdown and JSON edits', async () => {
  const f = fixture(), submit = installForm(f);
  f.node('#route-token').value = 'fixture-token';
  f.node('#route-env').value = JSON.stringify({ env: {
    ANTHROPIC_BASE_URL: 'https://gateway.example.test', ANTHROPIC_AUTH_TOKEN: 'fixture-token',
    ANTHROPIC_MODEL: 'env-default', ANTHROPIC_DEFAULT_SONNET_MODEL: 'env-sonnet',
  } });
  vm.runInContext('readEnv()', f.ctx);
  assert.equal(f.select.value, 'env-default');
  f.mapping.value = '{"*":"chosen-after-paste","sonnet":"env-sonnet","exact-id":"keep"}';
  f.mapping.dispatch('input');
  await submit();
  assert.equal(f.closed, true);
  const saved = f.calls.find(call => call.method === 'SAVE').body.accounts[0];
  assert.deepEqual(saved.modelMap, { '*': 'chosen-after-paste', sonnet: 'env-sonnet', 'exact-id': 'keep' });
  assert.equal(saved.env.ANTHROPIC_MODEL, 'env-default', 'the server reconciles env from the preserved modelMap');
});

test('clearing the wildcard after an env paste is not undone at save', async () => {
  const f = fixture(), submit = installForm(f);
  f.node('#route-env').value = JSON.stringify({ ANTHROPIC_AUTH_TOKEN: 'fixture-token', ANTHROPIC_MODEL: 'env-fixed', ANTHROPIC_DEFAULT_OPUS_MODEL: 'keep-opus' });
  vm.runInContext('readEnv()', f.ctx);
  f.select.value = ''; f.select.onchange(); await submit();
  assert.deepEqual(f.calls.find(call => call.method === 'SAVE').body.accounts[0].modelMap, { opus: 'keep-opus' });
});

test('local account save sends the selected wildcard and preserves exact/family rules', async () => {
  const f = await loadedFixture(), submit = installForm(f, account());
  f.select.value = 'beta'; f.select.onchange(); await submit();
  const saved = f.calls.find(call => call.method === 'SAVE').body.accounts[0];
  assert.deepEqual(saved.modelMap, { ...account().modelMap, '*': 'beta' });
  assert.equal(f.closed, true);
});

test('shared proxy edits use the owner-routed account endpoint and omit blank credentials', async () => {
  const f = await loadedFixture(), shared = { ...account('cluster:owner:proxy'), shared: true, sourceNode: 'owner', url: 'http://relay.example.test', authType: 'bearer' };
  const submit = installForm(f, shared);
  f.select.value = 'alpha'; f.select.onchange();
  const saving = submit();
  const update = f.calls.at(-1);
  assert.equal(update.method, 'PUT');
  assert.equal(update.endpoint, 'accounts/claude/cluster%3Aowner%3Aproxy');
  assert.equal('token' in update.body, false);
  for (const key of ['name', 'url', 'authType', 'enabled']) assert.equal(key in update.body, false, `${key} relay metadata must not overwrite the owner`);
  assert.deepEqual(plain(update.body.modelMap), { ...shared.modelMap, '*': 'alpha' });
  f.resolve({});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.at(-1).endpoint, 'proxy');
  f.resolve({ accounts: [shared] }); await saving;
  assert.equal(f.closed, true);
  assert.equal(f.calls.some(call => call.method === 'SAVE'), false);
});

test('invalid advanced JSON is reported and never reaches save', async () => {
  const f = fixture(), submit = installForm(f, account());
  f.mapping.value = 'null'; await submit();
  assert.equal(f.calls.length, 0);
  assert.match(f.node('#route-form-error').textContent, /JSON/);
  assert.equal(f.node('#route-submit').disabled, false);
});

test('account cards offer a visible model action for every Claude proxy and reuse the original dialog', () => {
  const pool = html.slice(html.indexOf('async function renderEngineAccountPool('), html.indexOf('function poolSubscriptionCommand('));
  assert.match(pool, /!subscription\?`\$\{engine==='claude'\?`<button class="btn" data-engine-action="models">/);
  assert.match(pool, /if\(action==='models'\)return accountPoolEditors\.claude\(account,\{models:true\}\)/);
  assert.match(pool, /if\(action==='edit'\)\{if\(engine==='claude'\)return accountPoolEditors\.claude\(account\)/);
  assert.doesNotMatch(pickerSource, /Ferry|claude-gpt-6-1-sol-max/);
  assert.match(html, /accountPoolEditors\.claude = \(account, options\) => openForm\(account, options\?\.models\)/);
  assert.match(html, /id="route-default-model" aria-describedby="route-model-hint route-model-rules"/);
  assert.match(html, /更具体的精确 \/ 家族规则优先/);
  assert.match(html, /固定规则会覆盖客户端 \/model；只修改「\*」/);
  assert.match(html, /if \(dialog\.open\) return; accountModelPicker\.invalidate\(\)/);
});
