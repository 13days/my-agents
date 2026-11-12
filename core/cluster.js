const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { performance } = require('perf_hooks');

const load = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
function atomic(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(tmp, file); }
function createCluster({ dir, config, network, gateway = { start: async () => {}, stop: async () => {} }, canTransfer = () => true, now = Date.now, monotonicNow = () => performance.now(), random = Math.random, heartbeatMs = 500, electionMinMs = 1500, leaseMs = 1400, log = console }) {
  const stateFile = path.join(dir, 'panel-cluster-state.json');
  const members = config.members || [], self = members.find(item => item.id === config.nodeId);
  if (!self) throw new Error('本机不在集群成员列表中');
  const voters = members.filter(item => item.voter !== false), quorum = Math.floor(voters.length / 2) + 1;
  let saved = load(stateFile, { term: 0, votedFor: '', snapshotIndex: 0 });
  let role = self.witness ? 'witness' : 'follower', leaderId = '', leaseUntil = 0, timer = null, heartbeat = null, leaseTimer = null, stopped = true, campaigning = false;
  let lastLeaderAt = monotonicNow(), preferred = config.preferred || '', snapshotChecksum = '', heartbeatBusy = false;
  const peerReports = new Map();
  const gatewayPhase = () => gateway.status?.().phase || (gateway.active ? 'connected' : 'disabled');
  const syncNames = ['panel-feishu.json', 'panel-feishu-state.json', 'panel-workspaces.json', 'panel-conversations.json'];
  const localSnapshot = () => {
    const files = Object.fromEntries(syncNames.flatMap(name => { try { return [[name, fs.readFileSync(path.join(dir, name), 'utf8')]]; } catch { return []; } }));
    const checksum = crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex');
    if (checksum !== snapshotChecksum) { snapshotChecksum = checksum; saved.snapshotIndex++; persist(); }
    return { term: saved.term, index: saved.snapshotIndex, checksum, files };
  };
  const applySnapshot = async snapshot => {
    if (!snapshot || snapshot.term < saved.term || snapshot.index <= saved.snapshotIndex) return false;
    if (crypto.createHash('sha256').update(JSON.stringify(snapshot.files || {})).digest('hex') !== snapshot.checksum) throw new Error('集群快照校验失败');
    for (const [name, content] of Object.entries(snapshot.files || {})) { if (!syncNames.includes(name) || typeof content !== 'string') throw new Error('集群快照文件无效'); JSON.parse(content); }
    for (const [name, content] of Object.entries(snapshot.files || {})) { const tmp = path.join(dir, name + '.cluster.tmp'); fs.writeFileSync(tmp, content, { mode: 0o600 }); fs.renameSync(tmp, path.join(dir, name)); }
    saved.snapshotIndex = snapshot.index; snapshotChecksum = snapshot.checksum; persist(); await gateway.reload?.(); return true;
  };
  const persist = () => atomic(stateFile, saved);
  const gatewayStop = async () => { if (role === 'leader') role = 'fenced'; leaseUntil = 0; clearTimeout(leaseTimer); await gateway.stop(); };
  const resetElection = () => { clearTimeout(timer); if (stopped || self.witness) return; const delay = electionMinMs + Math.floor(random() * electionMinMs); timer = setTimeout(campaign, delay); timer.unref?.(); };
  const validLeader = () => !stopped && role === 'leader' && monotonicNow() < leaseUntil;
  const watchLease = () => {
    clearTimeout(leaseTimer);
    const term = saved.term;
    leaseTimer = setTimeout(async () => {
      if (stopped || role !== 'leader' || term !== saved.term) return;
      if (monotonicNow() < leaseUntil) return watchLease();
      try { await gatewayStop(); } catch (error) { log.warn?.('网关租约失效：' + error.message); }
      if (saved.term === term && role === 'fenced') { role = 'follower'; leaderId = ''; resetElection(); }
    }, Math.max(1, leaseUntil - monotonicNow()));
    leaseTimer.unref?.();
  };
  const observeTerm = async term => {
    if (!(term > saved.term)) return false;
    saved.term = term; saved.votedFor = ''; persist();
    await gatewayStop(); role = self.witness ? 'witness' : 'follower'; leaderId = ''; resetElection();
    return true;
  };
  async function heartbeatRound() {
    if (stopped || role !== 'leader' || heartbeatBusy) return;
    heartbeatBusy = true;
    const roundTerm = saved.term, startedAt = monotonicNow();
    try {
    const snapshot = localSnapshot();
    const message = { term: saved.term, leaderId: config.nodeId, leaseMs, snapshotIndex: saved.snapshotIndex, gateway: gatewayPhase() };
    const results = await network.broadcast('cluster.heartbeat', message, { timeout: Math.min(heartbeatMs, 1000) });
    const higher = Math.max(saved.term, ...results.filter(r => r.status === 'fulfilled').map(r => Number(r.value.value?.term) || 0));
    if (await observeTerm(higher) || stopped || role !== 'leader' || saved.term !== roundTerm) return;
    let acks = 1;
    for (const result of results) if (result.status === 'fulfilled' && result.value.value?.term === saved.term && result.value.value.accepted !== false && voters.some(v => v.id === result.value.id)) { acks++; peerReports.set(result.value.id, { gateway: result.value.value.gateway, at: now() }); if ((result.value.value.snapshotIndex || 0) < snapshot.index) network.call(result.value.id, 'cluster.snapshot', snapshot, { timeout: 3000 }).catch(() => {}); }
    if (acks >= quorum) {
      leaseUntil = startedAt + leaseMs;
      if (monotonicNow() >= leaseUntil) { await gatewayStop(); role = 'follower'; resetElection(); return; }
      role = 'leader'; watchLease();
      Promise.resolve().then(() => { if (validLeader()) return gateway.start(); }).catch(e => log.warn?.('飞书 Leader 启动失败：' + e.message));
    } else if (monotonicNow() >= leaseUntil) { await gatewayStop(); role = 'follower'; leaderId = ''; resetElection(); }
    } finally { heartbeatBusy = false; }
  }
  async function campaign() {
    if (stopped || self.witness || campaigning) return;
    campaigning = true;
    // A stale rejoining member must not keep increasing everyone else's term.
    const preliminary = await network.broadcast('cluster.preVote', { candidateId: config.nodeId, snapshotIndex: saved.snapshotIndex }, { timeout: 1000 });
    const peerTerm = Math.max(saved.term, ...preliminary.filter(item => item.status === 'fulfilled').map(item => Number(item.value.value?.term) || 0));
    if (await observeTerm(peerTerm) || stopped) { campaigning = false; return; }
    if (1 + preliminary.filter(item => item.status === 'fulfilled' && item.value.value?.granted && voters.some(v => v.id === item.value.id)).length < quorum) { campaigning = false; resetElection(); return; }
    role = 'candidate'; leaderId = ''; saved.term++; saved.votedFor = config.nodeId; persist();
    const electionTerm = saved.term;
    const results = await network.broadcast('cluster.requestVote', { term: saved.term, candidateId: config.nodeId, snapshotIndex: saved.snapshotIndex }, { timeout: 1000 });
    const higher = Math.max(saved.term, ...results.filter(r => r.status === 'fulfilled').map(r => Number(r.value.value?.term) || 0));
    if (await observeTerm(higher) || stopped || role !== 'candidate' || saved.term !== electionTerm) { campaigning = false; return; }
    let votes = 1;
    for (const result of results) if (result.status === 'fulfilled' && result.value.value?.term === electionTerm && result.value.value?.granted && voters.some(v => v.id === result.value.id)) votes++;
    if (votes >= quorum) { role = 'leader'; leaderId = config.nodeId; leaseUntil = 0; clearInterval(heartbeat); heartbeat = setInterval(heartbeatRound, heartbeatMs); heartbeat.unref?.(); await heartbeatRound(); }
    else { role = 'follower'; resetElection(); }
    campaigning = false;
  }
  network.handle('cluster.preVote', (_, request) => ({ term: saved.term, granted: !validLeader() && !(leaderId && monotonicNow() - lastLeaderAt < leaseMs) && voters.some(item => item.id === request.candidateId && !item.witness) && request.snapshotIndex >= saved.snapshotIndex }));
  network.handle('cluster.requestVote', async (_, request) => {
    if (!voters.some(item => item.id === request.candidateId) || request.term < saved.term) return { term: saved.term, granted: false };
    await observeTerm(request.term);
    if (request.snapshotIndex < saved.snapshotIndex) return { term: saved.term, granted: false, reason: 'snapshot_behind' };
    const granted = !saved.votedFor || saved.votedFor === request.candidateId;
    if (granted) { saved.votedFor = request.candidateId; persist(); lastLeaderAt = monotonicNow(); resetElection(); }
    return { term: saved.term, granted };
  });
  network.handle('cluster.heartbeat', async (_, request) => {
    if (request.term < saved.term) return { term: saved.term, accepted: false };
    if (request.term > saved.term || role === 'leader' && request.leaderId !== config.nodeId) { saved.term = request.term; saved.votedFor = ''; persist(); await gatewayStop(); }
    peerReports.set(request.leaderId, { gateway: request.gateway, at: now() });
    leaderId = request.leaderId; role = self.witness ? 'witness' : 'follower'; lastLeaderAt = monotonicNow(); resetElection();
    return { term: saved.term, accepted: true, snapshotIndex: saved.snapshotIndex, gateway: gatewayPhase() };
  });
  network.handle('cluster.snapshot', async (from, snapshot) => ({ term: saved.term, applied: from === leaderId && role !== 'leader' && snapshot.term === saved.term ? await applySnapshot(snapshot) : false, snapshotIndex: saved.snapshotIndex }));
  network.handle('cluster.transfer', async (_, request) => {
    if (request.target !== config.nodeId || self.witness) return { accepted: false };
    if (request.term >= saved.term) { saved.term = request.term; saved.votedFor = ''; persist(); setTimeout(campaign, 10); }
    return { accepted: true };
  });
  network.handle('cluster.move', (_, request) => { if (!validLeader()) throw new Error('当前节点没有有效主节点租约'); return transfer(request.target); });
  async function transfer(target) {
    if (!validLeader()) { if (leaderId && monotonicNow() - lastLeaderAt < leaseMs) return network.call(leaderId, 'cluster.move', { target }, { timeout: 5000 }); throw Object.assign(new Error('当前没有已确认的主节点，请先恢复集群通信'), { status: 409 }); }
    if (!canTransfer()) throw Object.assign(new Error('存在运行中的任务，请等待任务完成后移交 IM 主节点'), { status: 409 });
    const member = members.find(item => item.id === target && !item.witness);
    if (!member) throw new Error('目标节点不存在或不能承载网关');
    if (target === config.nodeId) return status();
    const result = await network.call(target, 'cluster.transfer', { target, term: saved.term + 1 }, { timeout: 3000 });
    if (!result.accepted) throw new Error('目标节点拒绝接管');
    preferred = target; await gatewayStop(); role = 'follower'; resetElection(); return status();
  }
  function status() {
    const online = new Set([config.nodeId, ...network.connected()]);
    const hasQuorum = validLeader() || !!leaderId && monotonicNow() - lastLeaderAt < leaseMs;
    const leader = validLeader() ? config.nodeId : hasQuorum ? leaderId : '';
    const onlineVoters = voters.filter(item => online.has(item.id)).length;
    return { enabled: true, clusterId: config.clusterId, nodeId: config.nodeId, role, leader, term: saved.term,
      health: { status: hasQuorum && leader ? 'healthy' : 'unhealthy', reason: hasQuorum ? '' : onlineVoters < quorum ? '成员连接不足，无法取得多数派确认' : '成员可达，但尚未取得有效主节点租约；检查投票与同步状态' },
      diagnostics: network.status?.() || [], snapshotIndex: saved.snapshotIndex,
      quorum: { online: onlineVoters, required: quorum, total: voters.length, reachable: onlineVoters >= quorum, met: hasQuorum }, voters: voters.length, online: online.size, hasQuorum,
      lease: { remainingMs: Math.max(0, leaseUntil - monotonicNow()), expiresAt: leaseUntil ? now() + Math.max(0, leaseUntil - monotonicNow()) : 0, valid: validLeader(), clock: 'monotonic' }, leaseUntil: leaseUntil ? now() + Math.max(0, leaseUntil - monotonicNow()) : 0, preferred,
      replication: { mode: 'async-snapshot', committedLog: false },
      automaticFailover: { enabled: voters.length >= 3, ready: voters.length >= 3 && hasQuorum, warning: voters.length < 3 ? '两个投票成员没有独立 witness 时不会自动接管，以避免网络分区双主。' : '' },
      members: members.map(item => ({ ...item, online: online.has(item.id), role: item.id === leader || validLeader() && item.id === config.nodeId ? 'leader' : item.witness ? 'witness' : 'follower', gatewayStatus: item.id === config.nodeId ? gatewayPhase() : !online.has(item.id) ? 'unknown' : peerReports.get(item.id)?.gateway || 'unknown' })) };
  }
  async function start() { stopped = false; network.start(); await gateway.stop(); resetElection(); }
  async function stop() { stopped = true; clearTimeout(timer); clearTimeout(leaseTimer); clearInterval(heartbeat); network.stop(); await gateway.stop(); }
  return { start, stop, status, transfer, campaign, canStart: validLeader };
}
function createStandalone(gateway) { return { start: () => gateway.start(), stop: () => gateway.stop(), status: () => ({ enabled: false, role: 'leader', leader: 'local', automaticFailover: false, members: [] }), transfer: async () => { throw new Error('未配置集群'); }, canStart: () => true }; }
module.exports = { createCluster, createStandalone };
