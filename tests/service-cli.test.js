const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { run, linuxUnit } = require('../node/service-cli');

test('Linux service installer writes a persistent cluster panel unit and starts it', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'my-agents-service-')), calls = [];
  try {
    const exec = (command, args) => { calls.push([command, args]); return { status: 0, stdout: 'ok', stderr: '' }; };
    const result = run(['install', '--bind', '0.0.0.0', '--port', '4321', '--proxy-port', '4322'], { platform: 'linux', home, exec, serverPath: '/opt/my-agents/server.js', out: { log() {} } });
    const unit = fs.readFileSync(result.unitFile, 'utf8');
    assert.match(unit, /ExecStart="[^"]+" "\/opt\/my-agents\/server\.js"/);
    assert.match(unit, /Environment="MY_AGENTS_BIND=0\.0\.0\.0"/);
    assert.match(unit, /Environment="PORT=4321"/);
    assert.match(unit, /Environment="PROXY_PORT=4322"/);
    assert.match(unit, /Restart=always/);
    assert.deepEqual(calls.map(call => call[1]), [['--user', 'daemon-reload'], ['--user', 'enable', '--now', 'my-agents-panel.service']]);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('systemd unit escapes paths and percent specifiers', () => {
  const unit = linuxUnit({ serverPath: '/tmp/A B/100%/server.js', nodePath: '/usr/bin/node', workDir: '/tmp/A B', dataDir: '/tmp/data', claudeDir: '/tmp/claude', bind: '127.0.0.1', port: '4321', proxyPort: '4322', env: { PATH: '/usr/bin' } });
  assert.match(unit, /WorkingDirectory=\/tmp\/A\\x20B/);
  assert.match(unit, /100%%\/server\.js/);
});
