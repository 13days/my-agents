const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const { createClusterNetwork } = require('./cluster-peer');
const { createCluster } = require('../core/cluster');

function run(argv, { log = console } = {}) {
  const value = (name, fallback = '') => { const i = argv.indexOf(name); return i < 0 ? fallback : argv[i + 1]; };
  const file = value('--config', path.join(os.homedir(), '.my-agents', 'panel-cluster.json'));
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const self = config.members.find(item => item.id === config.nodeId);
  if (!self?.witness) throw new Error('witness 配置中的本机成员必须设置 witness=true');
  const listen = new URL(self.url);
  const network = createClusterNetwork({ token: config.token, selfId: config.nodeId, members: config.members, log });
  const gateway = { async start() { throw new Error('witness 不允许启动飞书网关'); }, async stop() {} };
  const cluster = createCluster({ dir: path.dirname(file), config, network, gateway, log });
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(cluster.status())); });
  server.on('upgrade', (req, socket, head) => { if (!network.upgrade(req, socket, head)) socket.destroy(); });
  server.listen(Number(listen.port || 4321), listen.hostname, () => { log.log(`my-agents witness 已启动：${self.id} ${self.url}`); cluster.start().catch(e => log.error(e.message)); });
  const stop = async () => { await cluster.stop(); server.close(() => process.exit(0)); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  return { server, cluster };
}
module.exports = { run };
