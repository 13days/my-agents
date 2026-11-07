const crypto = require('crypto');
const { createTurnQueue } = require('../../core/turn-queue');
const { createPermissionBridge } = require('./permissions');
const { cliResultError } = require('./result');
const { imageContent, imageMessage } = require('../../core/chat-input');

// One long-lived `claude -p --input-format stream-json` process per session.
// Normalizes the CLI stream-json protocol into panel events.
function openClaudeSession({ host, cli, env, cwd, sessionId, resume, model, settingsEnv, emit, onIdle, onClosed, transcript, timeoutMs = 0 }) {
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--dangerously-skip-permissions'];
  args.push(resume ? '--resume' : '--session-id', sessionId);
  if (model) args.push('--model', model);
  // settings.json env outranks the process env; --settings guarantees routing through the panel proxy.
  if (settingsEnv && Object.keys(settingsEnv).length) args.push('--settings', JSON.stringify({ env: settingsEnv }));
  const child = host.spawn(cli, args, { cwd, env });
  child.stdin.on('error', () => {});
  child.stdout.setEncoding('utf8');

  let stdout = '', stderr = '', sentText = false, turnStreamed = false, ended = false, timer;
  const streamingTools = new Map(), thinking = new Map();
  const toolAliases = new Map(), pendingTools = new Map();
  const backgroundTasks = new Set();
  const send = (event, data) => { if (!ended) emit(event, { ...data, ...(queue.currentId ? { messageId: queue.currentId } : {}) }); };
  const write = message => child.stdin.write(JSON.stringify(message) + '\n');
  let interruptId = '';

  const queue = createTurnQueue({
    isOpen: () => !child.stdin.destroyed && !child.stdin.writableEnded,
    start: entry => {
      clearTimeout(timer);
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) timer = setTimeout(() => {
        send('error', { error: `本轮已达到配置的超时时间（${Math.round(timeoutMs / 1000)} 秒）` });
        child.kill('SIGTERM');
      }, timeoutMs);
      sentText = turnStreamed = false; streamingTools.clear(); thinking.clear(); toolAliases.clear(); pendingTools.clear(); interruptId = '';
      send('turn', { id: entry.id });
      write({ ...entry.payload, uuid: entry.id, parent_tool_use_id: null });
    },
    interrupt: () => {
      interruptId = crypto.randomUUID();
      write({ type: 'control_request', request_id: interruptId, request: { subtype: 'interrupt' } });
    },
    onIdle: () => { clearTimeout(timer); send('idle', {}); onIdle(); },
  });
  const permissions = createPermissionBridge({ child, autoApprove: true, publish: (event, data) => {
    send(event, data);
    if (event === 'permission_resolved' && !queue.currentId) onIdle();
  } });

  const emitToolResult = block => {
    const id = toolAliases.get(block.tool_use_id) || block.tool_use_id;
    if (!pendingTools.has(id)) return;
    pendingTools.delete(id);
    send('tool_result', { id, output: block.content, isError: !!block.is_error });
  };
  // Some CLI versions omit user tool_result events from stdout. The transcript
  // is authoritative and also contains permission failures.
  const syncToolResults = () => {
    if (!pendingTools.size || !transcript) return;
    try {
      for (const message of transcript() || []) for (const tool of message.tools || []) {
        if (tool.output !== undefined) emitToolResult({ tool_use_id: tool.id, content: tool.output, is_error: tool.state === 'error' });
      }
    } catch {}
  };
  const flushThinking = (index, force) => {
    const item = thinking.get(index);
    if (!item || (!force && item.text.length - item.sent < 200)) return;
    item.sent = item.text.length;
    send('reasoning', { id: item.id, text: item.text });
  };

  const processLine = line => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.type === 'system' && msg.subtype === 'api_retry') {
      const status = msg.error?.status || msg.status_code || msg.error_status;
      send('warning', { warning: `上游请求失败${status ? `（${status}）` : ''}，Claude 正在重试${msg.attempt ? `（第 ${msg.attempt} 次）` : ''}。可停止任务后用 /route 切换账号。` });
    }
    if (msg.type === 'system' && msg.subtype === 'task_started' && msg.task_id) backgroundTasks.add(msg.task_id);
    if (msg.type === 'system' && msg.subtype === 'task_notification' && msg.task_id) {
      backgroundTasks.delete(msg.task_id);
      if (!queue.currentId) onIdle();
    }
    if (permissions.handle(msg)) return;
    if (msg.type === 'control_response') {
      if (msg.response?.request_id === interruptId && msg.response?.subtype === 'error') {
        queue.keep(); interruptId = '';
        send('warning', { warning: '当前 CLI 未接受中断，补充消息将按顺序继续处理' });
      }
    } else if (msg.type === 'stream_event') {
      const ev = msg.event;
      if (ev?.type === 'message_start') { turnStreamed = false; streamingTools.clear(); }
      if (ev?.type === 'content_block_start') {
        const block = ev.content_block;
        if (block?.type === 'text' && block.text) { sentText = turnStreamed = true; send('text', { text: block.text }); }
        if (block?.type === 'thinking') thinking.set(ev.index, { id: `${(queue.currentId || 'turn').slice(0, 8)}-${msg.event?.index}-${crypto.randomUUID().slice(0, 4)}`, text: block.thinking || '', sent: 0 });
        if (block?.type === 'tool_use') {
          const tool = { id: block.id, name: block.name, finalized: false };
          streamingTools.set(ev.index, tool); pendingTools.set(block.id, tool);
          send('tool', { id: block.id, name: block.name, input: block.input, partial: true });
        }
      }
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) { sentText = turnStreamed = true; send('text', { text: ev.delta.text }); }
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'thinking_delta' && thinking.has(ev.index)) { thinking.get(ev.index).text += ev.delta.thinking || ''; flushThinking(ev.index); }
      if (ev?.type === 'content_block_stop' && thinking.has(ev.index)) flushThinking(ev.index, true);
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'input_json_delta' && streamingTools.has(ev.index)) send('tool_input', { id: streamingTools.get(ev.index).id, text: ev.delta.partial_json || '' });
    } else if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
      syncToolResults();
      for (const block of msg.message.content) {
        if (block.type === 'text' && block.text && !turnStreamed) { sentText = true; send('text', { text: block.text }); }
        else if (block.type === 'tool_use') {
          const tool = Array.from(streamingTools.values()).find(t => t.id === block.id || (!t.finalized && t.name === block.name));
          const known = toolAliases.has(block.id);
          const id = toolAliases.get(block.id) || tool?.id || block.id;
          if (tool) tool.finalized = true;
          toolAliases.set(block.id, id);
          if (!known || pendingTools.has(id)) pendingTools.set(id, { id, name: block.name });
          send('tool', { id, name: block.name, input: block.input });
        }
      }
      turnStreamed = false;
    } else if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
      for (const block of msg.message.content) if (block.type === 'tool_result') emitToolResult(block);
    } else if (msg.type === 'result') {
      syncToolResults();
      const interrupted = queue.interrupted;
      const error = interrupted ? '' : cliResultError(msg);
      if (error) send('error', { error });
      else if (!sentText && msg.result && !interrupted) send('text', { text: msg.result });
      send('done', { sessionId: msg.session_id || sessionId, cost: msg.total_cost_usd || null, turns: msg.num_turns || 0, usage: msg.usage || null, isError: !!error, error, interrupted });
      clearTimeout(timer);
      queue.finish();
    }
  };
  child.stdout.on('data', chunk => {
    stdout += chunk;
    let cut; while ((cut = stdout.indexOf('\n')) >= 0) { processLine(stdout.slice(0, cut)); stdout = stdout.slice(cut + 1); }
  });
  child.stderr.on('data', chunk => { if (stderr.length < 8000) stderr += chunk.toString('utf8'); });
  const toolSyncTimer = setInterval(syncToolResults, 1000);
  toolSyncTimer.unref?.();
  let stopped = false;
  const end = () => {
    clearTimeout(timer); clearInterval(toolSyncTimer);
    permissions.clear(); queue.stop();
    if (!ended) { ended = true; onClosed(); }
  };
  child.on('error', e => {
    send('error', { error: `无法启动 Claude Code（${cli}）：${e.message}。可用环境变量 CLAUDE_CLI 指定路径。` });
    end();
  });
  child.on('close', (code, signal) => {
    if (stdout.trim()) processLine(stdout.trim());
    syncToolResults();
    if (!ended && !stopped && (code !== 0 || queue.currentId)) send('error', { error: stderr.trim().slice(-2000) || `Claude Code 提前结束，未完成回复（${signal || `状态码 ${code}`}）` });
    end();
  });
  write({ type: 'control_request', request_id: crypto.randomUUID(), request: { subtype: 'initialize', hooks: {} } });

  return {
    ready: Promise.resolve(sessionId),
    submit(id, input, steer, onAccept) { queue.submit(id, imageMessage(input.prompt, imageContent(input.images), input.context), steer, onAccept); },
    stop() { stopped = true; queue.stop(); child.kill('SIGTERM'); },
    close() { child.stdin.end(); },
    respondPermission: (id, behavior) => permissions.respond(id, behavior),
    get currentId() { return queue.currentId; },
    get pendingCount() { return queue.pendingCount; },
    get busy() { return !!queue.currentId || permissions.size > 0 || backgroundTasks.size > 0; },
  };
}
module.exports = { openClaudeSession };
