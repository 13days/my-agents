const { parentPort, workerData } = require('worker_threads');
const { createCaptureStore } = require('./capture-store');
const store = createCaptureStore(workerData.file);
store.load({ limit: workerData.limit });
const entries = store.indexEntries();
for (let i = 0; i < entries.length; i += 200) parentPort.postMessage({ entries: entries.slice(i, i + 200) });
parentPort.postMessage({ done: true });
