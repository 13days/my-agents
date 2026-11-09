const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveDataDir } = require('../core/data-dir');

const SERVICE = 'my-agents-panel.service';
const value = (argv, name, fallback = '') => { const i = argv.indexOf(name); return i < 0 ? fallback : argv[i + 1]; };
const systemdQuote = input => `"${String(input).replace(/%/g, '%%').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const systemdPath = input => String(input).replace(/%/g, '%%').replace(/\\/g, '\\\\').replace(/ /g, '\\x20');

function linuxUnit({ serverPath, nodePath, workDir, dataDir, claudeDir, bind, port, proxyPort, env = process.env }) {
  const values = {
    PORT: port,
    PROXY_PORT: proxyPort,
    MY_AGENTS_BIND: bind,
    MY_AGENTS_HOME: dataDir,
    CLAUDE_DIR: claudeDir,
    MY_AGENTS_NO_PROXY_SETUP: '1',
    MY_AGENTS_BACKGROUND_SERVICE: '1',
    PATH: env.PATH || '/usr/local/bin:/usr/bin:/bin',
  };
  for (const key of ['CLAUDE_CLI', 'CODEX_CLI', 'CODEX_HOME', 'AGENTS_HOME']) if (env[key]) values[key] = env[key];
  return `[Unit]\nDescription=my-agents panel cluster node\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${systemdPath(workDir)}\nExecStart=${systemdQuote(nodePath)} ${systemdQuote(serverPath)}\nRestart=always\nRestartSec=5\nTimeoutStopSec=15\nKillSignal=SIGTERM\nUMask=0077\n${Object.entries(values).map(([key, item]) => `Environment=${systemdQuote(`${key}=${item}`)}`).join('\n')}\n\n[Install]\nWantedBy=default.target\n`;
}

function runCommand(command, args, exec = spawnSync) {
  const result = exec(command, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `${command} 执行失败`).trim());
  return (result.stdout || '').trim();
}

function run(argv, { out = console, platform = process.platform, home = os.homedir(), exec = spawnSync, serverPath = path.resolve(__dirname, '..', 'server.js') } = {}) {
  if (platform !== 'linux') throw new Error('service 命令当前用于 Linux；macOS 请在面板启用登录自动启动');
  const command = argv[0], unitDir = path.join(home, '.config', 'systemd', 'user'), unitFile = path.join(unitDir, SERVICE);
  if (command === 'install') {
    const dataDir = path.resolve(value(argv, '--home', resolveDataDir({ home }).dir));
    const content = linuxUnit({ serverPath, nodePath: process.execPath, workDir: path.dirname(serverPath), dataDir, claudeDir: path.resolve(value(argv, '--claude-dir', path.join(home, '.claude'))), bind: value(argv, '--bind', '127.0.0.1'), port: value(argv, '--port', '4321'), proxyPort: value(argv, '--proxy-port', '4322') });
    fs.mkdirSync(unitDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(unitFile, content, { mode: 0o600 });
    runCommand('systemctl', ['--user', 'daemon-reload'], exec);
    runCommand('systemctl', ['--user', 'enable', '--now', SERVICE], exec);
    out.log(`my-agents Linux 服务已安装并启动：${SERVICE}`);
    return { unitFile, dataDir };
  }
  if (command === 'restart') { runCommand('systemctl', ['--user', 'restart', SERVICE], exec); out.log('my-agents Linux 服务已重启'); return; }
  if (command === 'status') { out.log(runCommand('systemctl', ['--user', 'status', SERVICE, '--no-pager'], exec)); return; }
  if (command === 'uninstall') {
    const result = exec('systemctl', ['--user', 'disable', '--now', SERVICE], { encoding: 'utf8' });
    if (result.status !== 0 && !/not loaded|does not exist|not found/i.test((result.stderr || '') + (result.stdout || ''))) throw new Error((result.stderr || result.stdout).trim());
    fs.rmSync(unitFile, { force: true }); runCommand('systemctl', ['--user', 'daemon-reload'], exec); out.log('my-agents Linux 服务已卸载'); return;
  }
  throw new Error('用法：my-agents service install [--bind 0.0.0.0] [--home 目录] | restart | status | uninstall');
}

module.exports = { run, linuxUnit, SERVICE };
