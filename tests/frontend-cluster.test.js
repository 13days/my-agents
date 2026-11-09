const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'panel.css'), 'utf8');
const clusterSource = html.slice(html.indexOf('async function renderClusterPanel()'), html.indexOf('// Engine runtime nodes:'));

test('the connections page loads cluster state as an optional capability', () => {
  assert.match(clusterSource, /api\('GET', 'cluster'\)/);
  assert.match(clusterSource, /role="alert"/);
  assert.match(clusterSource, /data\.enabled === false/);
  assert.match(clusterSource, /workspaces/);
  assert.ok(html.indexOf('id="cluster-panel"') < html.indexOf('class="engine-tabs connection-tabs"'));
});

test('cluster controls transfer leadership and expose the join command', () => {
  assert.match(clusterSource, /api\('POST', 'cluster\/transfer'/);
  assert.match(clusterSource, /data-cluster-transfer/);
  assert.match(clusterSource, /data-cluster-transfer/);
});

test('cluster and runtime-node copy stays explicit in Chinese and English', () => {
  for (const text of ['集群与机器', 'Cluster & machines', '项目与目录', 'Projects & directories', 'IM 消息入口', 'IM ingress', 'Agent 执行机器', 'Agent execution', '引擎运行节点', 'Engine runtime nodes']) assert.ok(html.includes(text), `missing UI copy: ${text}`);
  assert.match(css, /\.machine-grid/);
  assert.match(css, /\.panel-layers/);
});

test('cluster member helpers normalize voting roles and engine CLI state', () => {
  const helperSource = html.slice(html.indexOf('function clusterMemberKind('), html.indexOf('async function renderClusterPanel()'));
  const context = vm.createContext({
    rt: (_zh, en) => en,
    hasEngine: id => id === 'claude',
    engineLabel: id => id === 'claude' ? 'Claude Code' : id,
  });
  vm.runInContext(helperSource, context);
  assert.equal(vm.runInContext("clusterMemberKind({ witness: true })", context), 'witness');
  assert.equal(vm.runInContext("clusterMemberKind({ learner: true })", context), 'learner');
  assert.equal(vm.runInContext("clusterMemberKind({ voter: true })", context), 'voter');
  context.member = { engines: { claude: { version: '1.2.3', installed: true }, codex: false } };
  assert.equal(vm.runInContext('clusterEngineSummary(member)', context), 'Claude Code 1.2.3 · codex not installed');
});

test('cluster response renders health, membership, gateways, and transfer candidates', async () => {
  const section = { hidden: true, isConnected: true, innerHTML: '', querySelectorAll: () => [], remove() { this.removed = true; } };
  const controls = { '#cluster-panel': section, '#cluster-refresh': {}, '#cluster-copy-join': {} };
  const context = vm.createContext({
    state: { type: 'proxy' },
    $: selector => controls[selector] || null,
    api: async (method, route) => route === 'workspaces' ? { machines: [], config: { defaults: {}, projects: [] } } : ({
      enabled: true, clusterId: 'office', nodeId: 'mac', role: 'leader', leader: { id: 'mac', label: 'Mac' },
      quorum: 2, voters: 3, online: 2, hasQuorum: true, term: 8,
      leaseUntil: Date.now() + 12000, automaticFailover: true,
      joinCommand: 'my-agents cluster join --token secret',
      members: [
        { id: 'mac', label: 'Mac', platform: 'darwin', version: '0.17.0', voter: true, online: true, role: 'leader', gatewayStatus: 'connected', engines: [{ id: 'claude', cli: { version: '2.0' } }] },
        { id: 'linux', label: 'Linux', platform: 'linux', version: '0.17.0', voter: true, online: true, role: 'follower', gatewayStatus: 'starting', engines: [{ id: 'codex', installed: false }] },
      ],
    }),
    rt: (_zh, en) => en,
    esc: value => String(value).replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`),
    hasEngine: id => id === 'claude', engineLabel: id => id === 'claude' ? 'Claude Code' : id,
    navigator: { clipboard: { writeText: async () => {} } }, toast() {}, confirm: () => true,
  });
  const source = html.slice(html.indexOf('function clusterStatusBadge('), html.indexOf('// Engine runtime nodes:'));
  vm.runInContext(source, context);
  await vm.runInContext('renderClusterPanel()', context);
  assert.equal(section.hidden, false);
  assert.match(section.innerHTML, /IM messages are received by Mac/);
  assert.match(section.innerHTML, /majority/);
  assert.match(section.innerHTML, /Agent runtime/);
  assert.match(section.innerHTML, /Not ready|Standby/);
  assert.match(section.innerHTML, /data-cluster-transfer="linux"/);
  assert.match(section.innerHTML, /Chosen per session/);
});
