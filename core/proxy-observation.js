'use strict';
const crypto = require('crypto');
const TRACE_HEADER = 'x-my-agents-route-observation';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function sessionIdOf(value) {
  if (typeof value !== 'string') return '';
  const found = value.match(/session(?:_id)?["':\s_]*([0-9a-f-]{36})/i);
  const id = UUID.test(value) ? value : found?.[1] || '';
  return UUID.test(id) ? id.toLowerCase() : '';
}
function rank(row) {
  return [Number(row?.requestOrder ?? row?.id) || Date.parse(row?.startedAt) || 0, Number(row?.parentAttempt ?? row?.attempt) || 1, Number(row?.childAttempt) || 0];
}
function compareRoutes(a, b) {
  const left = rank(a), right = rank(b);
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}
function routeRecord(rec) {
  const trace = rec.observation || {};
  const sessionId = sessionIdOf(trace.sessionId || rec.sessionId);
  const purpose = trace.purpose || rec.purpose;
  if (!sessionId || purpose !== 'model_request') return null;
  const child = trace.hop === 1;
  const state = rec.pending ? 'pending' : rec.status >= 400 || rec.incomplete || rec.streamOutcome === 'error' ? 'error'
    : rec.streamOutcome === 'unknown' ? 'unknown' : rec.status >= 200 && rec.status < 300 ? 'success' : 'unknown';
  return {
    sessionId, requestOrder: trace.requestOrder ?? rec.requestOrder ?? rec.id,
    parentAttempt: trace.parentAttempt || rec.routing?.attempt || 1,
    childAttempt: child ? rec.routing?.attempt || 1 : 0, hop: child ? 1 : 0,
    startedAt: rec.startedAt || rec.ts || '', at: rec.ts || rec.startedAt || '',
    proxyName: trace.proxyName || rec.upstreamName || '', accountName: rec.upstreamName || '',
    accountId: rec.upstreamId || '', model: rec.routing?.actualModel || rec.model || '',
    requestedModel: trace.requestedModel || rec.routing?.requestedModel || rec.model || '',
    state, status: Number(rec.status) || null, responseModel: rec.responseModel || '',
  };
}
function updateRoutes(map, row) {
  if (!row) return;
  const entry = map.get(row.sessionId) || {};
  const key = row.hop ? 'inner' : 'outer';
  if (!entry[key] || compareRoutes(row, entry[key]) >= 0) entry[key] = row;
  map.set(row.sessionId, entry);
}
function streamOutcome(raw) {
  let result = 'unknown';
  for (const line of String(raw).split('\n')) {
    if (!line.startsWith('data:')) continue;
    let event; try { event = JSON.parse(line.slice(5)); } catch { continue; }
    if (['error', 'response.failed', 'response.incomplete'].includes(event.type)) return 'error';
    if (['message_stop', 'response.completed'].includes(event.type)) result = 'success';
  }
  return result;
}
function createProxyObservation({ lastCapture = () => null, now = Date.now } = {}) {
  const live = new Map(), links = new Map();
  const trim = map => { while (map.size > 500) map.delete(map.keys().next().value); };
  function begin(rec) { updateRoutes(live, routeRecord({ ...rec, pending: true })); trim(live); }
  function complete(rec) {
    const row = routeRecord(rec);
    if (!row) return;
    const entry = live.get(row.sessionId), key = row.hop ? 'inner' : 'outer';
    if (entry?.[key] && compareRoutes(row, entry[key]) >= 0) delete entry[key];
    if (entry && !entry.outer && !entry.inner) live.delete(row.sessionId);
  }
  function associate(trace) {
    for (const [key, row] of links) if (row.until <= now()) links.delete(key);
    const key = crypto.randomBytes(24).toString('hex');
    links.set(key, { trace: { ...trace }, until: now() + 30 * 60 * 1000 }); trim(links);
    return key;
  }
  function resolve(key) {
    const row = links.get(String(key || ''));
    if (!row || row.until <= now()) return null;
    return { ...row.trace };
  }
  const newest = (pending, recorded) => !pending ? recorded : !recorded || compareRoutes(pending, recorded) > 0 ? pending : recorded;
  function status(sessionId, target = null) {
    const id = sessionIdOf(sessionId), pending = id && live.get(id), recorded = id && lastCapture(id);
    const outer = newest(pending?.outer, recorded?.outer);
    let inner = newest(pending?.inner, recorded?.inner);
    // A child's account is evidence only for this exact parent attempt, never
    // the last subscription request from another turn/window or another retry.
    if (!outer || !inner || inner.requestOrder !== outer.requestOrder || inner.parentAttempt !== outer.parentAttempt) inner = null;
    const request = outer ? { ...outer, ...(inner ? { accountName: inner.accountName, accountId: inner.accountId, model: inner.model,
      responseModel: inner.responseModel, childState: inner.state, childAttempt: inner.childAttempt } : {}) } : null;
    return { sessionId: id, request, target, modelMeaning: 'sent-to-upstream' };
  }
  return { begin, complete, associate, resolve, status };
}
module.exports = { TRACE_HEADER, sessionIdOf, compareRoutes, routeRecord, updateRoutes, streamOutcome, createProxyObservation };
