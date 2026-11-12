const fs = require('fs'), path = require('path'), crypto = require('crypto');
const ID = /^[\w-]{8,100}$/;
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'unknown']);
function createRunStore({ dir, now = Date.now }) {
  const root = path.join(dir, 'runs'), records = new Map(), journals = new Map(), unreadable = [];
  const atomic = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const tmp = file + '.' + crypto.randomUUID() + '.tmp'; const fd = fs.openSync(tmp, 'wx', 0o600); try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } fs.renameSync(tmp, file); };
  let names = []; try { names = fs.readdirSync(root); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const name of names.filter(name => ID.test(name))) {
    try { const row = JSON.parse(fs.readFileSync(path.join(root, name, 'meta.json'), 'utf8')); if (row.id === name) records.set(name, row); }
    catch (error) { if (error.code !== 'ENOENT') unreadable.push({ id: name, error: error.code || 'INVALID_JSON' }); }
  }
  function update(id, patch) {
    const old = records.get(id); if (!old) throw new Error('任务不存在');
    const row = { ...old, ...patch, id, updatedAt: now() };
    atomic(path.join(root, id, 'meta.json'), row); records.set(id, row); return row;
  }
  function journal(id) {
    if (journals.has(id)) return journals.get(id);
    if (!records.has(id)) throw new Error('任务不存在');
    const file = path.join(root, id, 'events.jsonl'); let sequence = 0;
    const read = (after = 0) => {
      let body = ''; try { body = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const rows = []; for (const line of body.split('\n')) { if (!line) continue; try { const row = JSON.parse(line); sequence = Math.max(sequence, row.seq || 0); if (row.seq > after) rows.push(row); } catch {} } return rows;
    };
    read();
    const value = { read, append(event, data) {
      const messageId = data.messageId || data.id;
      if (event === 'input' && messageId) update(id, { messageIds: [...new Set([...(records.get(id).messageIds || []), messageId])] });
      const row = { seq: ++sequence, event, data, timestamp: now() };
      const fd = fs.openSync(file, 'a+', 0o600);
      try {
        const size = fs.fstatSync(fd).size;
        if (size) { const tail = Buffer.alloc(1); fs.readSync(fd, tail, 0, 1, size - 1); if (tail[0] !== 10) fs.writeSync(fd, '\n'); }
        fs.writeFileSync(fd, JSON.stringify(row) + '\n');
        if (['input','done','error','stopped','end'].includes(event) || ['input','done','error'].includes(data.event)) fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      const current = records.get(id);
      const state = event === 'input' || event === 'turn' ? 'running' : event === 'done' ? data.isError ? 'failed' : 'completed' : event === 'error' ? 'failed' : event === 'stopped' ? 'cancelled' : event === 'end' && !TERMINAL.has(current.state) ? 'unknown' : current.state;
      if (state !== current.state) update(id, { state });
      return row.seq;
    } };
    journals.set(id, value); return value;
  }
  return {
    begin(meta, input) {
      const existing = [...records.values()].find(row => row.messageId === input.messageId || row.messageIds?.includes(input.messageId));
      if (existing) throw Object.assign(new Error('这条消息已经接收，请查看原任务；未重复执行'), { status: 409, runId: existing.id });
      const id = crypto.randomUUID(), row = { ...meta, id, messageId: input.messageId, input, state: 'preparing', createdAt: now(), updatedAt: now() };
      atomic(path.join(root, id, 'meta.json'), row); records.set(id, row); return row;
    },
    update, journal,
    status: () => ({ records: records.size, unreadable: [...unreadable] }),
    hasMessage: id => [...records.values()].some(row => row.messageId === id || row.messageIds?.includes(id)),
    find: id => [...records.values()].reverse().filter(row => [row.id, row.sessionId, row.conversationId].includes(id)).sort((a,b) => b.createdAt - a.createdAt)[0],
    list: () => [...records.values()].sort((a,b) => b.createdAt - a.createdAt).map(({ input, ...row }) => ({ ...row, prompt: input?.prompt || '' })),
    recover() { for (const row of records.values()) if (!TERMINAL.has(row.state)) { const reason = '服务重启，执行结果待核对；未自动重新执行'; update(row.id, { state: 'unknown', reason }); journal(row.id).append('warning', { kind: 'recovery', warning: reason }); journal(row.id).append('end', { state: 'unknown' }); } },
  };
}
module.exports = { createRunStore };
