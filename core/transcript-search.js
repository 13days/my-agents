const { updateJsonLines } = require('./incremental-jsonl');
const { claudeRelayMessage } = require('./claude-relay-message');
const { codexRecord, codexUserText, codexAssistantText } = require('../engines/codex/sessions');
const { messageTimestamp } = require('../message-timing');

const PAGE_SIZE = 80;
const newest = (a, b) => a.key < b.key ? 1 : a.key > b.key ? -1 : 0;

function createTranscriptSearch({ files, claudeUserText, metadata, harnessSessions, harnessHistory }) {
  // Keep only human-visible text in the history worker. The JSONL reader
  // consumes appended bytes and rebuilds the file on truncation or rotation.
  const cache = new Map();
  function consume(state, row, engine) {
    let role, text;
    if (engine === 'claude') {
      state.project ||= row.cwd || '';
      const relay = claudeRelayMessage(row);
      if (row.isSidechain || (row.isMeta && !relay) || !row.message) return;
      role = row.type;
      const content = row.message.content;
      if (role === 'user') text = relay?.text || claudeUserText(content);
      if (role === 'assistant') text = typeof content === 'string' ? content
        : Array.isArray(content) && content.filter(b => b?.type === 'text').map(b => b.text).join('\n\n');
    } else {
      const record = codexRecord(row);
      if (!record) return;
      const { kind, p } = record;
      if (kind === 'session_meta' || kind === 'turn_context') state.project ||= p.cwd || '';
      if (kind !== 'response_item' || p.type !== 'message') return;
      role = p.role;
      if (role === 'user') text = codexUserText(p.content);
      if (role === 'assistant') text = codexAssistantText(p.content);
    }
    if (text) state.messages.push({ role, text: text.replace(/\s+/g, ' ').trim(), ts: messageTimestamp(row.timestamp) || '' });
  }

  const harnessCache = new Map();
  return async function search({ q, engine = 'all', before = '' }) {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const rows = [], visible = metadata(), paths = new Set();
    function collect(session, source, data) {
      for (const [index, msg] of data.messages.entries()) {
        const text = source === 'deepseek' ? msg.text?.replace(/\s+/g, ' ').trim() : msg.text;
        const ts = msg.ts ?? messageTimestamp(msg.timestamp) ?? '', role = msg.role;
        if (!text || !['user','assistant'].includes(role)) continue;
        const lower = text.toLowerCase();
        if (!words.every(word => lower.includes(word))) continue;
        const key = [ts, session, String(index).padStart(12, '0')].join('|');
        if (before && key >= before) continue;
        const pos = lower.indexOf(words[0]);
        rows.push({ key, session, role, engine: source, ts, project: data.project, snippet: text.slice(Math.max(0, pos - 40), pos + words[0].length + 100) });
        if (rows.length >= 2 * (PAGE_SIZE + 1)) { rows.sort(newest); rows.length = PAGE_SIZE + 1; }
      }
    }
    for (const file of files()) {
      const { session, path, engine: source } = file;
      paths.add(path);
      if (visible[session]?.deleted || (engine !== 'all' && engine !== source)) continue;
      const data = updateJsonLines(path, cache.get(path), () => ({ messages: [], project: '' }), (state, row) => consume(state, row, source));
      if (!data) { cache.delete(path); continue; }
      cache.set(path, data);
      collect(session, source, data);
    }
    if (harnessSessions && (engine === 'all' || engine === 'deepseek')) {
      const records = harnessSessions(), ids = new Set(records.map(row => row.id));
      for (const row of records) {
        if (visible[row.id]?.deleted) continue;
        const cached = harnessCache.get(row.id);
        const native = await harnessHistory(row.id, { since: cached?.revision });
        const history = native?.unchanged ? cached : native;
        if (history) harnessCache.set(row.id, history); else harnessCache.delete(row.id);
        collect(row.id, 'deepseek', history || { ...row, messages: row.messages || [] });
      }
      for (const id of harnessCache.keys()) if (!ids.has(id)) harnessCache.delete(id);
    }
    for (const path of cache.keys()) if (!paths.has(path)) cache.delete(path);
    return rows.sort(newest).slice(0, PAGE_SIZE + 1);
  };
}

async function searchMachines(sources, input) {
  const replies = await Promise.allSettled(sources.map(async source => {
    const rows = await source.search(input);
    return rows.map(row => ({ ...row, machineId: source.id }));
  }));
  const unavailable = [], hits = new Map();
  replies.forEach((reply, index) => {
    if (reply.status === 'rejected') unavailable.push(sources[index].label || sources[index].id);
    else for (const hit of reply.value) if (!hits.has(hit.key)) hits.set(hit.key, hit);
  });
  const sorted = [...hits.values()].sort(newest);
  const results = sorted.slice(0, PAGE_SIZE);
  return { results, unavailable, next: sorted.length > PAGE_SIZE ? results.at(-1).key : null };
}

module.exports = { createTranscriptSearch, searchMachines };
