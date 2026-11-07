const test = require('node:test');
const assert = require('node:assert/strict');
const { imageContent, imageMessage } = require('../core/chat-input');
const { chooseFolder } = require('../folder-picker');
const { createSessionStore } = require('../session-store');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('images become real CLI image blocks with numbered references', () => {
  const images = imageContent([{ mimeType: 'image/png', data: 'aGVsbG8=' }]);
  const message = imageMessage('Explain this', images);
  assert.equal(message.message.content[0].text, '[Image #1]');
  assert.equal(message.message.content[1].source.media_type, 'image/png');
  assert.equal(message.message.content[1].source.data, 'aGVsbG8=');
  assert.equal(message.message.content[2].text, 'Explain this');
  assert.throws(() => imageContent([{ mimeType: 'image/svg+xml', data: 'aGVsbG8=' }]));
  assert.throws(() => imageContent(new Array(5).fill({ mimeType: 'image/png', data: 'eA==' })));
});

test('native folder picker uses a fixed command and cancel leaves the path empty', async () => {
  const folder = await chooseFolder({ platform: 'darwin', run: (cmd, args, options, done) => {
    assert.equal(cmd, 'osascript'); assert.match(args[1], /choose folder/); done(null, '/tmp/My Folder/\n', '');
  } });
  assert.equal(folder, '/tmp/My Folder/');
  assert.equal(await chooseFolder({ platform: 'darwin', run: (cmd, args, options, done) => done({ code: 1 }, '', 'User canceled. (-128)') }), null);
});

test('session names and panel deletion persist without modifying CLI records', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-session-store-'));
  try {
    const store = createSessionStore(dir);
    store.update('session-123', { title: 'My title' });
    store.update('session-456', { title: 'Other title' });
    store.update('session-123', { deleted: true });
    const records = createSessionStore(dir).read();
    assert.equal(records['session-123'].title, 'My title');
    assert.equal(records['session-123'].deleted, true);
    assert.equal(records['session-456'].title, 'Other title');
    assert.throws(() => store.update('../bad', {}));
    assert.deepEqual(fs.readdirSync(dir), ['panel-sessions.json']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
