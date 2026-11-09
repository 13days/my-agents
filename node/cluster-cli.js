const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const file = () => path.join(process.env.MY_AGENTS_HOME || path.join(os.homedir(), '.my-agents'), 'panel-cluster.json');
const value = (argv, name, fallback = '') => { const i = argv.indexOf(name); return i < 0 ? fallback : argv[i + 1]; };
const save = config => {
  fs.mkdirSync(path.dirname(file()), { recursive: true, mode: 0o700 });
  const target = file(), temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, target);
};
function validate(config) {
  if (!config || typeof config.clusterId !== 'string' || !config.clusterId || typeof config.nodeId !== 'string' || !config.nodeId || !/^[a-f0-9]{64}$/.test(config.token || '') || !Array.isArray(config.members) || !config.members.some(item => item.id === config.nodeId)) throw new Error('集群加入内容无效');
  const ids = new Set();
  for (const member of config.members) {
    if (!member || typeof member.id !== 'string' || !/^[\w.-]{1,64}$/.test(member.id) || ids.has(member.id)) throw new Error('集群成员 ID 无效或重复');
    ids.add(member.id);
    let url; try { url = new URL(member.url); } catch { throw new Error('集群成员 URL 无效'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('集群成员 URL 必须使用 http 或 https');
  }
  return config;
}
function run(argv, { out = console, input = null } = {}) {
  const command = argv[0];
  if (command === 'init') {
    const id = value(argv, '--id', os.hostname().split('.')[0]), url = value(argv, '--url');
    if (!url) throw new Error('请用 --url 指定其他节点可访问的本机面板地址');
    const config = { clusterId: crypto.randomUUID(), nodeId: id, token: crypto.randomBytes(32).toString('hex'), members: [{ id, label: id, url, voter: true }] };
    save(config); out.log(`集群已初始化：${config.clusterId}\n重启 my-agents 后生效。`); return config;
  }
  if (command === 'add') {
    const config = JSON.parse(fs.readFileSync(file(), 'utf8'));
    const id = value(argv, '--id'), url = value(argv, '--url'), witness = argv.includes('--witness');
    if (!id || !url || config.members.some(item => item.id === id)) throw new Error('请提供唯一的 --id 和 --url');
    config.members.push({ id, label: value(argv, '--label', id), url, voter: true, ...(witness ? { witness: true } : {}) }); save(config);
    const joined = { ...config, nodeId: id }, payload = Buffer.from(JSON.stringify(joined)).toString('base64url');
    out.log(`在新节点运行：\nmy-agents cluster join '${payload}'${witness ? '\nmy-agents witness' : ''}\n\n现有成员需同步最新成员配置并重启；面板会显示未更新节点。`); return joined;
  }
  if (command === 'join') {
    let source;
    if (argv[1] === '--stdin') {
      source = input === null ? fs.readFileSync(0, 'utf8') : String(input);
      if (Buffer.byteLength(source) > 1024 * 1024) throw new Error('集群加入内容过大');
    } else {
      const payload = argv[1]; if (!payload) throw new Error('缺少一次性加入内容');
      source = Buffer.from(payload, 'base64url').toString('utf8');
    }
    const config = validate(JSON.parse(source));
    try { const current = JSON.parse(fs.readFileSync(file(), 'utf8')); if (current.clusterId && current.clusterId !== config.clusterId && !argv.includes('--force')) throw new Error('本机已属于另一个集群；确认替换时请加 --force'); } catch (error) { if (error.code !== 'ENOENT' && !error.message.includes('Unexpected')) throw error; }
    save(config); out.log(`已加入集群 ${config.clusterId}，本机节点 ${config.nodeId}。重启 my-agents 后生效。`); return config;
  }
  if (command === 'status') { const config = JSON.parse(fs.readFileSync(file(), 'utf8')); out.log(JSON.stringify(config, null, 2)); return config; }
  throw new Error('用法：my-agents cluster init --id <id> --url <url> | add --id <id> --url <url> [--witness] | join <内容>|--stdin [--force] | status');
}
module.exports = { run };
