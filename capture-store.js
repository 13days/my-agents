const fs = require('fs');
const path = require('path');
const { routeRecord, updateRoutes, withinTurn } = require('./core/proxy-observation');

function captureMetadata(rec) {
  let payload = {};
  try { payload = JSON.parse(rec.requestBody || '{}') || {}; } catch {}
  const uid = payload.metadata?.user_id;
  const match = typeof uid === 'string' && uid.match(/session(?:_id)?["':\s_]*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  const sessionId = rec.sessionId ? String(rec.sessionId).toLowerCase() : match ? match[1].toLowerCase() : '';
  const route = (rec.path || '').split('?')[0];
  let purpose = /\/count_tokens$/.test(route) ? 'count_tokens' : /\/messages$/.test(route) || /\/chat\/completions$/.test(route) || /\/responses$/.test(route) ? 'model_request' : /\/models(?:\/|$)/.test(route) ? 'models' : /\/oauth\//.test(route) ? 'oauth' : 'other';
  let purposeInferred = false;
  if (purpose === 'model_request') {
    const last = Array.isArray(payload.messages) ? payload.messages.filter(m => m.role === 'user').at(-1) : null;
    const content = typeof last?.content === 'string' ? last.content : Array.isArray(last?.content) ? last.content.filter(p => p.type === 'text').map(p => p.text || '').join('\n') : '';
    // Inspect only the leading instruction, avoiding quoted history and tool results.
    const instruction = (content || rec.lastUser || '').slice(0, 1500);
    if (/^(?:Your task is to\s+|Please\s+)?(?:provide|create|write|generate)\b[^\n]{0,100}summary (?:of|for) (?:the|this|our) conversation|^.*?(?:conversation is being continued from a previous conversation|summarize (?:the|this|our) conversation)/i.test(instruction.slice(0, 500))) { purpose = 'compaction'; purposeInferred = true; }
    else if (/^(?:Please\s+)?(?:generate|create|write|provide)\b[^\n]{0,100}(?:title|session name)\b/i.test(instruction)) { purpose = 'title'; purposeInferred = true; }
  }
  const requestPolicy = {};
  for (const key of ['max_tokens', 'temperature', 'top_p', 'stream', 'thinking', 'output_config', 'context_management', 'service_tier', 'tool_choice', 'stop_sequences', 'cache_control']) if (Object.hasOwn(payload, key)) requestPolicy[key] = payload[key];
  return { requestPolicy, sessionId, sessionSource: sessionId ? 'metadata' : 'unknown', purpose, purposeInferred };
}
function compareCaptures(a, b) {
  if (a.requestOrder != null && b.requestOrder != null) return a.requestOrder - b.requestOrder || (a.routing?.attempt || 1) - (b.routing?.attempt || 1) || Number(a.id) - Number(b.id);
  // Records captured after this upgrade have a reserved arrival sequence.
  if ((a.requestOrder != null) !== (b.requestOrder != null)) return a.requestOrder != null ? 1 : -1;
  return (Date.parse(a.startedAt) || 0) - (Date.parse(b.startedAt) || 0) || Number(a.id) - Number(b.id) || String(a.id).localeCompare(String(b.id));
}

function captureEntry(rec, offset, length) {
  const meta = {};
  for (const key of ['id', 'ts', 'path', 'status', 'durationMs', 'model', 'messagesCount', 'respMsgId', 'clientVersion', 'upstreamId', 'upstreamName', 'usage', 'requestOrder', 'routing', 'method', 'incomplete', 'engine', 'observation', 'responseModel', 'streamOutcome']) meta[key] = rec[key];
  Object.assign(meta, captureMetadata(rec));
  const start = Date.parse(rec.ts);
  meta.startedAt = rec.startedAt || (Number.isFinite(start) ? new Date(start - (Number(rec.durationMs) || 0)).toISOString() : '');
  meta.hasThinking = !!rec.thinking;
  meta.toolCount = rec.tools?.length || 0;
  return {meta, offset, length};
}

function scanCaptureFile(fd, limit, visit) {
  const chunk = Buffer.alloc(1024 * 1024);
  let offset = 0, fragments = [], length = 0;
  const consume = () => {
    const line = Buffer.concat(fragments, length);
    let rec; try { rec = JSON.parse(line.toString('utf8')); } catch {}
    if (rec?.id != null) visit(rec, offset, length);
    offset += length; fragments = []; length = 0;
  };
  let count;
  let consumed = 0;
  while (consumed < limit && (count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, limit - consumed), null))) {
    consumed += count;
    let start = 0, end;
    while ((end = chunk.indexOf(10, start)) >= 0 && end < count) {
      const part = Buffer.from(chunk.subarray(start, end + 1));
      fragments.push(part); length += part.length; consume(); start = end + 1;
    }
    if (start < count) { const part = Buffer.from(chunk.subarray(start, count)); fragments.push(part); length += part.length; }
  }
  if (length) consume();
}

// Keep only byte offsets and list metadata in memory. Bodies remain complete on disk.
function createCaptureStore(file, options) {
  const segments = require('./core/capture-segments').createCaptureSegments(file, options);
  const records = new Map(), messages = new Map(), proxyRoutes = new Map();
  let sequence = 0, needsNewline = false, revision = 0, loading = null, loadError = '', generation = 0;
  function accept(id, entry, segment) {
    if (segment.removed || records.has(id)) return;
    entry.segment = segment;
    records.set(id, entry);
    updateRoutes(proxyRoutes, routeRecord(entry.meta));
    const msg = entry.meta.respMsgId;
    if (msg && Number(messages.get(msg) || 0) < Number(id)) messages.set(msg, id);
    sequence = Math.max(sequence, Number(id) || 0);
  }
  function snapshots() {
    const parts = segments.snapshots();
    const current = parts.find(p => p.file === file);
    if (current) {
      const fd = fs.openSync(file, 'r'), tail = Buffer.alloc(1);
      try { fs.readSync(fd, tail, 0, 1, current.bytes-1); needsNewline = tail[0] !== 10; }
      finally { fs.closeSync(fd); }
    }
    return parts;
  }
  function load() {
    records.clear(); messages.clear(); proxyRoutes.clear(); sequence = 0;
    for (const segment of snapshots()) {
      const fd = fs.openSync(segment.file, 'r');
      try { scanCaptureFile(fd, segment.bytes, (rec, offset, length) => accept(String(rec.id), captureEntry(rec, offset, length), segment)); }
      finally { fs.closeSync(fd); }
    }
    revision++;
  }
  function loadAsync() {
    if (loading) return loading;
    const parts = snapshots();
    if (!parts.length) return Promise.resolve();
    sequence = Math.max(sequence, Date.now()*1000);
    const epoch = generation, handles = [];
    // Pin the original inodes while appends can rename or retire their segments.
    try {
      for (const p of parts) handles.push({fd:fs.openSync(p.file,'r'), limit:p.bytes, cache:p.legacy ? p.file + '.index' : ''});
      const { Worker } = require('worker_threads');
      const worker = new Worker(require.resolve('./capture-index-worker'), {workerData:handles});
      loading = new Promise((resolve, reject) => {
        worker.on('message', ({part, entries}) => {
          if (epoch !== generation) return;
          for (const [id, entry] of entries) accept(id, entry, parts[part]);
          revision++;
        });
        worker.once('error', reject);
        worker.once('exit', code => code ? reject(new Error('抓包索引进程退出：'+code)) : resolve());
      }).catch(error => { loadError=error.message; throw error; }).finally(() => {
        for (const h of handles) fs.closeSync(h.fd);
        loading=null; revision++;
      });
    } catch (error) { for (const h of handles) fs.closeSync(h.fd); throw error; }
    return loading;
  }
  function forget(segment) {
    segment.removed = true;
    for (const [id, entry] of records) if (entry.segment === segment) records.delete(id);
    messages.clear(); proxyRoutes.clear();
    for (const [id, {meta}] of records) {
      if (meta.respMsgId && Number(messages.get(meta.respMsgId) || 0) < Number(id)) messages.set(meta.respMsgId,id);
      updateRoutes(proxyRoutes, routeRecord(meta));
    }
    revision++;
  }
  function append(rec) {
    fs.mkdirSync(path.dirname(file), {recursive:true});
    const data = Buffer.from(JSON.stringify(rec)+'\n');
    const segment = segments.reserve(data.length + Number(needsNewline), forget);
    const fd = fs.openSync(file,'a',0o600);
    try {
      if (needsNewline && segment.bytes) fs.writeSync(fd,'\n');
      needsNewline = false;
      const offset = fs.fstatSync(fd).size;
      fs.writeFileSync(fd,data);
      accept(String(rec.id),captureEntry(rec,offset,data.length),segment);
      revision++;
    } finally { segment.bytes=fs.fstatSync(fd).size; fs.closeSync(fd); }
  }
  function get(id) {
    const entry = records.get(String(id));
    if (!entry) return null;
    const fd = fs.openSync(entry.segment.file, 'r'), data = Buffer.alloc(entry.length);
    try {
      let read = 0;
      while (read < data.length) {
        const n = fs.readSync(fd, data, read, data.length - read, entry.offset + read);
        if (!n) throw new Error('抓包文件内容不完整');
        read += n;
      }
      return JSON.parse(data.toString('utf8'));
    } finally { fs.closeSync(fd); }
  }
  return {
    load, loadAsync, append, get,
    status: () => ({ loading: !!loading, error: loadError, records: records.size, storage:segments.status() }),
    metadata: id => records.get(String(id))?.meta || null,
    latestProxyRoute(sessionId, window) {
      const latest = proxyRoutes.get(sessionId);
      if (!latest || !Number.isFinite(window?.until) ||
          ![latest.outer, latest.inner].some(row => Date.parse(row?.startedAt) > window.until)) return latest || null;
      // A queued turn can start before the previous card has finished updating.
      const matches = new Map();
      for (const { meta } of records.values()) {
        if ((meta.observation?.sessionId || meta.sessionId) === sessionId) {
          updateRoutes(matches, withinTurn(routeRecord(meta), window));
        }
      }
      return matches.get(sessionId) || null;
    },
    linkSessions(byMessage) {
      let changed = false;
      for (const { meta } of records.values()) {
        if (meta.sessionSource === 'metadata') continue;
        const session = byMessage.get(meta.respMsgId) || '';
        if (meta.sessionId !== session) { meta.sessionId = session; meta.sessionSource = session ? 'transcript' : 'unknown'; changed = true; }
      }
      if (changed) revision++;
    },
    nextId: () => ++sequence,
    get revision() { return revision; },
    list: () => Array.from(records.values(), entry => entry.meta).sort(compareCaptures).reverse(),
    navigation(id) {
      const current = records.get(String(id))?.meta;
      if (!current?.sessionId) return { sessionId: '', position: null, total: 0, previousId: null, nextId: null };
      const items = Array.from(records.values(), entry => entry.meta).filter(item => item.sessionId === current.sessionId).sort(compareCaptures);
      const index = items.findIndex(item => String(item.id) === String(id));
      return { sessionId: current.sessionId, position: index + 1, total: items.length, previousId: index > 0 ? String(items[index - 1].id) : null, nextId: index < items.length - 1 ? String(items[index + 1].id) : null };
    },
    getByMessageId: id => get(messages.get(id)),
    clearLegacy() { segments.clearLegacy(forget); },
    clear() { generation++; segments.clear(forget); needsNewline=false; revision++; },
  };
}
module.exports = { createCaptureStore, captureMetadata, compareCaptures, captureEntry, scanCaptureFile };
