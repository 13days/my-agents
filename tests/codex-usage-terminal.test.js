const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { summarizeUsage } = require('../core/codex-usage');
const { createCodexTerminal, BEGIN } = require('../core/codex-terminal');
const { createAccountPool } = require('../core/account-pool');
const { createRouter } = require('../proxy-router');

const tmp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-agents-codex-term-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

test('usage summary distinguishes healthy, exhausted and revoked subscriptions', () => {
  const healthy = summarizeUsage({ status: 200, body: { account_id: 'ws', plan_type: 'business', rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 12.5, reset_at: 2000 } }, credits: { has_credits: false } } }, 1);
  assert.deepEqual({ used: healthy.usedPercent, reset: healthy.resetAt, limit: healthy.limitReached, ws: healthy.workspace }, { used: 12.5, reset: 2000000, limit: false, ws: 'ws' });
  assert.equal(summarizeUsage({ status: 200, body: { rate_limit: { limit_reached: true, primary_window: { used_percent: 100 } } } }).limitReached, true);
  const revoked = summarizeUsage({ status: 401, body: { error: { code: 'token_revoked' } } });
  assert.equal(revoked.revoked, true); assert.equal(revoked.code, 'token_revoked');
  assert.equal(summarizeUsage({ status: 500, body: null }).error, true);
});

test('quota checks cool down exhausted and revoked accounts so failover skips them, and recover when healthy', async t => {
  const dir = tmp(t); let clock = 1_000_000;
  const jwt = 'h.' + Buffer.from(JSON.stringify({ exp: 9_999_999_999 })).toString('base64url') + '.s';
  const replies = {};
  const pool = createAccountPool({ dir, secret: 'secret', identity: () => ({ id: 'n1', label: 'n1' }), accounts: createRouter({ dir, port: 54321 }), peers: () => [],
    codex: { read: () => null, catalog: () => ({ modes: [] }) }, now: () => clock,
    usage: async headers => replies[headers['chatgpt-account-id']] });
  pool.importCodex({ tokens: { account_id: 'a', access_token: jwt + 'a', refresh_token: 'ra' } }, 'A');
  pool.importCodex({ tokens: { account_id: 'b', access_token: jwt + 'b', refresh_token: 'rb' } }, 'B');
  const [a, b] = pool.codexStatus().accounts.sort((x, y) => x.name.localeCompare(y.name)).map(row => row.id);
  pool.setRouting({ mode: 'failover', selected: a });
  replies.a = { status: 200, body: { rate_limit: { limit_reached: true, primary_window: { used_percent: 100, reset_at: 5000 } } } };
  replies.b = { status: 200, body: { rate_limit: { limit_reached: false, primary_window: { used_percent: 3 } } } };
  await pool.refreshCodexUsage();
  assert.equal(pool.codexRoute('chatgpt', 's1').accountId, b, 'exhausted preferred account is skipped');
  assert.equal(pool.codexStatus().accounts.find(row => row.id === a).cooldownUntil, 5_000_000, 'cools down until the provider reset');
  replies.b = { status: 401, body: { error: { code: 'token_revoked' } } };
  assert.equal((await pool.checkCodexUsage(b)).revoked, true);
  assert.equal(pool.codexRoute('chatgpt', 's2'), null, 'revoked account is not offered either');
  replies.a = { status: 200, body: { rate_limit: { limit_reached: false, primary_window: { used_percent: 0 } } } };
  clock += 6 * 60 * 1000; await pool.refreshCodexUsage();
  assert.equal(pool.codexRoute('chatgpt', 's3').accountId, a, 'reset account is usable again');
  assert.equal(pool.codexStatus().accounts.find(row => row.id === a).usage.usedPercent, 0);
});

test('terminal config block is inserted at the top, kept current, and removed exactly', t => {
  const home = tmp(t), file = path.join(home, 'config.toml');
  const original = 'model = "gpt"\n\n[projects."/x"]\ntrust_level = "trusted"\n';
  fs.writeFileSync(file, original);
  let port = 4322;
  const terminal = createCodexTerminal({ home: () => home, token: () => 'tok', base: () => `http://127.0.0.1:${port}/backend-api/codex` });
  assert.equal(terminal.status().enabled, false);
  terminal.enable();
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.startsWith(BEGIN));
  assert.ok(text.indexOf('model_provider = "panel"') < text.indexOf('[projects'), 'provider keys stay top-level');
  assert.match(text, /experimental_bearer_token = "tok"/);
  assert.match(text, /requires_openai_auth = false/);
  terminal.enable(); assert.equal(fs.readFileSync(file, 'utf8').split(BEGIN).length, 2, 'idempotent');
  port = 5000; terminal.sync(); assert.match(fs.readFileSync(file, 'utf8'), /127\.0\.0\.1:5000/);
  terminal.disable();
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal((fs.statSync(file).mode & 0o777), 0o600);
});

test('terminal config refuses to clobber a user-defined provider', t => {
  const home = tmp(t), file = path.join(home, 'config.toml');
  const terminal = createCodexTerminal({ home: () => home, token: () => 'tok', base: () => 'http://127.0.0.1:1/backend-api/codex' });
  fs.writeFileSync(file, 'model_provider = "azure"\n');
  assert.throws(() => terminal.enable(), /model_provider/);
  fs.writeFileSync(file, 'model = "x"\n[model_providers.panel]\nname = "mine"\n');
  assert.throws(() => terminal.enable(), /model_providers\.panel/);
  fs.writeFileSync(file, 'model = "x"\n[model_providers.other]\nname = "ok"\n[profiles.p]\nmodel_provider = "other"\n');
  assert.equal(terminal.enable().enabled, true, 'providers and profile-scoped keys elsewhere are fine');
});

test('routed default model maps a pinned Claude id the gateway does not serve to its family alias', () => {
  const { routedDefaultModel } = require('../model-defaults');
  const env = { ANTHROPIC_DEFAULT_OPUS_MODEL: 'auto/claude-opus-5-5', ANTHROPIC_DEFAULT_SONNET_MODEL: 'auto/claude-sonnet-5-5' };
  assert.equal(routedDefaultModel('claude-opus-4-6', env), 'opus');
  assert.equal(routedDefaultModel('claude-opus-4-8[1m]', env), 'opus[1m]');
  assert.equal(routedDefaultModel('claude-sonnet-4-5', env), 'sonnet');
  assert.equal(routedDefaultModel('auto/claude-opus-5-5', env), 'auto/claude-opus-5-5', 'already the gateway id');
  assert.equal(routedDefaultModel('opus', env), 'opus');
  assert.equal(routedDefaultModel('gpt-6.1-sol', env), 'gpt-6.1-sol');
  assert.equal(routedDefaultModel('claude-opus-4-6', {}), 'claude-opus-4-6', 'no discovery: leave the configured id');
  assert.equal(routedDefaultModel('', env), '');
});
