const { resolveClaude, claudeEnvironment } = require('./cli');
const { openClaudeSession } = require('./session');

const MODEL = /^[\w.\/:\[\]-]{1,100}$/;
const PROVIDER_SWITCHES = ['CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_FOUNDRY'];

// Environment that points a session at the panel proxy, or {} when no proxy account is enabled.
async function accountRouteEnv(accounts, { sessionId, accountId }) {
  if (typeof accountId === 'string') {
    try { accounts.setSessionRoute(sessionId, accountId); } catch (e) { throw Object.assign(e, { status: 400 }); }
  }
  return { ...(accounts.clientEnv() || {}), ...await accounts.modelEnvForSession(sessionId) };
}

// Claude Code engine adapter. Panel-specific services (account routing,
// transcript lookup) are injected so the adapter also runs inside a remote node.
function createClaudeEngine({ accounts = null, transcripts, timeoutMs = Number(process.env.CCP_CHAT_TIMEOUT_MS || 0), env = process.env } = {}) {
  return {
    id: 'claude',
    meta: { label: 'Claude Code', short: 'Claude', emblem: '✳', color: '#d97757', aliases: ['cc', 'claude-code'], cliEnv: 'CLAUDE_CLI', upstreamHint: '可停止任务后用 /route 切换账号' },
    capabilities: {
      sessionId: 'assigned', steer: 'inject', streamingText: true, reasoning: true, permissions: 'auto',
      accounts: !!accounts, images: true, resources: ['skills', 'config', 'commands', 'agents', 'plugins', 'workflows'],
      usage: { cost: true }, search: true, wrapped: true, capture: true,
    },
    detect: () => resolveClaude({ env }),
    validModel: model => MODEL.test(model),
    owns: id => !!transcripts.path(id),
    // `routeEnv` comes from a hub when this adapter runs inside a remote node.
    async open({ host, sessionId, resume, cwd, model, accountId, routeEnv, emit, onIdle, onClosed }) {
      // Enabled proxy accounts route through the panel (per-account usage); otherwise the CLI's own login is used.
      const clientEnv = routeEnv?.ANTHROPIC_BASE_URL ? { ...routeEnv } : accounts ? await accountRouteEnv(accounts, { sessionId, accountId }) : {};
      const info = resolveClaude({ env });
      const base = { ...env };
      // A routed session must reach the panel proxy, not a cloud provider configured in the shell.
      if (clientEnv.ANTHROPIC_BASE_URL) { delete base.CLAUDE_CODE_OAUTH_TOKEN; for (const key of PROVIDER_SWITCHES) delete base[key]; }
      const session = openClaudeSession({
        host, cli: info.path, env: claudeEnvironment({ ...base, ...clientEnv, PWD: cwd }, info), cwd, sessionId, resume, model,
        settingsEnv: clientEnv.ANTHROPIC_BASE_URL ? { ...clientEnv, ...Object.fromEntries(PROVIDER_SWITCHES.map(key => [key, ''])) } : null,
        emit, onIdle, onClosed, timeoutMs,
        transcript: () => transcripts.messages(sessionId),
      });
      session.routed = !!clientEnv.ANTHROPIC_BASE_URL;
      return session;
    },
  };
}
module.exports = { createClaudeEngine, accountRouteEnv };
