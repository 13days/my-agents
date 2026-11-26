const fs = require('fs');
const { parentPort, workerData } = require('worker_threads');
const { captureEntry, scanCaptureFile } = require('./capture-store');

for (const [part, {fd, limit, cache}] of workerData.entries()) {
  const st = fs.fstatSync(fd);
  const version = [1, st.ino, st.mtimeMs, limit].join(':');
  let cached;
  if (cache) {
    try {
      const index = JSON.parse(fs.readFileSync(cache, 'utf8'));
      if (index.version === version && Array.isArray(index.entries)) cached = index.entries;
    } catch {} // An absent or stale metadata cache can be rebuilt from the archive.
  }
  if (cached) {
    for (let i=0; i<cached.length; i+=200) parentPort.postMessage({part,entries:cached.slice(i,i+200)});
    continue;
  }
  let batch = [];
  const entries = cache ? [] : null;
  scanCaptureFile(fd, limit, (rec, offset, length) => {
    const entry = [String(rec.id),captureEntry(rec,offset,length)];
    batch.push(entry);
    entries?.push(entry);
    if (batch.length >= 200) { parentPort.postMessage({part,entries:batch}); batch=[]; }
  });
  if (batch.length) parentPort.postMessage({part,entries:batch});
  if (cache) {
    const tmp = cache + '.' + require('crypto').randomUUID() + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify({version,entries}), {mode:0o600,flag:'wx'});
      if (fs.statSync(cache.slice(0,-6), {throwIfNoEntry:false})?.ino === st.ino) fs.renameSync(tmp,cache);
    } catch {} finally { fs.rmSync(tmp,{force:true}); }
  }
}
