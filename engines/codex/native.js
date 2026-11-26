const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

// Connect only to an existing, same-user daemon. Never bootstrap a daemon,
// resume with configuration overrides, take over approvals, or fork a thread.
function createDaemonClient({ socketPath, connect = url => new WebSocket(url), timeoutMs = 5000 }) {
  let socket, opening, sequence = 0;
  const pending = new Map();
  const disconnected = () => {
    socket = null; opening = null;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Codex 同步连接断开；投递结果待核对，未自动重发')); }
    pending.clear();
  };
  async function ready() {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      const ws = connect('ws+unix://' + socketPath + ':/'); socket = ws;
      const timer = setTimeout(() => { reject(new Error('连接 Codex daemon 超时')); ws.terminate(); }, timeoutMs);
      ws.on('error', error => { clearTimeout(timer); reject(error); });
      ws.on('close', () => { clearTimeout(timer); reject(new Error('Codex daemon 已断开')); if (socket === ws) disconnected(); });
      ws.on('message', data => {
        let row; try { row = JSON.parse(data); } catch { return; }
        const entry = pending.get(row.id);
        if (!entry) return; // This client never accepts or approves server requests.
        pending.delete(row.id); clearTimeout(entry.timer);
        if (row.error) entry.reject(Object.assign(new Error(row.error.message), { rpcError: true }));
        else entry.resolve(row.result);
      });
      ws.once('open', async () => {
        try {
          await request('initialize', { clientInfo: { name: 'my_agents', version: require('../../package.json').version }, capabilities: { experimentalApi: true } });
          ws.send(JSON.stringify({ method: 'initialized' })); clearTimeout(timer); resolve();
        } catch (error) { clearTimeout(timer); reject(error); ws.terminate(); }
      });
    });
    return opening;
  }
  function request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Codex 请求确认超时；状态未知，未自动重发')); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      const failed = error => {
        if (!error || !pending.has(id)) return;
        pending.delete(id); clearTimeout(timer); reject(error);
      };
      try { socket.send(JSON.stringify({ id, method, params }), failed); } catch (error) { failed(error); }
    });
  }
  return {
    async call(method, params) { await ready(); return request(method, params); },
    close() { const ws = socket; disconnected(); ws?.terminate(); },
  };
}

function createCodexNativeSessions({ home, pollMs = 600, clientFactory = createDaemonClient } = {}) {
  const socketPath = path.join(home, 'app-server-control', 'app-server-control.sock');
  function availableSocket() {
    let stat; try { stat = fs.lstatSync(socketPath); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    const owner = process.getuid?.();
    // The official daemon publishes a symlink in its private control directory
    // to a short socket path (Unix socket paths have a small length limit).
    const parent = fs.lstatSync(path.dirname(socketPath)), target = fs.realpathSync(socketPath);
    const targetParent = fs.lstatSync(path.dirname(target)), targetStat = fs.lstatSync(target);
    if (stat.uid !== owner || !parent.isDirectory() || parent.uid !== owner || (parent.mode & 0o077)
        || !targetParent.isDirectory() || targetParent.uid !== owner || (targetParent.mode & 0o077)
        || !targetStat.isSocket() || targetStat.uid !== owner) throw new Error('Codex daemon 本地入口权限不安全，未发送');
    return true;
  }
  async function find(id) {
    if (!id || !availableSocket()) return null;
    const client = clientFactory({ socketPath });
    try {
      const { thread } = await client.call('thread/read', { threadId: id, includeTurns: false });
      if (thread?.id !== id || thread.status?.type === 'notLoaded') return null;
      await client.call('thread/turns/list', { threadId: id, limit: 1, itemsView: 'full', sortDirection: 'desc' });
      return thread;
    } catch (error) {
      if (error.rpcError && /not found|no thread|does not exist/i.test(error.message)) return null;
      throw error;
    } finally { client.close(); }
  }
  function open({ sessionId, emit, onIdle, onClosed }) {
    const client = clientFactory({ socketPath }), entries = new Map(), seen = new Set();
    let closed = false, timer, polling = false;
    const publish = (entry, event, data) => emit(event, { ...data, messageId: entry.id });
    const close = () => { if (closed) return; closed = true; clearTimeout(timer); client.close(); entries.clear(); onClosed(); };
    function consume(entry, turn) {
      if (!entry.turnId) { entry.turnId = turn.id; publish(entry, 'turn', { id: entry.id }); }
      for (const item of turn.items || []) {
        const previous = entry.items.get(item.id), id = entry.id + '-' + item.id;
        if (item.type === 'agentMessage') {
          const before = previous?.text || '', text = item.text || '';
          if (text.startsWith(before) && text.length > before.length) publish(entry, 'text', { text: (!previous && entry.wroteText ? '\n\n' : '') + text.slice(before.length) });
          if (text) entry.wroteText = true;
        } else if (item.type === 'reasoning') {
          const text = (item.summary || []).join('\n\n');
          if (text && JSON.stringify(previous?.summary) !== JSON.stringify(item.summary)) publish(entry, 'reasoning', { id, text });
        } else {
          const tool = item.type === 'commandExecution' ? { name: 'shell', input: { command: item.command } }
            : item.type === 'mcpToolCall' ? { name: item.server + '.' + item.tool, input: item.arguments }
            : item.type === 'fileChange' ? { name: 'apply_patch', input: { changes: item.changes } }
            : item.type === 'dynamicToolCall' ? { name: item.tool, input: item.arguments } : null;
          if (tool && !previous) publish(entry, 'tool', { id, ...tool });
          if (tool && ['completed', 'failed', 'declined'].includes(item.status) && previous?.status !== item.status) publish(entry, 'tool_result', { id, output: item.aggregatedOutput || item.result?.content || item.error?.message || '', isError: item.status !== 'completed' });
        }
        entry.items.set(item.id, item);
      }
      // A message, a quiet stream, or a transport disconnect never finishes a turn.
      if (['completed', 'failed', 'interrupted'].includes(turn.status)) {
        const error = turn.error?.message || (turn.status === 'failed' ? 'Codex 原会话本轮失败' : '');
        if (error) publish(entry, 'error', { error });
        publish(entry, 'done', { sessionId, isError: !!error, error, interrupted: turn.status === 'interrupted' });
        entries.delete(entry.id);
      }
    }
    async function poll() {
      if (closed || polling) return;
      polling = true;
      try {
        if (entries.size) {
          let cursor;
          const remaining = new Set(entries.keys());
          const pageHasBoundary = new Set();
          do {
            const page = await client.call('thread/turns/list', { threadId: sessionId, limit: 10, itemsView: 'full', sortDirection: 'desc', ...(cursor ? { cursor } : {}) });
            if (closed) return;
            for (const turn of page.data || []) for (const id of [...remaining]) {
              const entry = entries.get(id);
              if (entry && (entry.turnId === turn.id || turn.items?.some(item => item.type === 'userMessage' && item.clientId === id))) { consume(entry, turn); remaining.delete(id); }
              if (entry?.beforeTurn === turn.id) pageHasBoundary.add(id);
            }
            cursor = page.nextCursor;
            // Do not scan the user's full history while a new message waits in the queue.
          } while (cursor && remaining.size && [...remaining].some(id => {
            const entry = entries.get(id);
            return entry?.turnId || (entry?.beforeTurn && !pageHasBoundary.has(id));
          }));
          if (!entries.size) onIdle();
          for (const entry of entries.values()) entry.warned = false;
        }
      } catch {
        if (!closed) for (const entry of entries.values()) if (!entry.warned) {
          entry.warned = true;
          publish(entry, 'warning', { kind: 'node_reconnecting', warning: '正在恢复原 Codex 会话的同步连接。原任务状态待核对；不会重发消息或关闭原终端。' });
        }
      } finally { polling = false; if (!closed && entries.size) timer = setTimeout(poll, pollMs); }
    }
    return {
      ready: Promise.resolve(sessionId), nativeAttached: true, routed: false,
      submit(id, input, steer, onAccept) {
        if (closed) throw new Error('同步连接已断开，请重新连接原 Codex 会话');
        if (seen.has(id)) return;
        if (entries.size >= 20) throw new Error('等待中的消息太多，请稍后再发送');
        const entry = { id, items: new Map(), turnId: '', wroteText: false }; entries.set(id, entry); seen.add(id); onAccept?.();
        publish(entry, 'warning', { kind: 'native_attachment', nativeSession: { id: sessionId }, warning: '已连接原 Codex 会话，沿用原终端的模型与权限。消息会加入同一会话的队列；断开同步不会停止原终端或撤回已投递的消息。' });
        const prompt = input.context ? input.context + '\n\n' + input.prompt : input.prompt;
        const content = [{ type: 'text', text: prompt || '请查看这些图片。' }, ...(input.images || []).map(image => ({ type: 'image', url: `data:${image.mimeType};base64,${image.data}` }))];
        // clientUserMessageId is stable. Never retry a write after a lost ACK.
        (async () => {
          // Remember the pre-delivery boundary so a busy terminal cannot push
          // this message off the first history page before the next poll.
          const page = await client.call('thread/turns/list', { threadId: sessionId, limit: 1, itemsView: 'notLoaded', sortDirection: 'desc' });
          if (closed) return;
          entry.beforeTurn = page.data?.[0]?.id || '';
          entry.attemptedWrite = true;
          await client.call('thread/queue/add', { threadId: sessionId, clientUserMessageId: id, input: content });
        })().catch(error => {
          if (closed || !entries.has(id)) return;
          if (error.rpcError || !entry.attemptedWrite) {
            publish(entry, 'error', { error: error.message }); publish(entry, 'done', { sessionId, isError: true, error: error.message }); entries.delete(id);
            if (!entries.size) onIdle();
          } else publish(entry, 'warning', { kind: 'native_delivery_pending', warning: 'Codex 投递确认中断，正在核对同一消息的处理结果；未自动重发。' });
        }).finally(() => { if (!closed) { clearTimeout(timer); timer = setTimeout(poll, 0); } });
      },
      stop: close, close,
      respondPermission() { throw new Error('请在原 Codex 终端处理权限确认'); },
      get currentId() { return entries.keys().next().value || ''; },
      get pendingCount() { return Math.max(0, entries.size - 1); },
      get busy() { return entries.size > 0; },
    };
  }
  return { find, open };
}
module.exports = { createCodexNativeSessions, createDaemonClient };
