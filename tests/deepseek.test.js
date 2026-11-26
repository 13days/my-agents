const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createDeepseekEngine } = require('../engines/deepseek');
const { createLocalHost } = require('../hosts/local');

test('Harness routes on the execution machine, resumes its native session, and propagates CLI failure', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-engine-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  const cli = path.join(dir, 'dsh'), native = 'session-' + randomUUID(), sessionId = randomUUID();
  fs.writeFileSync(cli, `#!/usr/bin/env node
    const fs = require('fs');
    const args = process.argv.slice(2);
    if (args.includes('--version')) { console.log('0.2.2'); process.exit(0); }
    const task = fs.readFileSync(0, 'utf8');
    const event = row => console.log(JSON.stringify(row));
    const id = ${JSON.stringify(native)};
    const resumed = args.includes('--session-id');
    if (resumed && args[args.indexOf('--session-id') + 1] !== id) process.exit(3);
    if (process.env.MY_AGENTS_DSH_KEY !== 'fixture' || process.env.MY_AGENTS_DSH_MODEL !== 'test-model' ||
        process.env.MY_AGENTS_DSH_SESSION !== ${JSON.stringify(sessionId)} || !args.includes('--patch') || args.includes('fixture')) process.exit(2);
    event({ type:'session', sessionId:id });
    if (task === 'failed') { event({type:'error',message:'upstream rejected model'}); process.exit(1); }
    const text = resumed ? 'continued' : 'created';
    event({ type:'text', text }); event({ type:'final', text, reason:{kind:'completed'} });
  `, { mode: 0o700 });
  const make = () => createDeepseekEngine({ dir, env: { ...process.env, DSH_CLI: cli }, route: async () => ({
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:54321', ANTHROPIC_AUTH_TOKEN: 'fixture', ANTHROPIC_MODEL: 'test-model',
  }) });
  for (const [prompt, expected] of [['first','created'], ['again','continued'], ['failed','upstream rejected model']]) {
    const engine = make(), resume = engine.owns(sessionId);
    assert.equal(resume, prompt !== 'first');
    const events = [];
    let idle;
    const finished = new Promise(resolve => { idle = resolve; });
    const session = await engine.open({ host: createLocalHost(), cwd: dir, sessionId, resume,
      emit: (event, data) => events.push({ event, data }), onIdle: idle, onClosed() {} });
    session.submit(randomUUID(), { prompt });
    assert.equal(await session.ready, sessionId);
    await finished;
    assert.deepEqual(events.filter(e => e.event === 'text' || e.event === 'error').map(e => e.data.text || e.data.error), [expected]);
    assert.equal(events.some(e => e.event === 'done'), prompt !== 'failed');
    session.close();
  }
});
