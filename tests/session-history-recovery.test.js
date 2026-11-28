const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { createRunStore } = require('../core/run-store');
async function port() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
}
test('completed and interrupted archived jobs load native history after restart instead of an undefined live snapshot', { timeout: 15000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-recovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const project = path.join(dir, 'projects', 'fixture'); fs.mkdirSync(project, { recursive: true });
  const store = createRunStore({ dir }), ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  for (const [index, id] of ids.entries()) {
    fs.writeFileSync(path.join(project, id + '.jsonl'), [
      { type: 'user', sessionId: id, cwd: dir, message: { role: 'user', content: 'original question' } },
      { type: 'assistant', sessionId: id, message: { role: 'assistant', content: [{ type: 'text', text: 'original reply' }] } },
    ].map(JSON.stringify).join('\n') + '\n');
    const row = store.begin({ requestedId: id, conversationId: id, engine: 'claude', node: 'local' }, { messageId: 'message-' + index });
    store.update(row.id, { sessionId: id, state: index ? 'running' : 'completed', jobMeta: { sessionId: id, jobId: row.id, cwd: dir, engine: 'claude' } });
  }
  const interruptedSession = '33333333-3333-4333-8333-333333333333';
  const inputTime = '2026-11-28T07:50:31.817Z';
  const image = { mimeType: 'image/png', data: 'YQ==' };
  const inputId = 'dropped-message', presentId = 'kept-message', followId = 'next-message';
  const run = store.begin({ engine: 'claude' }, { messageId: presentId });
  store.update(run.id, { sessionId: interruptedSession });
  const journal = store.journal(run.id);
  journal.append('input', { id: presentId, prompt: 'same text' });
  journal.append('input', { id: inputId, prompt: 'same text', images: [image], timestamp: inputTime });
  journal.append('input', { id: followId, prompt: 'follow-up' });
  journal.append('done', { messageId: followId });
  const marker = { type: 'user', droppedPromptUuids: [presentId, inputId, inputId],
    message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } };
  fs.writeFileSync(path.join(project, interruptedSession + '.jsonl'), [
    { type: 'user', uuid: presentId, cwd: dir, message: { content: 'same text' } },
    marker, marker,
    { type: 'user', uuid: followId, message: { content: 'follow-up' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'answer' }] } },
  ].map(JSON.stringify).join('\n') + '\n');
  const panel = await port(), proxy = await port();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, MY_AGENTS_HOME: dir, CLAUDE_DIR: dir, CLAUDE_CONFIG_DIR: dir, CODEX_HOME: path.join(dir, 'codex'), MY_AGENTS_BIND: '127.0.0.1', PORT: String(panel), PROXY_PORT: String(proxy), MY_AGENTS_NO_PROXY_SETUP: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); } });
  await new Promise((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => reject(new Error(output)), 8000);
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('已启动')) { clearTimeout(timer); resolve(); } });
    child.stderr.on('data', chunk => { output += chunk; }); child.once('error', reject);
  });
  for (const id of ids) {
    const response = await fetch(`http://127.0.0.1:${panel}/api/sessions/${id}/messages`);
    assert.equal(response.status, 200);
    const data = await response.json(); assert.ok(Array.isArray(data.messages));
    assert.deepEqual(data.messages.map(message => message.text), ['original question', 'original reply']);
    assert.notEqual(data.liveReplay, true); assert.equal(data.id, id);
  }
  const url = 'http://127.0.0.1:' + panel + '/api/sessions/' + interruptedSession + '/messages';
  for (const query of ['', '?source=transcript']) {
    const data = await (await fetch(url + query)).json();
    assert.deepEqual(data.messages.map(m => m.text), ['same text', 'same text', 'follow-up', 'answer']);
    assert.deepEqual(data.messages[1], { role: 'user', id: inputId, interrupted: true,
      text: 'same text', images: [image], timestamp: inputTime });
    assert.equal(data.messageCount, 4);
  }
  const older = await (await fetch(url + '?before=2&limit=1')).json();
  assert.equal(older.messages[0].id, inputId);

});
