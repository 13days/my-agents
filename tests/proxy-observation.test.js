'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCaptureStore } = require('../capture-store');
const { createProxyObservation, routeRecord, updateRoutes, sessionIdOf, streamOutcome } = require('../core/proxy-observation');
const SID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
function rec(overrides = {}) {
  return { id: 1, ts: new Date().toISOString(), path: '/v1/messages', purpose: 'model_request', sessionId: SID,
    requestOrder: 1, status: 200, upstreamId: 'ferry-id', upstreamName: 'Ferry', model: 'ferry-model',
    routing: { actualModel: 'ferry-model', requestedModel: 'claude-opus', attempt: 1 }, ...overrides };
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-observation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createCaptureStore(path.join(dir, 'captures.jsonl'));
  const observer = createProxyObservation({ lastCapture: id => store.latestProxyRoute(id) });
  return { store, observer };
}

test('status isolates sessions and only exposes safe route fields', t => {
  const { store, observer } = fixture(t);
  store.append(rec({ requestBody: JSON.stringify({ model: 'ferry-model', messages: [], token: 'private' }), responseBody: 'sensitive' }));
  const value = observer.status(SID);
  assert.equal(value.request.model, 'ferry-model');
  assert.equal(value.request.accountName, 'Ferry');
  assert.equal(value.request.state, 'success');
  assert.equal(observer.status(OTHER).request, null);
  assert.equal(observer.status('').request, null);
  assert.doesNotMatch(JSON.stringify(value), /sensitive|private|requestBody|responseBody|token/);
});
test('auxiliary requests never replace the main model request', t => {
  const { store, observer } = fixture(t);
  store.append(rec());
  for (const [id, suffix] of [[2, 'models'], [3, 'messages/count_tokens']]) store.append(rec({ id, requestOrder: id, path: '/v1/' + suffix, model: 'other' }));
  store.append(rec({ id: 4, requestOrder: 4, requestBody: JSON.stringify({ messages: [{ role: 'user', content: 'Generate a title for this chat' }] }) }));
  assert.equal(observer.status(SID).request.requestOrder, 1);
});
test('newer arrival wins when requests finish in reverse order and retries are ordered', t => {
  const { store, observer } = fixture(t);
  observer.begin(rec({ id: 2, requestOrder: 2, upstreamName: 'new', model: 'new' }));
  store.append(rec({ requestBody: '{}' }));
  assert.equal(observer.status(SID).request.state, 'pending');
  store.append(rec({ id: 2, requestOrder: 2, upstreamName: 'new', model: 'new', routing: { actualModel: 'new', attempt: 2 } }));
  store.append(rec({ id: 3, requestOrder: 2, upstreamName: 'old-retry', routing: { actualModel: 'old', attempt: 1 } }));
  assert.equal(observer.status(SID).request.accountName, 'new');
  assert.equal(observer.status(SID).request.state, 'success');
});
test('bridge child records join only the matching parent attempt and survive reload', t => {
  const { store, observer } = fixture(t);
  store.append(rec({ upstreamName: 'Codex bridge', observation: { sessionId: SID, requestOrder: 1, parentAttempt: 1, hop: 0, purpose: 'model_request' } }));
  store.append(rec({ id: 20, sessionId: 'bridge-internal', upstreamName: 'Codex system', upstreamId: 'account-system', routing: { actualModel: 'gpt-test', attempt: 2 }, observation: { sessionId: SID, requestOrder: 1, parentAttempt: 1, hop: 1, proxyName: 'Codex bridge', purpose: 'model_request' } }));
  let value = observer.status(SID).request;
  assert.equal(value.proxyName, 'Codex bridge'); assert.equal(value.accountName, 'Codex system'); assert.equal(value.model, 'gpt-test');
  store.load(); value = observer.status(SID).request;
  assert.equal(value.accountName, 'Codex system');
  store.append(rec({ id: 21, requestOrder: 2, upstreamName: 'Ferry' }));
  assert.equal(observer.status(SID).request.accountName, 'Ferry');
  store.clear(); assert.equal(store.latestProxyRoute(SID), null);
});
test('outer bridge failure stays a failure even if the inner request returned 200', t => {
  const { store, observer } = fixture(t);
  store.append(rec({ incomplete: true, observation: { sessionId: SID, requestOrder: 1, parentAttempt: 1, hop: 0, purpose: 'model_request' } }));
  store.append(rec({ id: 20, sessionId: 'bridge-x', observation: { sessionId: SID, requestOrder: 1, parentAttempt: 1, hop: 1, purpose: 'model_request' } }));
  assert.equal(observer.status(SID).request.state, 'error');
});
test('correlation keys expire and are not chosen from client data', () => {
  let now = 0; const observer = createProxyObservation({ now: () => now });
  const trace = { sessionId: SID, requestOrder: 12, parentAttempt: 2 };
  const key = observer.associate(trace);
  assert.equal(observer.resolve('forged-header'), null);
  assert.deepEqual(observer.resolve(key), trace);
  observer.resolve(key).sessionId = OTHER; assert.equal(observer.resolve(key).sessionId, SID);
  now = 31 * 60 * 1000; assert.equal(observer.resolve(key), null);
});
test('stream errors and incomplete streams are not success', () => {
  assert.equal(streamOutcome('data: {"type":"message_stop"}\n'), 'success');
  assert.equal(streamOutcome('data: {"type":"message_stop"}\ndata: {"type":"error"}\n'), 'error');
  assert.equal(streamOutcome('data: {"type":"response.failed"}\n'), 'error');
  assert.equal(streamOutcome('data: {"type":"message_start"}\n'), 'unknown');
  assert.equal(routeRecord(rec({ streamOutcome: 'unknown' })).state, 'unknown');
});
test('session IDs must be real UUIDs; client tags cannot select another record', () => {
  assert.equal(sessionIdOf('user_session_' + SID), SID);
  assert.equal(sessionIdOf('not-a-session'), '');
  const map = new Map(); updateRoutes(map, routeRecord(rec({ purpose: 'models' })));
  assert.equal(map.size, 0);
});
