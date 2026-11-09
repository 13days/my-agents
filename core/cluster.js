const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const load = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
function atomic(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(tmp, file); }
function createCluster({ dir, config, network, gateway = { start: async () => {}, stop: async () => {} }, now = Date.now, random = Math.random, heartbeatMs = 500, electionMinMs = 1500, leaseMs = 1400, log = console }) {
  const stateFile = path.join(dir, 'panel-cluster-state.json');
  const snapshotFile = path.join(dir, 'panel-cluster-snapshot.json');
  const members = config.members || [], self = members.find(item => item.id === config.nodeId);
  if (!self) throw new Error('本机不在集群成员列表中');
  const voters = members.filter(item => item.voter !== false), quorum = Math.floor(voters.length / 2) + 1;
  let saved = load(stateFile, { term: 0, votedFor: '', snapshotIndex: 0 });
  let role = self.witness ? 'witness' : 'follower', leaderId = '', leaseUntil = 0, timer = null, heartbeat = null, stopped = true, campaigning = false;
  let lastLeaderAt = now(), preferred = config.preferred || '', snapshotChecksum = '';
  const syncNames = ['panel-feishu.json', 'panel-feishu-state.json'];
  const localSnapshot = () => {
    const files = Object.fromEntries(syncNames.flatMap(name => { try { return [[name, fs.readFileSync(path.join(dir, name), 'utf8')]]; } catch { return []; } }));
    const checksum = crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex');
    if (checksum !== snapshotChecksum) { snapshotChecksum = checksum; saved.snapshotIndex++; persist(); }
    return { term: saved.term, index: saved.snapshotIndex, checksum, files };
  };
  const applySnapshot = async snapshot => {
    if (!snapshot || snapshot.term < saved.term || snapshot.index <= saved.snapshotIndex) return false;
    if (crypto.createHash('sha256').update(JSON.stringify(snapshot.files || {})).digest('hex') !== snapshot.checksum) throw new Error('集群快照校验失败');
    for (const [name, content] of Object.entries(snapshot.files || {})) { if (!syncNames.includes(name) || typeof content !== 'string') throw new Error('集群快照文件无效'); const tmp = path.join(dir, name + '.cluster.tmp'); fs.writeFileSync(tmp, content, { mode: 0o600 }); fs.renameSync(tmp, path.join(dir, name)); }
    saved.snapshotIndex = snapshot.index; snapshotChecksum = snapshot.checksum; persist(); await gateway.reload?.(); return true;
  };
  const persist = () => atomic(stateFile, saved);
  const gatewayStop = async () => { if (role === 'leader') role = 'fenced'; leaseUntil = 0; await gateway.stop(); };
  const resetElection = () => { clearTimeout(timer); if (stopped || self.witness) return; const delay = electionMinMs + Math.floor(random() * electionMinMs); timer = setTimeout(campaign, delay); timer.unref?.(); };
  const validLeader = () => role === 'leader' && now() < leaseUntil;
  async function heartbeatRound() {
    if (stopped || role !== 'leader') return;
    const snapshot = localSnapshot();
    const message = { term: saved.term, leaderId: config.nodeId, leaseMs, snapshotIndex: saved.snapshotIndex };
    const results = await network.broadcast('cluster.heartbeat', message, { timeout: Math.min(heartbeatMs, 1000) });
    let acks = 1;
    for (const result of results) if (result.status === 'fulfilled' && result.value.value?.term === saved.term && voters.some(v => v.id === result.value.id)) { acks++; if ((result.value.value.snapshotIndex || 0) < snapshot.index) network.call(result.value.id, 'cluster.snapshot', snapshot, { timeout: 3000 }).catch(() => {}); }
    if (acks >= quorum) {
      leaseUntil = now() + leaseMs; role = 'leader';
      try { await gateway.start(); } catch (e) { log.warn?.('飞书 Leader 启动失败：' + e.message); }
    } else if (now() >= leaseUntil) await gatewayStop();
  }
  async function campaign() {
    if (stopped || self.witness || campaigning) return;
    campaigning = true; role = 'candidate'; leaderId = ''; saved.term++; saved.votedFor = config.nodeId; persist();
    let votes = 1;
    const results = await network.broadcast('cluster.requestVote', { term: saved.term, candidateId: config.nodeId, snapshotIndex: saved.snapshotIndex }, { timeout: 1000 });
    for (const result of results) if (result.status === 'fulfilled' && result.value.value?.granted && voters.some(v => v.id === result.value.id)) votes++;
    if (votes >= quorum) { role = 'leader'; leaderId = config.nodeId; leaseUntil = 0; clearInterval(heartbeat); heartbeat = setInterval(heartbeatRound, heartbeatMs); heartbeat.unref?.(); await heartbeatRound(); }
    else { role = 'follower'; resetElection(); }
    campaigning = false;
  }
  network.handle('cluster.requestVote', async (_, request) => {
    if (!voters.some(item => item.id === request.candidateId) || request.term < saved.term || request.snapshotIndex < saved.snapshotIndex) return { term: saved.term, granted: false };
    if (request.term > saved.term) { saved.term = request.term; saved.votedFor = ''; await gatewayStop(); role = self.witness ? 'witness' : 'follower'; }
    const granted = !saved.votedFor || saved.votedFor === request.candidateId;
    if (granted) { saved.votedFor = request.candidateId; persist(); lastLeaderAt = now(); resetElection(); }
    return { term: saved.term, granted };
  });
  network.handle('cluster.heartbeat', async (_, request) => {
    if (request.term < saved.term) return { term: saved.term, accepted: false };
    if (request.term > saved.term || role === 'leader' && request.leaderId !== config.nodeId) { saved.term = request.term; saved.votedFor = ''; persist(); await gatewayStop(); }
    leaderId = request.leaderId; role = self.witness ? 'witness' : 'follower'; lastLeaderAt = now(); resetElection();
    return { term: saved.term, accepted: true, snapshotIndex: saved.snapshotIndex };
  });
  network.handle('cluster.snapshot', async (_, snapshot) => ({ term: saved.term, applied: await applySnapshot(snapshot), snapshotIndex: saved.snapshotIndex }));
  network.handle('cluster.transfer', async (_, request) => {
    if (request.target !== config.nodeId || self.witness) return { accepted: false };
    if (request.term >= saved.term) { saved.term = request.term; saved.votedFor = ''; persist(); setTimeout(campaign, 10); }
    return { accepted: true };
  });
  async function transfer(target) {
    if (!validLeader()) throw Object.assign(new Error('只有持有多数派租约的主节点可以切换'), { status: 409 });
    const member = members.find(item => item.id === target && !item.witness);
    if (!member) throw new Error('目标节点不存在或不能承载网关');
    if (target === config.nodeId) return status();
    const result = await network.call(target, 'cluster.transfer', { target, term: saved.term + 1 }, { timeout: 3000 });
    if (!result.accepted) throw new Error('目标节点拒绝接管');
    preferred = target; await gatewayStop(); role = 'follower'; resetElection(); return status();
  }
  function status() {
    const online = new Set([config.nodeId, ...network.connected()]);
    const hasQuorum = validLeader() || now() - lastLeaderAt < leaseMs;
    const leader = validLeader() ? config.nodeId : leaderId;
    const onlineVoters = voters.filter(item => online.has(item.id)).length;
    return { enabled: true, clusterId: config.clusterId, nodeId: config.nodeId, role, leader, term: saved.term,
      health: { status: hasQuorum && leader ? 'healthy' : hasQuorum ? 'degraded' : 'unhealthy' },
      quorum: { online: onlineVoters, required: quorum, total: voters.length, met: hasQuorum }, voters: voters.length, online: online.size, hasQuorum,
      lease: { remainingMs: Math.max(0, leaseUntil - now()), expiresAt: leaseUntil, valid: validLeader() }, leaseUntil, preferred,
      automaticFailover: { enabled: voters.length >= 3, ready: voters.length >= 3 && hasQuorum, warning: voters.length < 3 ? '两个投票成员没有独立 witness 时不会自动接管，以避免网络分区双主。' : '' },
      members: members.map(item => ({ ...item, online: online.has(item.id), role: item.id === leader || validLeader() && item.id === config.nodeId ? 'leader' : item.witness ? 'witness' : 'follower', gatewayStatus: item.id === leader ? 'connected' : 'stopped' })) };
  }
  async function start() { stopped = false; network.start(); await gateway.stop(); resetElection(); }
  async function stop() { stopped = true; clearTimeout(timer); clearInterval(heartbeat); network.stop(); await gateway.stop(); }
  return { start, stop, status, transfer, campaign, canStart: validLeader };
}
function createStandalone(gateway) { return { start: () => gateway.start(), stop: () => gateway.stop(), status: () => ({ enabled: false, role: 'leader', leader: 'local', automaticFailover: false, members: [] }), transfer: async () => { throw new Error('未配置集群'); }, canStart: () => true }; }
module.exports = { createCluster, createStandalone };
