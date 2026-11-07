const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { EventEmitter } = require('node:events');
const { createMacRuntime } = require('../mac-runtime');
test('keep-awake is tied to the panel PID; login agent is scoped to this user and escapes paths', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-mac-runtime-')), calls = [];
  try {
    const runtime = createMacRuntime({ dir, home: dir, serverPath: path.join(dir, 'A&B/server.js'), port: 4321, proxyPort: 4322, platform: 'darwin', launch: (cmd, args) => { const child = new EventEmitter(); child.kill = signal => calls.push({ signal }); calls.push({ cmd, args }); return child; } });
    runtime.keepAwake(true); assert.equal(runtime.status().keepAwake, true); assert.deepEqual(calls[0].args, ['-i', '-s', '-w', String(process.pid)]);
    runtime.keepAwake(false); assert.equal(runtime.status().keepAwake, false); assert.equal(calls[1].signal, 'SIGTERM');
    runtime.setAutoStart(true); assert.equal(runtime.status().autoStart, true);
    const plist = fs.readFileSync(path.join(dir, 'Library/LaunchAgents/io.my-agents.gateway.plist'), 'utf8');
    assert.match(plist, /A&amp;B/); assert.match(plist, /MY_AGENTS_BACKGROUND_SERVICE<\/key><string>1/); assert.match(plist, /<key>KeepAlive<\/key><true\/>/); assert.equal(plist.includes('App Secret'), false);
    runtime.setAutoStart(false); assert.equal(runtime.status().autoStart, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
