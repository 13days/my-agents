const { resolveCodex, codexEnvironment } = require('./cli');
const { createCodexRunner } = require('./runner');

const MODEL = /^[\w.\/:-]{1,100}$/;
const isClaudeModel = model => /^(claude|opus|sonnet|haiku|default)\b/i.test(model);

// Codex has no stdin protocol for follow-up turns, so the turn input is plain
// text: channel context is prepended to the prompt.
function codexTurnInput({ prompt, images, context = '' }) {
  const text = prompt || (images?.length ? '请查看这些图片。' : '');
  return { prompt: context ? `${context}\n\n${text}` : text, images: images || [] };
}

// Codex CLI engine adapter. Thread ids are created by the CLI ('discovered').
// `sessions` answers which threads exist and which provider created them;
// `capture` decides whether new threads go through the panel proxy.
function createCodexEngine({ sessions, capture = () => null, env = process.env } = {}) {
  return {
    id: 'codex',
    meta: { label: 'Codex', short: 'Codex', emblem: '◎', color: '#10a37f', aliases: ['openai-codex'], upstreamHint: '可停止任务后检查网络或登录状态' },
    capabilities: {
      sessionId: 'discovered', steer: 'restart', streamingText: false, reasoning: true, permissions: 'none',
      accounts: false, images: true, resources: ['skills', 'config', 'commands', 'agents', 'plugins', 'workflows'],
      usage: { cost: false }, search: false, wrapped: false, capture: true,
    },
    detect: () => resolveCodex({ env }),
    validModel: model => MODEL.test(model) && !isClaudeModel(model),
    owns: id => !!sessions.pathFor(id),
    open({ host, sessionId, cwd, model, emit, onIdle, onClosed }) {
      // Resumed threads keep their original provider: terminal threads (openai) cannot move to the panel and vice versa.
      const provider = sessionId ? sessions.provider(sessionId) : '';
      const proxy = capture({ provider });
      const info = resolveCodex({ env });
      let stopping = false, closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        runner.stop();
        onClosed();
      };
      const runner = createCodexRunner({
        cli: info.path, cwd, threadId: sessionId, model, config: proxy?.config || [],
        env: codexEnvironment({ ...env, PWD: cwd }, info), spawnImpl: host.spawn, tmpDir: host.join(host.tmpDir(), 'my-agents-codex'),
        emit: (event, data) => {
          emit(event, data);
          if (event === 'done' && stopping) close();
        },
        onIdle: () => { emit('idle', {}); onIdle(); },
      });
      return {
        ready: runner.ready,
        routed: !!proxy,
        submit: (id, input, steer, onAccept) => runner.submit(id, codexTurnInput(input), steer, onAccept),
        stop() {
          stopping = true;
          runner.stop();
          if (runner.running) runner.kill('SIGTERM'); else close();
        },
        close,
        respondPermission() { throw new Error('Codex 会话不需要授权确认'); },
        get currentId() { return runner.currentId; },
        get pendingCount() { return runner.pendingCount; },
        get busy() { return !!(runner.currentId || runner.pendingCount); },
      };
    },
  };
}
module.exports = { createCodexEngine, codexTurnInput, isClaudeModel };
