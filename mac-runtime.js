const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const xml = value => String(value).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
function createMacRuntime({ dir, serverPath, port, proxyPort, platform = process.platform, home = os.homedir(), launch = spawn, claudeInfo = { path: process.env.CLAUDE_CLI || 'claude', version: '' } }) {
  let awake = null;
  const agent = path.join(home, 'Library/LaunchAgents/io.my-agents.gateway.plist');
  return {
    status() { return { supported: platform === 'darwin', keepAwake: !!awake, autoStart: fs.existsSync(agent), backgroundService: (process.env.MY_AGENTS_BACKGROUND_SERVICE || process.env.CCP_BACKGROUND_SERVICE) === '1', claudeCli: claudeInfo.path, claudeVersion: claudeInfo.version }; },
    keepAwake(enabled) {
      if (awake) { awake.kill('SIGTERM'); awake = null; }
      if (enabled && platform === 'darwin') {
        awake = launch('/usr/bin/caffeinate', ['-i', '-s', '-w', String(process.pid)], { stdio: 'ignore' });
        const child = awake; child.on('error', () => { if (awake === child) awake = null; }); child.on('close', () => { if (awake === child) awake = null; });
      }
    },
    setAutoStart(enabled) {
      if (platform !== 'darwin') throw new Error('登录自动启动仅适用于 macOS');
      if (!enabled) { if (fs.existsSync(agent)) fs.unlinkSync(agent); return; }
      const node = process.execPath;
      const log = path.join(dir, 'panel-service.log');
      const env = { PORT: String(port), PROXY_PORT: String(proxyPort), CLAUDE_DIR: dir, MY_AGENTS_NO_PROXY_SETUP: '1', MY_AGENTS_BACKGROUND_SERVICE: '1', PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin' };
      for (const key of ['CLAUDE_CLI', 'CODEX_CLI', 'CODEX_HOME', 'AGENTS_HOME', 'MY_AGENTS_CODEX_CAPTURE', 'MY_AGENTS_CHAT_TIMEOUT_MS', 'CCP_CODEX_CAPTURE', 'CCP_CHAT_TIMEOUT_MS']) if (process.env[key] !== undefined) env[key] = process.env[key];
      const content = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>io.my-agents.gateway</string><key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(serverPath)}</string></array><key>WorkingDirectory</key><string>${xml(path.dirname(serverPath))}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>ProcessType</key><string>Background</string><key>EnvironmentVariables</key><dict>${Object.entries(env).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join('')}</dict><key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string></dict></plist>\n`;
      fs.mkdirSync(path.dirname(agent), { recursive: true }); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(agent, content, { mode: 0o600 });
    },
    close() { if (awake) awake.kill('SIGTERM'); awake = null; },
  };
}
module.exports = { createMacRuntime };
