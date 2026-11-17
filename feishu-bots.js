const fs = require('fs'), path = require('path');
const { createFeishuGateway } = require('./feishu-gateway');

// Several Feishu/Lark bots listen at once. The primary bot keeps the original files
// (panel-feishu.json / -state.json); each additional bot has its own
// panel-feishu-bot-<appId>.json and -state.json beside them (replicated by the cluster)
// and a private inbox directory. Every bot has its own access rules, pairing and topic
// bindings, so adding one never replaces another.
const BOT_FILE = /^panel-feishu-bot-(cli_[\w-]{4,100})\.json$/;
const botFiles = appId => ({ config: `panel-feishu-bot-${appId}.json`, state: `panel-feishu-bot-${appId}-state.json` });
// Settings a new bot inherits from the primary one; app-scoped ids (open_id) are not portable.
const INHERITED = ['defaultProject', 'defaultMachine', 'defaultEngine', 'worktree', 'model', 'models', 'allowAllGroups', 'allowedChatIds'];

function createFeishuBots({ dir, create = createFeishuGateway, ...options }) {
  const primary = create({ dir, ...options });
  const extras = new Map();
  // Extra bots must not toggle machine-wide runtime settings owned by the primary bot.
  const quietRuntime = { ...options.runtime, keepAwake() {}, nativeAutoAccept() {} };
  const open = appId => {
    let gateway = extras.get(appId);
    if (!gateway) { gateway = create({ dir, ...options, runtime: quietRuntime, files: botFiles(appId), inboxDir: path.join(dir, 'feishu-bots', appId) }); extras.set(appId, gateway); }
    return gateway;
  };
  const discovered = () => { try { return fs.readdirSync(dir).map(name => name.match(BOT_FILE)?.[1]).filter(Boolean); } catch { return []; } };
  const all = () => [primary, ...extras.values()];
  const primaryApp = () => primary.status().config.appId;
  const find = appId => !appId || appId === primaryApp() ? primary : extras.get(appId);
  async function each(fn) {
    // An additional bot failing to connect must not take the primary bot down with it.
    const results = await Promise.allSettled(all().map(fn));
    if (results[0].status === 'rejected') throw results[0].reason;
  }
  async function syncExtras() {
    const present = new Set(discovered());
    for (const appId of present) open(appId);
    for (const [appId, gateway] of extras) if (!present.has(appId)) { extras.delete(appId); await gateway.stop().catch(() => {}); }
  }
  syncExtras();
  function bots() {
    return all().map((gateway, index) => {
      const { phase, lastError, config } = gateway.status();
      return { appId: config.appId, domain: config.domain, enabled: !!config.enabled, phase, lastError: lastError || '', primary: index === 0, users: (config.allowedUserIds || []).length, cardCallbacksReady: !!config.cardCallbacksReady };
    }).filter(bot => bot.appId);
  }
  // Configure the primary bot, or add/update an additional one: a different app never replaces the primary.
  async function addOrConfigure(input) {
    if (!primaryApp() || input.appId === primaryApp()) return primary.configure(input);
    if (!/^cli_[\w-]{4,100}$/.test(input.appId || '')) throw new Error('应用 ID 无效');
    const fresh = !extras.has(input.appId);
    const gateway = open(input.appId);
    if (fresh) {
      const base = primary.status().config, inherited = Object.fromEntries(INHERITED.filter(key => base[key] !== undefined).map(key => [key, base[key]]));
      return gateway.configure({ ...inherited, ...input });
    }
    return gateway.configure(input);
  }
  async function removeBot(appId) {
    const gateway = extras.get(appId);
    if (!gateway) throw new Error(appId === primaryApp() ? '主机器人不能在这里移除' : '机器人不存在');
    extras.delete(appId); await gateway.stop().catch(() => {});
    for (const name of Object.values(botFiles(appId))) fs.rmSync(path.join(dir, name), { force: true });
    return status();
  }
  function status() { return { ...primary.status(), bots: bots() }; }
  return {
    ...primary,
    status, bots, addOrConfigure, removeBot,
    bot: appId => find(appId) || null,
    async start() { await syncExtras(); await each(gateway => gateway.start()); },
    async stop() { await Promise.allSettled(all().map(gateway => gateway.stop())); },
    async reload() { await syncExtras(); await Promise.allSettled([...extras.values()].map(gateway => gateway.reload())); return primary.reload().then(status); },
    async bootstrap() { await syncExtras(); await each(gateway => gateway.bootstrap()); },
    async sendReply(input) { return (all().find(gateway => gateway.hasReplyTarget?.(input?.token)) || primary).sendReply(input); },
    async welcome(openId, { appId, ...rest } = {}) { const gateway = find(appId); if (!gateway) throw new Error('机器人不存在'); return gateway.welcome(openId, rest); },
  };
}
module.exports = { createFeishuBots, botFiles, BOT_FILE };
