const { resolveClaude, claudeEnvironment } = require('./cli');
const { openClaudeSession } = require('./session');

const MODEL = /^[\w.\/:\[\]-]{1,100}$/;

// Claude Code engine adapter. Panel-specific services (account routing,
// transcript lookup) are injected so the adapter also runs inside a remote node.
function createClaudeEngine({ accounts = null, transcripts, timeoutMs = Number(process.env.CCP_CHAT_TIMEOUT_MS || 0), env = process.env } = {}) {
  return {
    id: 'claude',
    meta: { label: 'Claude Code', short: 'Claude', emblem: '✳', color: '#d97757', aliases: ['cc', 'claude-code'], upstreamHint: '可停止任务后用 /route 切换账号' },
    capabilities: {
      sessionId: 'assigned', steer: 'inject', streamingText: true, reasoning: true, permissions: 'auto',
      accounts: !!accounts, images: true, resources: ['skills', 'config', 'commands', 'agents', 'plugins', 'workflows'],
      usage: { cost: true }, search: true, wrapped: true, capture: true,
    },
    detect: () => resolveClaude({ env }),
    validModel: model => MODEL.test(model),
    owns: id => !!transcripts.path(id),
    async open({ host, sessionId, resume, cwd, model, accountId, emit, onIdle, onClosed }) {
      if (accounts && typeof accountId === 'string') {
        try { accounts.setSessionRoute(sessionId, accountId); } catch (e) { throw Object.assign(e, { status: 400 }); }
      }
      // Enabled proxy accounts route through the panel (per-account usage); otherwise the CLI's own login is used.
      const clientEnv = accounts ? { ...(accounts.clientEnv() || {}), ...await accounts.modelEnvForSession(sessionId) } : {};
      const info = resolveClaude({ env });
      const session = openClaudeSession({
        host, cli: info.path, env: claudeEnvironment({ ...env, ...clientEnv, PWD: cwd }, info), cwd, sessionId, resume, model,
        settingsEnv: clientEnv.ANTHROPIC_BASE_URL ? clientEnv : null,
        emit, onIdle, onClosed, timeoutMs,
        transcript: () => transcripts.messages(sessionId),
      });
      session.routed = !!clientEnv.ANTHROPIC_BASE_URL;
      return session;
    },
  };
}
module.exports = { createClaudeEngine };
