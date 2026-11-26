const fs = require('fs');

// Each reader retains parsed state, not raw rollout records. Re-read only the
// appended bytes; preserve an incomplete UTF-8/JSON line until the next append.
function updateJsonLines(fp, cached, initialize, consume) {
  let fd;
  try { fd = fs.openSync(fp, 'r'); } catch { return null; }
  try {
    const stat = fs.fstatSync(fd);
    let extendedEof = false;
    if (cached?.eof && stat.size > cached.offset) {
      const first = Buffer.alloc(1); fs.readSync(fd, first, 0, 1, cached.offset); extendedEof = first[0] !== 10;
    }
    if (!cached || extendedEof || cached.ino !== stat.ino || cached.dev !== stat.dev || stat.size < cached.offset || (stat.size === cached.offset && stat.mtimeMs !== cached.mtime)) {
      cached = { ...initialize(), ino: stat.ino, dev: stat.dev, offset: 0, mtime: stat.mtimeMs, pending: '', decoder: new (require('string_decoder').StringDecoder)('utf8') };
    }
    const consumeLine = line => {
      let row; try { row = JSON.parse(line); } catch { return false; }
      if (!row || typeof row !== 'object') return true;
      consume(cached, row);
      return true;
    };
    const buffer = Buffer.alloc(Math.min(1024 * 1024, stat.size - cached.offset));
    if (stat.size > cached.offset) cached.eof = false;
    while (cached.offset < stat.size) {
      const n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - cached.offset), cached.offset);
      if (!n) break;
      cached.offset += n;
      const text = cached.pending + cached.decoder.write(buffer.subarray(0, n));
      let start = 0, end;
      while ((end = text.indexOf('\n', start)) >= 0) {
        const line = text.slice(start, end); start = end + 1;
        consumeLine(line);
      }
      cached.pending = text.slice(start);
    }
    // Historical exports may omit the final newline. Consume a complete JSON
    // record once, but rebuild if a later write extends that same line.
    if (cached.pending && consumeLine(cached.pending)) { cached.pending = ''; cached.eof = true; }
    cached.mtime = stat.mtimeMs;
    return cached;
  } finally { fs.closeSync(fd); }
}

module.exports = { updateJsonLines };
