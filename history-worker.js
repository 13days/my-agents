const { Worker } = require('worker_threads');
function createHistoryWorker(serverPath, { env = process.env } = {}) {
  let worker, sequence = 0;
  const pending = new Map(), cache = new Map(), reads = new Map();
  function start() {
    if (worker) return;
    const current = worker = new Worker(serverPath, { workerData: { myAgentsHistory: true }, argv: [], env });
    current.on('message', ({ id, value, error }) => {
      const item = pending.get(id); if (!item) return;
      pending.delete(id); clearTimeout(item.timer);
      error ? item.reject(new Error(error)) : item.resolve(value);
      if (!pending.size) current.unref();
    });
    const fail = error => {
      if (worker === current) worker = null;
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
      pending.clear();
    };
    current.on('error', fail); current.on('exit', code => fail(new Error(`History worker exited (${code})`)));
    current.unref();
  }
  const read = (type, input) => {
    const key = JSON.stringify([type, input]), hit = cache.get(key);
    if (hit && Date.now() - hit.at < 2000) return Promise.resolve(hit.value);
    if (reads.has(key)) return reads.get(key);
    start();
    const id = ++sequence;
    const request = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); if (!pending.size) worker?.unref(); reject(new Error('History processing timed out')); }, 60000);
      pending.set(id, { resolve, reject, timer }); worker.ref(); worker.postMessage({ id, type, input });
    }).then(value => { cache.set(key, { at: Date.now(), value }); if (cache.size > 20) cache.delete(cache.keys().next().value); return value; }).finally(() => reads.delete(key));
    reads.set(key, request); return request;
  };
  return { read, close: () => worker?.terminate() };
}
module.exports = { createHistoryWorker };
