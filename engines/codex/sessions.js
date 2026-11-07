const fs = require('fs');
const path = require('path');
const { reasoningText } = require('./runner');
const { messageTimestamp, annotateMessageTimings } = require('../../message-timing');

// Reads Codex CLI rollout files (~/.codex/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl).
// Newer files wrap records as {timestamp, type, payload}; older ones store the
// response items at top level. Both are normalized to the panel's message shape.
const GATEWAY_START = '[my-agents 飞书发送上下文，本轮有效]\n', GATEWAY_END = '[/my-agents 飞书发送上下文]';
const ID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

function stripGatewayContext(text) {
  const t = String(text || '');
  const legacy = t.startsWith('[Claude Panel 飞书发送上下文，本轮有效]\n');
  if (!legacy && !t.startsWith(GATEWAY_START)) return t;
  const marker = legacy ? '[/Claude Panel 飞书发送上下文]' : GATEWAY_END;
  const end = t.indexOf(marker);
  return end < 0 ? t : t.slice(end + marker.length).replace(/^\s+/, '');
}
// Codex injects AGENTS.md, environment and skill context as user messages.
function codexUserText(content) {
  const text = (Array.isArray(content) ? content : []).filter(b => b && (b.type === 'input_text' || b.type === 'text')).map(b => b.text || '').join('\n');
  const t = stripGatewayContext(text).trim();
  if (!t || t.startsWith('# AGENTS.md instructions') || /^<(environment_context|user_instructions|INSTRUCTIONS|turn_aborted|user_shell_command|skill|subagent_notification|permissions)/.test(t)) return '';
  return t;
}
function codexImages(content) {
  return (Array.isArray(content) ? content : []).filter(b => b?.type === 'input_image' && /^data:image\/(png|jpeg|webp|gif);base64,/.test(b.image_url || '')).map(b => {
    const [, mimeType, data] = b.image_url.match(/^data:(image\/[a-z]+);base64,(.*)$/);
    return { mimeType, data };
  });
}
function parseArgs(text) { try { return JSON.parse(text); } catch { return text; } }
function toolOutput(output) {
  if (typeof output === 'string') {
    const parsed = parseArgs(output);
    return parsed && typeof parsed === 'object' && typeof parsed.output === 'string' ? parsed.output : output;
  }
  if (Array.isArray(output)) return output.map(b => b?.text || '').join('');
  return output;
}
function records(fp) {
  let text; try { text = fs.readFileSync(fp, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d.payload && typeof d.payload === 'object') out.push({ ts: d.timestamp, kind: d.type, p: d.payload });
    else if (d.type) out.push({ ts: d.timestamp, kind: d.type === 'message' || d.type.endsWith('call') || d.type.endsWith('output') || d.type === 'reasoning' ? 'response_item' : d.type, p: d });
    else if (d.id && 'instructions' in d) out.push({ ts: d.timestamp, kind: 'session_meta', p: d });
  }
  return out;
}

function createCodexSessions({ home } = {}) {
  const root = () => path.join(home || process.env.CODEX_HOME || path.join(require('os').homedir(), '.codex'), 'sessions');
  let fileCache = { at: 0, files: new Map() };
  function files() {
    if (Date.now() - fileCache.at < 2000) return fileCache.files;
    const map = new Map();
    const walk = (dir, depth) => {
      let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const fp = path.join(dir, e.name);
        if (e.isDirectory() && depth < 3) walk(fp, depth + 1);
        else if (e.isFile()) { const m = e.name.match(ID_RE); if (m && e.name.startsWith('rollout-')) map.set(m[1], fp); }
      }
    };
    walk(root(), 0);
    fileCache = { at: Date.now(), files: map };
    return map;
  }
  const pathFor = id => files().get(id) || '';
  // 会话创建时的 model_provider（session_meta 在首行）；续接必须沿用，否则 CLI 拒绝 resume
  function provider(id) {
    const fp = pathFor(id); if (!fp) return '';
    let fd; try { fd = fs.openSync(fp, 'r'); } catch { return ''; }
    try {
      const chunks = [], buf = Buffer.alloc(65536);
      for (let pos = 0, n; pos < 4 << 20 && (n = fs.readSync(fd, buf, 0, buf.length, pos)) > 0; pos += n) {
        const nl = buf.subarray(0, n).indexOf(10);
        chunks.push(Buffer.from(buf.subarray(0, nl < 0 ? n : nl)));
        if (nl >= 0) break;
      }
      const d = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return d.type === 'session_meta' && typeof d.payload?.model_provider === 'string' ? d.payload.model_provider : '';
    } catch { return ''; } finally { fs.closeSync(fd); }
  }
  const summaryCache = new Map();
  function summary(id, fp) {
    let st; try { st = fs.statSync(fp); } catch { return null; }
    const cached = summaryCache.get(fp);
    if (cached?.mtime === st.mtimeMs && cached.size === st.size) return cached.value;
    let cwd = '', first = 0, firstTitle = '', title = '', promptAt = 0, count = 0, model = '';
    for (const { ts, kind, p } of records(fp)) {
      const at = Date.parse(ts || p.timestamp) || 0;
      if (at && !first) first = at;
      if (kind === 'session_meta' && !cwd) cwd = p.cwd || '';
      if (kind === 'turn_context') { if (p.cwd) cwd = cwd || p.cwd; if (p.model) model = p.model; }
      if (kind === 'event_msg' && p.type === 'thread_settings_applied' && p.thread_settings?.model) model = p.thread_settings.model;
      if (kind === 'response_item' && p.type === 'message' && p.role === 'user') {
        const text = codexUserText(p.content);
        if (!text) continue;
        count++;
        const line = text.replace(/\s+/g, ' ').slice(0, 200);
        if (!firstTitle) firstTitle = line;
        title = line; promptAt = at || promptAt;
      }
    }
    const value = { id, engine: 'codex', title: title || firstTitle || id.slice(0, 8), firstTitle, project: cwd, count, first: first || st.mtimeMs, last: st.mtimeMs, promptAt, model, path: fp };
    summaryCache.set(fp, { mtime: st.mtimeMs, size: st.size, value });
    return value;
  }
  function list() {
    const out = [];
    for (const [id, fp] of files()) { const s = summary(id, fp); if (s && (s.count || s.project)) out.push(s); }
    return out.sort((a, b) => b.last - a.last);
  }
  function messages(id) {
    const fp = pathFor(id);
    if (!fp) return null;
    const out = [], tools = new Map();
    let project = '';
    const assistant = () => {
      const prev = out[out.length - 1];
      if (prev?.role === 'assistant') return prev;
      const msg = { role: 'assistant', text: '', tools: [] }; out.push(msg); return msg;
    };
    for (const { ts, kind, p } of records(fp)) {
      if (kind === 'session_meta' && !project) project = p.cwd || '';
      if (kind === 'turn_context' && !project) project = p.cwd || '';
      const timestamp = messageTimestamp(ts || p.timestamp);
      if (kind === 'event_msg' && p.type === 'task_complete') {
        const last = out.at(-1);
        if (last?.role === 'assistant') {
          if (timestamp) last.timestamp = timestamp;
          if (typeof p.duration_ms === 'number' && p.duration_ms >= 0) last.durationMs = p.duration_ms;
        }
      }
      if (kind !== 'response_item') continue;
      if (p.type === 'message' && p.role === 'user') {
        const text = codexUserText(p.content), images = codexImages(p.content);
        if (text || images.length) out.push({ role: 'user', text, images, ...(timestamp ? { timestamp } : {}) });
      } else if (p.type === 'message' && p.role === 'assistant') {
        const text = (p.content || []).filter(b => b?.type === 'output_text').map(b => b.text || '').join('');
        if (!text) continue;
        const msg = assistant(); msg.text += (msg.text ? '\n\n' : '') + text; if (timestamp) msg.timestamp = timestamp;
      } else if (p.type === 'reasoning') {
        const text = reasoningText(p);
        if (text) { const message = assistant(); (message.reasoning ||= []).push({ id: p.id || `reasoning-${message.reasoning?.length || 0}`, text }); }
      } else if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
        const id = p.call_id || p.id;
        if (!id || tools.has(id)) continue;
        const name = p.namespace && p.namespace !== 'functions' ? `${p.namespace}.${p.name}` : p.name || p.type;
        const tool = { id, name, input: p.type === 'custom_tool_call' ? { input: p.input } : parseArgs(p.arguments ?? p.action), state: 'interrupted' };
        tools.set(id, tool); assistant().tools.push(tool);
      } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
        const tool = tools.get(p.call_id);
        if (tool) { tool.output = toolOutput(p.output); tool.state = 'done'; }
      } else if (p.type === 'web_search_call') {
        const id = p.id || `ws-${tools.size}`;
        const tool = { id, name: 'web_search', input: p.action || {}, state: 'done' };
        tools.set(id, tool); assistant().tools.push(tool);
      }
    }
    return { id, engine: 'codex', project, messages: annotateMessageTimings(out) };
  }
  // Token usage per day/model plus the most recent subscription quota snapshot.
  const statsCache = new Map();
  function fileStats(fp) {
    const st = fs.statSync(fp), cached = statsCache.get(fp);
    if (cached?.size === st.size && cached.mtime === st.mtimeMs) return cached.value;
    const daily = new Map(), models = new Map();
    let rateLimits = null, rateAt = 0;
    {
      let model = '', prev = null;
      for (const { ts, kind, p } of records(fp)) {
        if (kind === 'turn_context' && p.model) model = p.model;
        if (kind === 'event_msg' && p.type === 'thread_settings_applied' && p.thread_settings?.model) model = p.thread_settings.model;
        if (kind !== 'event_msg' || p.type !== 'token_count') continue;
        const at = Date.parse(ts) || 0;
        if (p.rate_limits && at >= rateAt) { rateLimits = p.rate_limits; rateAt = at; }
        const total = p.info?.total_token_usage;
        if (!total) continue;
        const delta = {};
        for (const key of ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens']) delta[key] = Math.max(0, (total[key] || 0) - (prev?.[key] || 0));
        prev = total;
        if (!Object.values(delta).some(Boolean)) continue;
        const day = at ? new Date(at).toISOString().slice(0, 10) : 'unknown';
        const m = model || 'unknown';
        for (const [map, key] of [[daily, day], [models, m]]) {
          const row = map.get(key) || { key, input: 0, cached: 0, output: 0, reasoning: 0, turns: 0 };
          row.input += delta.input_tokens; row.cached += delta.cached_input_tokens; row.output += delta.output_tokens; row.reasoning += delta.reasoning_output_tokens; row.turns++;
          map.set(key, row);
        }
      }
    }
    const value = { daily: [...daily.values()], models: [...models.values()], rateLimits, rateAt };
    statsCache.set(fp, { size: st.size, mtime: st.mtimeMs, value });
    return value;
  }
  function stats() {
    const daily = new Map(), models = new Map();
    let sessions = 0, rateLimits = null, rateAt = 0;
    const paths = new Set(files().values());
    for (const fp of statsCache.keys()) if (!paths.has(fp)) statsCache.delete(fp);
    for (const fp of paths) {
      let value; try { value = fileStats(fp); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      sessions++;
      if (value.rateAt >= rateAt) { rateAt = value.rateAt; rateLimits = value.rateLimits; }
      for (const [map, rows] of [[daily, value.daily], [models, value.models]]) for (const row of rows) {
        const merged = map.get(row.key) || { key: row.key, input: 0, cached: 0, output: 0, reasoning: 0, turns: 0 };
        for (const key of ['input', 'cached', 'output', 'reasoning', 'turns']) merged[key] += row[key];
        map.set(row.key, merged);
      }
    }
    const totals = [...models.values()].reduce((a, r) => ({ input: a.input + r.input, cached: a.cached + r.cached, output: a.output + r.output, reasoning: a.reasoning + r.reasoning, turns: a.turns + r.turns }), { input: 0, cached: 0, output: 0, reasoning: 0, turns: 0 });
    return { sessions, totals, daily: [...daily.values()].sort((a, b) => a.key.localeCompare(b.key)), models: [...models.values()].sort((a, b) => b.input + b.output - a.input - a.output), rateLimits, rateLimitsAt: rateAt || null };
  }
  return { list, messages, pathFor, provider, stats, files };
}
module.exports = { createCodexSessions, codexUserText, stripGatewayContext };
