const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawnSync } = require('node:child_process');
const { createTurnQueue } = require('../../core/turn-queue');

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
function createDeepseekEngine({ dir, env = process.env, route } = {}) {
  const mappings = path.join(dir, 'dsh-sessions');
  let cached, checked = 0;
  function detect() {
    if (Date.now() - checked < 30000) return cached;
    checked = Date.now();
    const dirs = [...(env.PATH || '').split(path.delimiter), path.join(os.homedir(), 'bin'), path.join(os.homedir(), '.npm-global', 'bin')];
    const candidates = env.DSH_CLI ? [env.DSH_CLI] : dirs.filter(Boolean).map(dir => path.join(dir, 'dsh'));
    cached = null;
    for (const file of new Set(candidates)) {
      if (!fs.existsSync(file)) continue;
      const run = spawnSync(file, ['--version'], { env, encoding: 'utf8', timeout: 4000 });
      if (!run.status && /^\d+\.\d+\.\d+/.test(run.stdout?.trim())) { cached = { path: file, version: run.stdout.trim() }; break; }
    }
    return cached;
  }
  function nativeId(id) {
    if (!uuid.test(id)) return '';
    try { return fs.readFileSync(path.join(mappings, id), 'utf8').trim(); }
    catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
  }
  return {
    id: 'deepseek', meta: { label: 'DeepSeek Harness', short: 'DSH', aliases: ['dsh','deepseek-harness'], emblem: '◈', cliEnv: 'DSH_CLI' },
    capabilities: { sessionId: 'assigned', steer: 'queue', streamingText: false, permissions: 'none', accounts: !!route, images: false, resources: [], capture: !!route, usage: {} },
    detect, owns: id => !!nativeId(id), validModel: model => /^[\w./:\[\]-]{1,100}$/.test(model),
    async open({ host, cwd, model, accountId, sessionId, resume, routeEnv, emit, onIdle, onClosed }) {
      if (!uuid.test(sessionId)) throw Error('DeepSeek Harness 会话 ID 无效');
      const cli = detect();
      if (!cli) throw Error('执行机器未找到可运行的 dsh，请安装 DeepSeek Harness 或设置 DSH_CLI。');
      let native = nativeId(sessionId);
      if (resume && !native) throw Error('未找到此会话的 DeepSeek Harness 原始记录');
      const proxy = routeEnv || await route?.({ sessionId, accountId, model });
      const routed = !!proxy?.ANTHROPIC_BASE_URL;
      const selected = model || proxy?.ANTHROPIC_MODEL;
      if (routed && !selected) throw Error('代理未提供默认模型，请在对话设置中选择可用模型。');
      if (!routed && (model || accountId)) throw Error('请先配置 Claude Code 代理，再指定 DeepSeek Harness 的代理账号或模型。');
      const childEnv = { ...env, PWD: cwd };
      if (routed) Object.assign(childEnv, { MY_AGENTS_DSH_URL: proxy.ANTHROPIC_BASE_URL, MY_AGENTS_DSH_KEY: proxy.ANTHROPIC_AUTH_TOKEN,
        MY_AGENTS_DSH_MODEL: selected, MY_AGENTS_DSH_SESSION: sessionId, ...(proxy.NO_PROXY ? { NO_PROXY: proxy.NO_PROXY, no_proxy: proxy.NO_PROXY } : {}) });
      let child, closed = false, resolveReady, rejectReady;
      const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      // Each invocation owns one native turn. Keep the native ID on the executing machine across restarts.
      function start({ id, payload }) {
        const args = ['headless', ...(routed ? ['--patch', path.join(__dirname, 'proxy.yml')] : []), '--json', ...(native ? ['--session-id', native] : []), '-'];
        let final, failure = '', stderr = '', sawText = false, sessionSeen = false;
        const proc = child = host.spawn(cli.path, args, { cwd, env: childEnv });
        emit('turn', { id, messageId: id });
        proc.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-2000); });
        proc.on('error', error => { failure = error.message; });
        proc.stdin.on('error', () => {});
        proc.stdin.end([payload.context, payload.prompt].filter(Boolean).join('\n\n'));
        readline.createInterface({ input: proc.stdout }).on('line', line => {
          let event;
          try { event = JSON.parse(line); } catch { return; }
          if (closed || failure) return;
          if (event.type === 'session') {
            if (!/^session-[\w-]{8,100}$/.test(event.sessionId) || (native && native !== event.sessionId)) {
              failure = 'DeepSeek Harness 返回了不匹配的会话'; proc.kill(); return;
            }
            if (!native) {
              try {
                fs.mkdirSync(mappings, { recursive: true, mode: 0o700 });
                fs.writeFileSync(path.join(mappings, sessionId), event.sessionId, { flag: 'wx', mode: 0o600 });
                native = event.sessionId;
              } catch (error) { failure = '无法保存 DeepSeek 会话绑定：' + error.message; proc.kill(); return; }
            }
            sessionSeen = true;
            resolveReady(sessionId);
          } else if (event.type === 'error') failure = event.message || 'DeepSeek Harness 运行失败';
          else if (event.type === 'final') final = event;
          else if (event.type === 'text' && event.text) { sawText = true; emit('text', { messageId: id, text: event.text }); }
          else if (event.type === 'tool_call') emit('tool', { messageId: id, id: event.callId, name: event.tool, input: event.input });
          else if (event.type === 'tool_result') emit('tool_result', { messageId: id, id: event.callId, output: event.result, isError: event.status === 'error' });
        });
        proc.on('close', code => {
          child = null;
          if (closed) return;
          if (!sessionSeen || failure || code !== 0 || final?.reason?.kind !== 'completed') {
            const error = failure || final?.reason?.error?.message || stderr.trim().split('\n').pop() || 'DeepSeek Harness 未返回完成事件';
            rejectReady(Error(error)); emit('error', { messageId: id, error });
          } else {
            if (!sawText && final.text) emit('text', { messageId: id, text: final.text });
            emit('done', { messageId: id });
          }
          queue.finish();
        });
      }
      const queue = createTurnQueue({ start, canInterrupt: () => false, onIdle: () => { emit('idle', {}); onIdle(); } });
      function close() {
        if (closed) return;
        closed = true; queue.stop();
        if (child) {
          const proc = child;
          proc.kill('SIGTERM');
          const kill = setTimeout(() => proc.kill('SIGKILL'), 2500);
          kill.unref(); proc.once('close', () => clearTimeout(kill));
          emit('stopped', { messageId: queue.currentId });
        }
        rejectReady(Error('DeepSeek Harness 已停止')); onClosed();
      }
      return { ready, routed, submit(id, input, steer, accepted) {
        if (input.images?.length) throw Error('DeepSeek Harness 无头模式仅支持文字输入');
        queue.submit(id, input, false, accepted);
      }, close, stop: close, respondPermission() { throw Error('DSH 无头模式无法接收交互式授权'); },
      get currentId() { return queue.currentId; }, get pendingCount() { return queue.pendingCount; }, get busy() { return !!child || !!queue.pendingCount; } };
    },
  };
}
module.exports = { createDeepseekEngine };
