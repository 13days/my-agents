const fs = require('fs');
const path = require('path');
const net = require('net');
const { StringDecoder } = require('string_decoder');

// Claude's native inbox feeds its already-open interactive process. Never
// confuse this with spawning `claude -p --resume` against the same transcript.
function createClaudeNativeSessions({ home, transcriptPath, pollMs = 400, sendTimeoutMs = 5000, deliveryTimeoutMs = 30000, now = Date.now }) {
  const registry = path.join(home, 'sessions');
  const privateFile = (file, metadata = false) => {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & (metadata ? 0o022 : 0o077))) throw new Error('原终端消息入口权限不安全，未发送');
    return stat;
  };
  function find(id, preferred = null) {
    let names; try { names = fs.readdirSync(registry); } catch { return null; }
    const matches = [];
    for (const name of names.filter(name => /^\d+\.json$/.test(name))) {
      try {
        const file = path.join(registry, name); privateFile(file, true);
        const row = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (name !== String(row.pid) + '.json' || row.sessionId !== id || row.kind !== 'interactive' || !Number.isSafeInteger(row.pid) || row.pid < 2) continue;
        try { process.kill(row.pid, 0); } catch { continue; }
        const stat = privateFile(row.messagingSocketPath);
        if (!stat.isSocket()) throw new Error('原终端消息入口不是套接字');
        if (row.peerProtocol !== 1) throw new Error('原终端消息协议不受支持，请升级该窗口使用的 Claude Code');
        matches.push(row);
      } catch (error) { if (/原终端/.test(error.message)) throw error; }
    }
    // Once attached, follow the exact process rather than re-electing a window
    // whenever another terminal resumes the same transcript.
    if (preferred) return matches.find(row => row.pid === preferred.pid && row.procStart === preferred.procStart && row.pidDomain === preferred.pidDomain && row.messagingSocketPath === preferred.messagingSocketPath) || null;
    if (matches.length > 1) {
      // A suspended shell window still publishes the same session ID. It is
      // not the conversational inbox when exactly one other window is ready.
      const conversational = matches.filter(row => ['idle', 'working', 'busy'].includes(row.status));
      if (conversational.length === 1 && matches.every(row => row === conversational[0] || row.status === 'shell')) return conversational[0];
      throw new Error('这条会话同时在多个 Claude Code 对话窗口打开（进程 ' + matches.map(row => row.pid).join('、') + '）。请关闭不需要接续的窗口，再从飞书发送；本次尚未投递，也未复制或关闭原会话');
    }
    return matches[0] || null;
  }
  function tokenFor(row) {
    for (const name of fs.readdirSync(registry).filter(name => name.startsWith(row.pid + '.') && name.endsWith('.key'))) {
      const file = path.join(registry, name); privateFile(file);
      const key = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (key.procStart === row.procStart && key.pidDomain === row.pidDomain && typeof key.peerToken === 'string') return key.peerToken;
    }
    return '';
  }
  function deliver(row, text) {
    // Re-resolve immediately before writing to reject stale or reused PIDs.
    const current = find(row.sessionId, row);
    if (!current || current.pid !== row.pid || current.procStart !== row.procStart) throw new Error('原终端已经退出或切换，请重新选择会话');
    const token = tokenFor(row);
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(row.messagingSocketPath);
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('原终端消息投递超时，状态未知；未自动重发')); }, sendTimeoutMs); timer.unref?.();
      socket.once('error', error => { clearTimeout(timer); reject(error); });
      socket.once('connect', () => {
        const frames = [...(token ? [{ type: 'auth', token }] : []), { type: 'user', message: { role: 'user', content: text } }];
        // Give the native macOS inbox time to consume the final frame before EOF.
        socket.write(frames.map(frame => JSON.stringify(frame)).join('\n') + '\n', () => {
          setTimeout(() => { socket.end(); clearTimeout(timer); resolve(); }, 150);
        });
      });
    });
  }
  function open({ record, sessionId, emit, onIdle, onClosed }) {
    const file = transcriptPath(sessionId);
    if (!file) throw new Error('原终端的会话记录暂不可读，未另建会话');
    const pending = [], seen = new Set(), decoder = new StringDecoder('utf8');
    let offset = fs.statSync(file).size, fragments = '', active = null, timer, closed = false, polling = false;
    const close = () => { if (closed) return; closed = true; clearTimeout(timer); pending.length = 0; active = null; onClosed(); };
    const fail = error => {
      for (const item of [active, ...pending].filter(Boolean)) emit('error', { messageId: item.id, error: error.message });
      close();
    };
    const textOf = message => typeof message?.content === 'string' ? message.content : (message?.content || []).filter(block => block.type === 'text').map(block => block.text || '').join('\n');
    const backgroundState = () => emit('warning', { messageId: active.id, kind: active.background.size ? 'native_background' : 'native_summary', warning: active.background.size ? `原会话仍有 ${active.background.size} 个后台任务执行中；当前内容是阶段回复，完成通知和最终汇总会继续同步。` : '后台任务已结束，正在等待原会话汇总结果。' });
    const finishTurn = () => { emit('done', { messageId: active.id }); active = null; if (!pending.length) onIdle(); };
    const consume = row => {
      if (!active || row.isSidechain) return;
      const message = row.message || {};
      // The native CLI records a held message before adding it as a user turn.
      // Approval can take minutes: an observation deadline is not a delivery failure.
      if (!active.confirmed && row.type === 'system' && row.subtype === 'informational'
          && typeof row.content === 'string' && row.content.startsWith('Held peer message')
          && row.content.includes(active.marker) && !active.held) {
        active.held = true;
        emit('warning', { messageId: active.id, kind: 'native_approval', warning: '消息已到达原终端，正在等待原窗口的接收授权。请在原窗口确认；IM 会继续跟踪，批准后的回答仍会同步到这里。无需重新提交。' });
      }
      if (!active.confirmed && row.type === 'user' && textOf(message).includes(active.marker)) {
        active.confirmed = true; emit('turn', { id: active.id, messageId: active.id });
      }
      if (!active.confirmed) return;
      // A task notification belongs to this request only when the CLI identifies
      // its system origin and its task ID was launched by a tool we observed.
      const notification = row.type === 'user' && (row.origin?.kind === 'task-notification' || row.turnOrigin === 'task_notification');
      if (notification) {
        const text = textOf(message), taskId = text.match(/<task-id>([^<]+)<\/task-id>/)?.[1], status = text.match(/<status>([^<]+)<\/status>/)?.[1];
        if (active.background.has(taskId) && ['completed', 'failed', 'stopped', 'cancelled'].includes(status)) {
          const toolId = active.background.get(taskId); active.background.delete(taskId);
          active.endCandidate = false; active.turnEnded = false; active.needsSeparator = active.text.size > 0;
          emit('tool_result', { messageId: active.id, id: toolId, output: status === 'completed' ? '后台任务已完成，等待原会话汇总' : '后台任务已结束：' + status, isError: status === 'failed' });
          backgroundState();
        }
      }
      if (row.type === 'system' && row.subtype === 'turn_duration') active.turnEnded = true;
      if (row.type === 'assistant') {
        active.endCandidate = false; active.turnEnded = false;
        for (const [index, block] of (message.content || []).entries()) {
          if (block.type === 'text') {
            const key = `${row.uuid || message.id}:${index}`, previous = active.text.get(key) || '';
            const text = block.text || ''; active.text.set(key, text);
            if (text.startsWith(previous) && text.length > previous.length) { emit('text', { messageId: active.id, text: (active.needsSeparator ? '\n\n' : '') + text.slice(previous.length) }); active.needsSeparator = false; }
          }
          if (block.type === 'tool_use' && !active.tools.has(block.id)) {
            active.tools.add(block.id); emit('tool', { messageId: active.id, id: block.id, name: block.name, input: block.input });
          }
        }
        if (['end_turn', 'stop_sequence'].includes(message.stop_reason)) { active.endCandidate = true; if (active.background.size) backgroundState(); }
      } else if (row.type === 'user' && Array.isArray(message.content)) {
        for (const block of message.content) if (block.type === 'tool_result' && active.tools.has(block.tool_use_id) && !active.results.has(block.tool_use_id)) {
          active.results.add(block.tool_use_id);
          const result = row.toolUseResult, taskId = result?.isAsync === true && result?.status === 'async_launched' ? result.agentId || result.taskId : result?.backgroundTaskId;
          if (!block.is_error && typeof taskId === 'string' && /^[\w-]{1,128}$/.test(taskId)) {
            active.background.set(taskId, block.tool_use_id); backgroundState();
          } else emit('tool_result', { messageId: active.id, id: block.tool_use_id, output: block.content, isError: block.is_error });
        }
      }
    };
    async function poll() {
      if (closed || polling) return; polling = true;
      try {
        const current = find(sessionId, record);
        if (!current || current.pid !== record.pid || current.procStart !== record.procStart) throw new Error('原终端会话已退出或切换；IM 已断开同步，历史仍保留');
        const size = fs.statSync(file).size;
        if (size < offset) throw new Error('原会话记录已重建，请重新连接');
        if (size > offset) {
          const length = Math.min(size - offset, 256 * 1024), buffer = Buffer.alloc(length), fd = fs.openSync(file, 'r');
          let read; try { read = fs.readSync(fd, buffer, 0, length, offset); } finally { fs.closeSync(fd); }
          offset += read; fragments += decoder.write(buffer.subarray(0, read));
          let end;
          while ((end = fragments.indexOf('\n')) >= 0) { const line = fragments.slice(0, end); fragments = fragments.slice(end + 1); try { consume(JSON.parse(line)); } catch {} }
          if (fragments.length > 8 * 1024 * 1024) throw new Error('原会话单条记录过大，IM 已停止同步；请在原窗口查看');
        }
        // end_turn ends a model response. A native turn can still run stop hooks
        // or async agents, so wait for its terminal record and drain the transcript.
        if (active?.confirmed && active.endCandidate && active.turnEnded && !active.background.size && current.status === 'idle' && offset >= size && !fragments) finishTurn();
        if (active && !active.confirmed && !active.held && !active.deliveryPending
            && offset >= size && now() - active.sentAt > deliveryTimeoutMs) {
          active.deliveryPending = true;
          emit('warning', { messageId: active.id, kind: 'native_delivery_pending', warning: '原终端尚未确认接收，投递状态待确认。IM 会继续跟踪，请检查原窗口是否需要授权；不要重复提交。/stop 只断开同步，不会撤回已发送的消息。' });
        }
        if (!active && pending.length && current.status === 'idle' && offset >= size) {
          active = pending.shift(); active.sentAt = now();
          await deliver(record, active.body);
        }
      } catch (error) { fail(error); }
      finally { polling = false; if (!closed) { timer = setTimeout(poll, pollMs); timer.unref?.(); } }
    }
    return {
      ready: Promise.resolve(sessionId), routed: false, nativeAttached: true,
      submit(id, input, _steer, accept) {
        if (closed) throw new Error('原终端同步已断开，请重新选择会话');
        if (seen.has(id)) return;
        if (input.images?.length) throw new Error('原终端消息通道当前只支持文字，请在原窗口发送图片');
        if (pending.length >= 20) throw new Error('等待中的消息太多，请稍后发送');
        const prefix = '[my-agents 飞书发送上下文，本轮有效]\n';
        let context = input.context || '';
        if (context.startsWith(prefix)) {
          const lines = context.slice(prefix.length).split('\n');
          if (lines[0]?.startsWith('当前会话由 my-agents 直接启动')) lines.shift();
          context = prefix + `本轮消息投递到原来已打开的 Claude Code 终端进程，不是 my-agents 新启动的 CLI。原进程版本：${record.version || '未提供'}；模型、登录与工具权限沿用该原窗口。\n` + lines.join('\n');
        }
        const marker = `my-agents-im:${id}`, body = `[来自飞书 · ${marker}]\n${context}\n\n${input.prompt || ''}`;
        if (Buffer.byteLength(body) > 512 * 1024) throw new Error('发送给原终端的消息过长');
        seen.add(id); pending.push({ id, marker, body, text: new Map(), tools: new Set(), background: new Map(), results: new Set(), endCandidate: false, turnEnded: false }); accept?.();
        emit('warning', { messageId: id, kind: 'native_attachment', nativeSession: { id: sessionId, name: record.name || '', pid: record.pid }, warning: '已连接原来打开的 Claude Code 窗口。飞书消息会由这个窗口处理，回到终端可以直接接着聊；断开 IM 同步不会关闭原窗口。' });
        if (!timer && !polling) { timer = setTimeout(poll, 0); timer.unref?.(); }
      },
      stop: close, close,
      respondPermission() { throw new Error('工具授权由原终端处理，请在原窗口确认'); },
      get currentId() { return active?.id || pending[0]?.id || ''; },
      get pendingCount() { return Math.max(0, pending.length - (active ? 0 : 1)); },
      get busy() { return !!active || !!pending.length; },
    };
  }
  return { find, open };
}
module.exports = { createClaudeNativeSessions };
