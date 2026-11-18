// Keeps Feishu answering. On the IM leader, every interval it checks that every bot is connected
// (reconnecting the ones that are not) and that machines bound to conversations can execute.
// Problems that persist across two checks are reported to the owner from any bot that is still
// connected; recovery is reported once. Feishu does not deliver bot-sent messages to other bots,
// so this checks each link of the path instead of a synthetic chat round trip.
function createImWatchdog({ bots, leadership = () => true, machines = () => [], boundMachines = () => [], owner = () => '', intervalMs = 2 * 60 * 1000, now = Date.now, log = console }) {
  let timer = null, streak = new Map(), alerted = new Set(), last = { at: 0, problems: [] };
  async function check() {
    if (!leadership()) return last = { at: now(), problems: [], skipped: true };
    const problems = [];
    for (const bot of bots.bots()) {
      if (!bot.enabled || bot.phase === 'connected') continue;
      try { await bots.bot(bot.appId)?.start(); } catch {}
      const after = bots.bots().find(item => item.appId === bot.appId);
      if (after?.phase !== 'connected') problems.push({ key: 'bot:' + bot.appId, text: `机器人 ${bot.appId} 未连接（${after?.lastError || after?.phase || '未知'}），已尝试重连` });
    }
    const online = new Map(machines().map(item => [item.id, item]));
    for (const id of new Set(boundMachines())) {
      const machine = online.get(id);
      if (machine && machine.online === false) problems.push({ key: 'machine:' + id, text: `执行机器「${machine.label || id}」${machine.panelOnline ? '执行连接中断' : '离线'}，绑定在它上面的会话会等待重连或自动换到其他机器` });
    }
    const keys = new Set(problems.map(item => item.key));
    for (const key of [...streak.keys()]) if (!keys.has(key)) streak.delete(key);
    for (const item of problems) streak.set(item.key, (streak.get(item.key) || 0) + 1);
    const fresh = problems.filter(item => streak.get(item.key) >= 2 && !alerted.has(item.key));
    const recovered = [...alerted].filter(key => !keys.has(key));
    if (fresh.length || recovered.length) {
      const lines = [...fresh.map(item => '⚠️ ' + item.text), ...recovered.map(key => '✅ 已恢复：' + key.replace(/^bot:/, '机器人 ').replace(/^machine:/, '执行机器 '))];
      if (await notify(['**my-agents 飞书健康检查**', ...lines].join('\n'))) { fresh.forEach(item => alerted.add(item.key)); recovered.forEach(key => alerted.delete(key)); }
    }
    return last = { at: now(), problems };
  }
  async function notify(text) {
    const to = owner(); if (!to) return false;
    for (const bot of bots.bots().filter(item => item.phase === 'connected').sort((a, b) => Number(b.primary) - Number(a.primary))) {
      try { await bots.bot(bot.appId).notify(to, text); return true; } catch (error) { log.warn?.('健康提醒发送失败：' + error.message); }
    }
    return false;
  }
  return {
    check, status: () => last,
    start() { if (timer) return; timer = setInterval(() => check().catch(error => log.warn?.('飞书健康检查失败：' + error.message)), intervalMs); timer.unref?.(); },
    stop() { clearInterval(timer); timer = null; },
  };
}
module.exports = { createImWatchdog };
