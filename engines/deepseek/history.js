const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { promisify } = require('node:util');

const { visibleRelayText } = require('../../core/claude-relay-message');
const { annotateMessageTimings } = require('../../message-timing');

const decompress = zlib.zstdDecompress && promisify(zlib.zstdDecompress);

function createHarnessHistory(dir, home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')) {
  const locations = new Map();
  return async function read(id, options = {}) {
    if (!decompress || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) return null;
    let file = locations.get(id);
    try {
      if (!file) {
        const native = (await fs.readFile(path.join(dir, 'dsh-sessions', id), 'utf8')).trim();
        if (!/^session-[\w-]{8,100}$/.test(native)) return null;
        const root = path.join(home, 'sessions');
        for (const project of await fs.readdir(root, { withFileTypes: true })) {
          if (!project.isDirectory()) continue;
          const candidate = path.join(root, project.name, native, 'session.v4.jsonl.zstd');
          if (await fs.stat(candidate).then(s => s.isFile(), () => false)) { file = candidate; break; }
        }
        if (!file) return null;
        locations.set(id, file);
      }
      const stat = await fs.stat(file);
      const revision = 'dsh:' + stat.mtimeMs + ':' + stat.size;
      if (options.before === undefined && revision === options.since) return { unchanged: true, revision };
      // Harness appends independent Zstandard frames. Node decodes one frame per call.
      if (stat.size > 64 * 1024 * 1024) return null;
      const compressed = await fs.readFile(file);
      const chunks = [];
      let remaining = 64 * 1024 * 1024;
      for (let offset = 0; offset < compressed.length;) {
        const { engine, buffer } = await decompress(compressed.subarray(offset), { info: true, maxOutputLength: remaining });
        if (!engine.bytesWritten) return null;
        offset += engine.bytesWritten;
        remaining -= buffer.length;
        chunks.push(buffer);
      }
      const messages = [];
      let cwd = '';
      for (const line of Buffer.concat(chunks).toString('utf8').split('\n')) {
        if (!line) continue;
        const row = JSON.parse(line);
        if (row.type === 'session') { cwd = row.cwd || ''; continue; }
        const msg = row.type === 'assistant/message' ? row.data?.message : row.type === 'user/message' && row.data?.source?.kind === 'user' ? row.data : null;
        if (!msg || !Array.isArray(msg.content)) continue;
        const content = msg.content.filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
        const text = msg.role === 'user' ? visibleRelayText(content) : content;
        if (text) messages.push({ role: msg.role, text, timestamp: row.time });
      }
      return { id, project: cwd, engine: 'deepseek', revision, messages: annotateMessageTimings(messages) };
    } catch (error) {
      if (error.code === 'ENOENT') locations.delete(id);
      // On older panel runtimes or unreadable native data, use the saved conversation.
      return null;
    }
  };
}
module.exports = { createHarnessHistory };
