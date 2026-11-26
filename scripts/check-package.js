// Verify the actual published artifact, not the working tree.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const net = require('node:net');
const { once } = require('node:events');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'my-agents-package-'));
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
(async () => {
  let child, output = '';
  try {
    const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', temp], { encoding: 'utf8' }))[0];
    execFileSync('tar', ['-xzf', path.join(temp, packed.filename), '-C', temp]);
    const cwd = path.join(temp, 'package');
    for (const asset of ['assets/my-agents.png', 'vendor/qr.js', 'scripts/ensure-node.sh']) {
      if (!fs.statSync(path.join(cwd, asset)).size) throw Error('Missing packaged asset: ' + asset);
    }
    execFileSync('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd, stdio: 'pipe', timeout: 180000 });
    const port = await freePort(), proxy = await freePort();
    const isolated = path.join(temp, 'home'); fs.mkdirSync(isolated);
    child = spawn(process.execPath, ['server.js'], { cwd, env: { ...process.env,
      HOME: isolated, MY_AGENTS_HOME: path.join(isolated, 'panel'), CLAUDE_DIR: path.join(isolated, 'claude'),
      CODEX_HOME: path.join(isolated, 'codex'), AGENTS_HOME: path.join(isolated, 'agents'),
      PORT: String(port), PROXY_PORT: String(proxy), MY_AGENTS_NO_PROXY_SETUP: '1', MY_AGENTS_BIND: '127.0.0.1'
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', b => { output = (output + b).slice(-8000); });
    child.stderr.on('data', b => { output = (output + b).slice(-8000); });
    for (let i = 0; i < 60; i++) {
      if (child.exitCode !== null) throw Error('Packaged server exited: ' + output);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
        if (response.ok && (await response.json()).ready) {
          const initial = await (await fetch(`http://127.0.0.1:${port}/api/heartflow`)).json();
          const unchanged = await (await fetch(`http://127.0.0.1:${port}/api/heartflow?revision=${encodeURIComponent(initial.revision)}`)).json();
          if (!initial.revision || !unchanged.unchanged || unchanged.messages || !unchanged.runtime) throw Error('Assistant revision polling failed');
          console.log('Published package installs, starts and serves incremental assistant status successfully'); return;
        }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw Error('Packaged server failed health check: ' + output);
  } finally {
    if (child && child.exitCode === null) { const ended = once(child, 'exit'); child.kill('SIGTERM'); const force = setTimeout(() => child.kill('SIGKILL'), 3000); await ended; clearTimeout(force); }
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
