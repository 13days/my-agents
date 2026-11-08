const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function isConfigurationNotice(message) {
  return /^\s*\[features\]\.[\w-]+\s+is deprecated\b/i.test(String(message || '').replace(/`/g, ''));
}
const { createTurnQueue } = require('../../core/turn-queue');

// Codex has no long-lived stdin protocol in `exec` mode, so each panel turn
// runs `codex exec --json` (first turn) or `codex exec resume <thread>` (later
// turns). Steering stops the running process and resumes with the new input.
function codexArgs({ threadId, cwd, model, config = [], images = [], fork = false }) {
  const args = ['exec'];
  if (threadId) args.push(fork ? 'fork' : 'resume');
  for (const file of images) args.push('-i', file);
  args.push('--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox');
  if (model) args.push('-m', model);
  for (const item of ['model_reasoning_summary="auto"', ...config]) args.push('-c', item);
  if (threadId) args.push(threadId); else args.push('-C', cwd);
  args.push('-'); // prompt is read from stdin: no argv length or leading-dash issues
  return args;
}

function toolEvent(item) {
  switch (item.type) {
    case 'command_execution': return { name: 'shell', input: { command: item.command } };
    case 'file_change': return { name: 'apply_patch', input: { changes: item.changes } };
    case 'mcp_tool_call': return { name: `${item.server}.${item.tool}`, input: item.arguments };
    case 'web_search': return { name: 'web_search', input: { query: item.query } };
    case 'todo_list': return { name: 'update_plan', input: { items: item.items } };
    case 'collab_tool_call': return { name: item.tool || 'agent', input: item };
    default: return null;
  }
}
function reasoningText(item) {
  return typeof item.text === 'string' ? item.text : (Array.isArray(item.summary) ? item.summary : []).map(part => part?.text || '').filter(Boolean).join('\n\n');
}
function toolResult(item) {
  if (item.type === 'command_execution') return { output: item.aggregated_output || '', isError: item.status === 'failed' || (item.exit_code !== null && item.exit_code !== undefined && item.exit_code !== 0) };
  if (item.type === 'file_change') return { output: (item.changes || []).map(c => `${c.kind} ${c.path}`).join('\n'), isError: item.status === 'failed' };
  if (item.type === 'mcp_tool_call') return { output: item.error?.message || item.result?.content || item.result || '', isError: !!item.error || item.status === 'failed' };
  if (item.type === 'todo_list') return { output: (item.items || []).map(i => `${i.completed ? '[x]' : '[ ]'} ${i.text}`).join('\n'), isError: false };
  return { output: '', isError: item.status === 'failed' };
}

function createCodexRunner({ cli, cwd, threadId = '', model = '', config = [], env = process.env, emit, onIdle, onThread, spawnImpl = spawn, tmpDir = path.join(os.tmpdir(), 'my-agents-codex') }) {
  // 续接时先不认定线程：等 CLI 确认（thread.started）后再就绪；被终端占用时自动 fork 成新会话
  let resumeId = threadId, forked = false;
  threadId = '';
  let child = null, stopped = false, stderr = '';
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  ready.catch(() => {});

  const writeImages = images => (images || []).map((image, i) => {
    fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    const ext = image.mimeType.split('/')[1].replace('jpeg', 'jpg');
    const file = path.join(tmpDir, `${Date.now()}-${process.pid}-${i}-${Math.random().toString(36).slice(2)}.${ext}`);
    fs.writeFileSync(file, Buffer.from(image.data, 'base64'), { mode: 0o600 });
    return file;
  });

  const run = entry => {
    stderr = '';
    emit('turn', { id: entry.id });
    const files = writeImages(entry.payload.images);
    const fork = !threadId && !!resumeId && forked;
    const args = codexArgs({ threadId: threadId || resumeId, cwd, model, config, images: files, fork });
    let proc;
    try { proc = spawnImpl(cli, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
    catch (e) { finish({ error: `无法启动 Codex：${e.message}` }); return; }
    child = proc;
    let buffer = '', completed = false, failed = '';
    const tools = new Set(), summaries = new Map();
    const prefix = `${entry.id.slice(0, 8)}-`;
    const line = text => {
      let msg; try { msg = JSON.parse(text); } catch { return; }
      if (msg.type === 'thread.started' && msg.thread_id) {
        if (!threadId) { threadId = msg.thread_id; onThread?.(threadId); resolveReady(threadId); if (fork) emit('warning', { warning: `原会话正在别处打开（通常是终端里的 codex），已复制完整历史为新会话继续` }); }
      } else if (msg.type === 'item.started' || msg.type === 'item.updated' || msg.type === 'item.completed') {
        const item = msg.item || {};
        if (item.type === 'agent_message' && msg.type === 'item.completed' && item.text) {
          emit('text', { text: (entry.wroteText ? '\n\n' : '') + item.text });
          entry.wroteText = true;
        } else if (item.type === 'reasoning') {
          const text = reasoningText(item), id = prefix + item.id;
          if (text && summaries.get(id) !== text) { summaries.set(id, text); emit('reasoning', { id, text }); }
        } else if (item.type === 'error') {
          if (isConfigurationNotice(item.message)) emit('diagnostic', { code: 'deprecated_config', message: item.message });
          else emit('warning', { warning: item.message || 'Codex 警告' });
        }
        else if (item.type !== 'reasoning') {
          const tool = toolEvent(item);
          if (!tool) return;
          const id = prefix + item.id;
          if (!tools.has(id)) { tools.add(id); emit('tool', { id, ...tool }); }
          if (msg.type === 'item.completed') emit('tool_result', { id, ...toolResult(item) });
        }
      } else if (msg.type === 'turn.completed') {
        completed = true; failed = ''; entry.usage = msg.usage || null;
      } else if (msg.type === 'turn.failed') {
        failed = msg.error?.message || 'Codex 本轮失败';
      } else if (msg.type === 'error' && msg.message) {
        if (isConfigurationNotice(msg.message)) { emit('diagnostic', { code: 'deprecated_config', message: msg.message }); return; }
        // The CLI also uses error events for recoverable transport retries.
        // Only turn.failed (or exiting without turn.completed) is terminal.
        failed = msg.message;
        emit('warning', { warning: msg.message });
      }
    };
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', chunk => {
      buffer += chunk;
      let cut; while ((cut = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, cut)); buffer = buffer.slice(cut + 1); }
    });
    proc.stderr.on('data', chunk => { if (stderr.length < 8000) stderr += chunk.toString('utf8'); });
    proc.stdin.on('error', () => {});
    proc.stdin.end(entry.payload.prompt);
    let closed = false;
    const done = (code, signal, spawnError) => {
      if (closed) return; closed = true;
      if (buffer.trim()) line(buffer.trim());
      for (const file of files) fs.rm(file, { force: true }, () => {});
      child = null;
      if (!threadId && resumeId && !forked && !stopped && !entry.interrupted && /already has an active writer/.test(failed + stderr)) {
        forked = true; return run(entry);
      }
      if (!threadId) rejectReady(new Error(explainCodexError(failed || spawnError || stderr.trim().slice(-2000)) || `Codex 未能创建会话（${signal || `状态码 ${code}`}）`));
      if (entry.interrupted || stopped) return finish({ interrupted: true });
      if (failed) return finish({ error: failed });
      if (!completed) return finish({ error: spawnError || stderr.trim().slice(-2000) || `Codex 提前结束，未完成回复（${signal || `状态码 ${code}`}）` });
      finish({});
    };
    proc.on('error', e => done(null, null, `无法启动 Codex（${cli}）：${e.message}。可用环境变量 CODEX_CLI 指定路径。`));
    proc.on('close', (code, signal) => done(code, signal));
  };

  const finish = ({ error = '', interrupted = false }) => {
    const entry = queue.current;
    error = explainCodexError(error);
    if (error) emit('error', { error });
    emit('done', { sessionId: threadId, cost: null, turns: 1, usage: entry?.usage || null, isError: !!error, error, interrupted });
    queue.finish();
  };
  const queue = createTurnQueue({
    start: run,
    // Codex exec has no interrupt protocol: stop the process and resume with the new input.
    interrupt: () => child.kill('SIGINT'),
    canInterrupt: () => !!child && !!(threadId || resumeId),
    onIdle: () => onIdle?.(),
  });

  return {
    ready,
    get threadId() { return threadId || resumeId; },
    get currentId() { return queue.currentId; },
    get pendingCount() { return queue.pendingCount; },
    get interrupted() { return queue.interrupted; },
    get running() { return !!child; },
    submit(id, input, steer = false, onAccept) {
      if (stopped) throw new Error('会话连接已结束，请重新发送');
      queue.submit(id, { prompt: input.prompt, images: input.images }, steer, onAccept);
    },
    stop() { stopped = true; queue.stop(); },
    kill(signal = 'SIGTERM') { child?.kill(signal); },
    get stderr() { return stderr; },
  };
}
// CLI 原始报错前补一句能操作的中文说明
const ERROR_HINTS = [
  [/already has an active writer/, '这个 Codex 会话正在别处打开（通常是终端里的 codex 还没退出）。先在那边退出（/quit 或 Ctrl+C），再回来续聊；或者新开一个对话。'],
  [/modelProviderMismatch|your current provider is/, '这个会话创建时用的模型提供方与当前不同，无法续接。请新开一个对话。'],
  [/\b401\b|Unauthorized|not logged in/i,'Codex 登录可能已失效，请在终端运行 codex login 后重试。'],
];
function explainCodexError(error) {
  if (!error) return error;
  const hint = ERROR_HINTS.find(([re]) => re.test(error))?.[1];
  return hint ? `${hint}\n\n${error}` : error;
}

module.exports = { createCodexRunner, codexArgs, explainCodexError, reasoningText };
