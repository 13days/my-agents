const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPeer } = require('./rpc');
const { wsTransport, streamTransport } = require('./transports');
const { serveNode } = require('./agent');
const { createLocalHost } = require('../hosts/local');

// `my-agents node`: runs this machine's engine CLIs for a remote hub.
//   my-agents node --hub ws://hub:4321 --token <panel token> [--id name]
//   my-agents node --stdio            (launched by the hub over SSH)
// Logs go to stderr: in --stdio mode stdout carries the protocol.
const USAGE = `用法：
  my-agents node --hub ws://<hub>:4321 --token <令牌> [--id 名称] [--label 显示名]
  my-agents node --stdio [--id 名称]     由 Hub 通过 SSH 启动
令牌见 Hub 启动日志中的远程访问链接，或 Hub 数据目录下的 panel-token。`;

function parseArgs(argv) {
  const args = { stdio: false };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--stdio') args.stdio = true;
    else if (['--hub', '--token', '--id', '--label'].includes(key)) args[key.slice(2)] = argv[++i];
    else if (key === '-h' || key === '--help') args.help = true;
    else throw new Error(`未知参数：${key}`);
  }
  args.token ||= process.env.MY_AGENTS_TOKEN || '';
  args.hub ||= process.env.MY_AGENTS_HUB || '';
  return args;
}

// Engines on a node use the machine's own CLI logins; history replay and
// account routing stay on the hub.
function localEngines(env = process.env) {
  const { createClaudeEngine } = require('../engines/claude');
  const { createCodexEngine } = require('../engines/codex');
  const { createCodexSessions } = require('../engines/codex/sessions');
  const claudeDir = env.CLAUDE_DIR || path.join(os.homedir(), '.claude');
  const transcriptPath = id => {
    const root = path.join(claudeDir, 'projects');
    let dirs = [];
    try { dirs = fs.readdirSync(root); } catch {}
    for (const dir of dirs) { const file = path.join(root, dir, id + '.jsonl'); if (fs.existsSync(file)) return file; }
    return '';
  };
  return [
    createClaudeEngine({ transcripts: { path: transcriptPath, messages: () => null }, env }),
    createCodexEngine({ sessions: createCodexSessions({ home: env.CODEX_HOME || path.join(os.homedir(), '.codex') }), env }),
  ];
}

function run(argv, { engines = localEngines(), stderr = process.stderr } = {}) {
  const args = parseArgs(argv);
  const log = message => stderr.write(`[my-agents node] ${message}\n`);
  if (args.help || (!args.stdio && !args.hub)) { stderr.write(USAGE + '\n'); return null; }
  const host = createLocalHost();
  const id = args.id || os.hostname().split('.')[0], label = args.label || id;

  const claudeLogin=require('../core/claude-credentials').createClaudeLogin({dir:process.env.CLAUDE_CONFIG_DIR || process.env.CLAUDE_DIR || path.join(os.homedir(),'.claude')});
  const nativeLogins=()=>{ let codex=null;try{codex=JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME || path.join(os.homedir(),'.codex'),'auth.json'),'utf8'));}catch{} return {claude:claudeLogin.read(),codex}; };
  if (args.stdio) {
    const peer = createPeer(streamTransport(process.stdin, process.stdout));
    serveNode({ peer, host, engines, id, label, nativeLogins });
    peer.onClose(() => process.exit(0));
    log(`已通过 stdio 就绪（${id}）`);
    return peer;
  }

  const WebSocket = require('ws');
  const url = new URL('/api/nodes/connect', args.hub.replace(/^http/, 'ws')).toString();
  let delay = 1000;
  const connect = () => {
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${args.token}` } });
    socket.on('open', () => {
      delay = 1000;
      log(`已连接 Hub：${args.hub}（节点 ${id}）`);
      const peer = createPeer(wsTransport(socket));
      serveNode({ peer, host, engines, id, label, nativeLogins });
    });
    socket.on('unexpected-response', (_, res) => { log(`Hub 拒绝连接：HTTP ${res.statusCode}${res.statusCode === 401 ? '（令牌无效）' : ''}`); });
    socket.on('error', e => log(`连接失败：${e.message}`));
    socket.on('close', () => {
      log(`连接已断开，${Math.round(delay / 1000)} 秒后重连`);
      setTimeout(connect, delay);
      delay = Math.min(delay * 2, 30000);
    });
  };
  connect();
  return null;
}
module.exports = { run, parseArgs, localEngines };
