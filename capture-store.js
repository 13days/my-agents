const fs = require('fs');
const path = require('path');

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

// Keep only byte offsets and list metadata in memory. Bodies remain complete on disk.
function createCaptureStore(file) {
  const records = new Map(), messages = new Map();
  let sequence = 0, needsNewline = false, revision = 0, loading = null, loadError = '', generation = 0;
  function index(rec, offset, length) {
    const meta = {};
    for (const key of ['id', 'ts', 'path', 'status', 'durationMs', 'model', 'messagesCount', 'respMsgId', 'clientVersion', 'upstreamId', 'upstreamName', 'usage', 'requestOrder', 'routing', 'method', 'incomplete', 'engine']) meta[key] = rec[key];
    Object.assign(meta, captureMetadata(rec));
    const start = Date.parse(rec.ts);
    meta.startedAt = rec.startedAt || (Number.isFinite(start) ? new Date(start - (Number(rec.durationMs) || 0)).toISOString() : '');
    meta.hasThinking = !!rec.thinking;
    meta.toolCount = rec.tools?.length || 0;
    records.set(String(rec.id), { meta, offset, length });
    if (rec.respMsgId) messages.set(rec.respMsgId, String(rec.id));
    sequence = Math.max(sequence, Number(rec.id) || 0);
  }
  function load({ limit = Infinity } = {}) {
    records.clear(); messages.clear(); sequence = 0; needsNewline = false;
    if (!fs.existsSync(file)) return;
    const fd = fs.openSync(file, 'r'), chunk = Buffer.alloc(1024 * 1024);
    let offset = 0, fragments = [], length = 0;
    const consume = () => {
      const line = Buffer.concat(fragments, length);
      try { index(JSON.parse(line.toString('utf8')), offset, length); } catch {}
      offset += length; fragments = []; length = 0;
    };
    try {
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
      if (length) { needsNewline = true; consume(); }
    } finally { fs.closeSync(fd); }
    revision++;
  }
  function loadAsync() {
    if (loading) return loading;
    if (!fs.existsSync(file)) return Promise.resolve();
    // New traffic may arrive before the historical maximum id is known.
    sequence = Math.max(sequence, Date.now() * 1000);
    const limit = fs.statSync(file).size, epoch = generation;
    if (limit) { const fd = fs.openSync(file, 'r'), tail = Buffer.alloc(1); try { fs.readSync(fd, tail, 0, 1, limit - 1); needsNewline = tail[0] !== 10; } finally { fs.closeSync(fd); } }
    const { Worker } = require('worker_threads');
    const worker = new Worker(require.resolve('./capture-index-worker'), { workerData: { file, limit } });
    loading = new Promise((resolve, reject) => {
      let complete = false;
      worker.on('message', message => {
        if (epoch === generation && message.entries) for (const [id, entry] of message.entries) {
          if (!records.has(id)) records.set(id, entry);
          if (entry.meta.respMsgId && Number(messages.get(entry.meta.respMsgId) || 0) < Number(id)) messages.set(entry.meta.respMsgId, id);
          sequence = Math.max(sequence, Number(id) || 0);
        }
        if (message.done) { complete = true; revision++; resolve(); }
      });
      worker.once('error', reject);
      worker.once('exit', code => { if (!complete) reject(new Error('抓包索引进程退出：' + code)); });
    }).catch(error => { loadError = error.message; throw error; }).finally(() => { loading = null; revision++; });
    return loading;
  }
  function append(rec) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, 'a', 0o600);
    try {
      if (needsNewline) { fs.writeSync(fd, '\n'); needsNewline = false; }
      const offset = fs.fstatSync(fd).size;
      const data = Buffer.from(JSON.stringify(rec) + '\n');
      fs.writeFileSync(fd, data);
      index(rec, offset, data.length); revision++;
    } finally { fs.closeSync(fd); }
  }
  function get(id) {
    const entry = records.get(String(id));
    if (!entry) return null;
    const fd = fs.openSync(file, 'r'), data = Buffer.alloc(entry.length);
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
    indexEntries: () => [...records],
    status: () => ({ loading: !!loading, error: loadError, records: records.size }),
    metadata: id => records.get(String(id))?.meta || null,
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
    clear() { generation++; fs.writeFileSync(file, ''); records.clear(); messages.clear(); revision++; },
  };
}
module.exports = { createCaptureStore };
