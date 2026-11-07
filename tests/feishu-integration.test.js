const { test } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');
async function port() { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value; }
test('Feishu cards drive the real Panel HTTP API, automatic tool approval, CLI steering/queue and shared session history', { timeout: 20000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-feishu-integration-'));
  const panelPort = await port(), proxyPort = await port();
  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(__dirname, 'fixtures/feishu-server.cjs')], { env: { ...process.env, CLAUDE_DIR: dir, CODEX_HOME: path.join(dir, 'codex'), PORT: String(panelPort), PROXY_PORT: String(proxyPort), CCP_NO_PROXY_SETUP: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let text = ''; child.stdout.on('data', x => { text += x; }); child.stderr.on('data', x => { text += x; });
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(text + '\nIntegration timeout')); }, 15000);
      child.on('error', reject); child.on('exit', () => { clearTimeout(timer); resolve(text); });
    });
    assert.match(output, /FEISHU_INTEGRATION_OK/, output);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
