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

test('reads every native Harness frame and only displays user questions and model replies', { skip: !require('node:zlib').zstdCompressSync }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-history-'));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  const id = randomUUID(), native = 'session-' + randomUUID();
  const folder = path.join(dir, 'sessions', 'project', native);
  fs.mkdirSync(folder, { recursive:true }); fs.mkdirSync(path.join(dir, 'dsh-sessions'));
  fs.writeFileSync(path.join(dir, 'dsh-sessions', id), native);
  const message = (role, kind, text) => ({ role, source:{kind}, content:[{type:'text',text}] });
  const frames = [
    { type:'session', cwd:'/project' },
    { type:'user/message', data:message('user','user','[my-agents 飞书发送上下文，本轮有效]\ninternal\n[/my-agents 飞书发送上下文]\n\nquestion') },
    { type:'user/message', data:message('user','runtime-context','internal') },
    { type:'assistant/message', data:{ message:message('assistant','model','reply') } },
  ];
  fs.writeFileSync(path.join(folder, 'session.v4.jsonl.zstd'), Buffer.concat(frames.map(frame => require('node:zlib').zstdCompressSync(JSON.stringify(frame) + '\n'))));
  const read = require('../engines/deepseek/history').createHarnessHistory(dir, dir);
  const history = await read(id);
  assert.equal(history.project, '/project');
  assert.deepEqual(history.messages.map(m=>m.text), ['question','reply']);
  assert.equal((await read(id, { since:history.revision })).unchanged, true);
  assert.equal(await read('../invalid'), null);
});
