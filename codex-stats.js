const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

// Rollout parsing must not block the HTTP server or Feishu connection.
if (!isMainThread && workerData?.myAgentsStats) {
  const sessions = require('./codex-sessions').createCodexSessions({ home: workerData.home });
  parentPort.on('message', () => {
    try { parentPort.postMessage({ value: sessions.stats() }); }
    catch (error) { parentPort.postMessage({ error: error.message }); }
  });
}
function createCodexStats({ home, ttl = 2000 } = {}) {
  let worker, pending, cached, at = 0;
  const read = () => {
    if (cached && Date.now() - at < ttl) return Promise.resolve(cached);
    if (pending) return pending;
    if (!worker) { worker = new Worker(__filename, { workerData: { myAgentsStats: true, home } }); worker.unref(); }
    const current = worker;
    pending = new Promise((resolve, reject) => {
      const cleanup = () => { current.off('message', message); current.off('error', error); current.off('exit', exit); current.unref(); pending = null; };
      const message = result => { cleanup(); if (result.error) reject(new Error(result.error)); else { cached = result.value; at = Date.now(); resolve(cached); } };
      const error = err => { cleanup(); worker = null; reject(err); };
      const exit = code => error(new Error(`Codex statistics worker exited (${code})`));
      current.once('message', message); current.once('error', error); current.once('exit', exit);
      current.ref(); current.postMessage('read');
    });
    return pending;
  };
  return { read, close: () => worker?.terminate() };
}
module.exports = { createCodexStats };
