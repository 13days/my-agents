#!/usr/bin/env node
/**
 * my-agents — 管理个人 Claude 资源的本地面板服务
 * 零依赖，直接 `node server.js` 启动。
 *
 * 管理的资源：
 *   - 命令  ~/.claude/commands/<name>.md
 *   - Skill ~/.claude/skills/<name>/SKILL.md
 *   - Agent ~/.claude/agents/<name>.md
 */
// New names take precedence; legacy environment variables remain supported.
for (const suffix of ['NO_PROXY_SETUP', 'RC_FILE', 'CODEX_CAPTURE', 'CHAT_TIMEOUT_MS', 'BACKGROUND_SERVICE']) {
  const value = process.env['MY_AGENTS_' + suffix];
  if (value !== undefined) process.env['CCP_' + suffix] = value;
}
const { isMainThread, workerData, parentPort } = require('worker_threads');
const HISTORY_WORKER = !isMainThread && workerData?.myAgentsHistory;
const historyWorker = HISTORY_WORKER ? null : require('./history-worker').createHistoryWorker(__filename);
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { messageTimestamp, annotateMessageTimings } = require('./message-timing');
const crypto = require('crypto');
const { chooseFolder } = require('./folder-picker');
const { createSessionStore, normalizeTitle, isManualTitle, autoTitlePatch } = require('./session-store');
const { createCaptureStore } = require('./capture-store');
const { resolveCodex } = require('./engines/codex/cli');
const { resolveClaude } = require('./engines/claude/cli');
const { createCodexSessions } = require('./engines/codex/sessions');
const { createRegistry } = require('./core/registry');
const { createSessionManager } = require('./core/session-manager');
const { createLocalHost } = require('./hosts/local');
const { createClaudeEngine, accountRouteEnv } = require('./engines/claude');
const { createCodexEngine } = require('./engines/codex');
const { createUpstreams } = require('./core/upstreams');
const { createCodexProxy, codexProviderConfig, codexCredentials, RELAY_TOKEN_ENV, extractResponses, isCodexPath } = require('./engines/codex/proxy');
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const codexSessions = createCodexSessions({ home: CODEX_HOME });
const codexStats = require('./engines/codex/stats').createCodexStats({ home: CODEX_HOME });
const codexResources = require('./engines/codex/resources').createCodexResources({ home: CODEX_HOME, agentsHome: process.env.AGENTS_HOME || path.join(os.homedir(), '.agents'), summarize, parseFrontmatter });
let folderPickerBusy = false;

const PORT = process.env.PORT || 4321;
const PROXY_PORT = process.env.PROXY_PORT || Number(PORT) + 1;

// ---------- CLI 子命令：把 Inspector 代理装进 shell ----------
// 写入一个 claude() 包装函数：调用时探测代理端口，通了才走代理、不通就直连，
// 保证面板没开时 Claude Code 照常工作（不会因指向死端口而失败）。
const RC_START = '# >>> my-agents >>>';
const RC_END = '# <<< my-agents <<<';
const LEGACY_RC_START = '# >>> claude-code-panel >>>';
const LEGACY_RC_END = '# <<< claude-code-panel <<<';

// 覆盖所有 shell：返回所有应当写入的 rc 文件（已存在的，加上当前 shell 的默认文件）
function detectRcFiles() {
  if (process.env.CCP_RC_FILE) return process.env.CCP_RC_FILE.split(',').filter(Boolean); // 测试用
  const home = os.homedir();
  const targets = new Set();
  // 各 shell 的候选 rc；存在即写
  const candidates = [
    '.zshrc', '.zprofile',        // zsh（macOS 默认）
    '.bashrc', '.bash_profile',   // bash
    '.profile',                   // POSIX sh / 登录 shell 通吃
    '.config/fish/config.fish',   // fish
  ];
  for (const rel of candidates) {
    const p = path.join(home, rel);
    if (fs.existsSync(p)) targets.add(p);
  }
  // 保底：当前 $SHELL 的主 rc 即使还不存在也创建
  const shell = path.basename(process.env.SHELL || 'zsh');
  if (shell === 'bash') targets.add(path.join(home, '.bashrc'));
  else if (shell === 'fish') targets.add(path.join(home, '.config/fish/config.fish'));
  else targets.add(path.join(home, '.zshrc'));
  return [...targets];
}

function proxyBlock(rcFile) {
  const url = `http://127.0.0.1:${PROXY_PORT}`;
  if (rcFile.endsWith('config.fish')) {
    return `${RC_START}
# Routes \`claude\` through the local inspector proxy when the panel is running.
# Remove with: npx my-agents uninstall-proxy
function claude
    set -l my_agents_cli "$CLAUDE_CLI"
    if test -z "$my_agents_cli"
        set -l my_agents_prefix (command npm prefix --global 2>/dev/null)
        if test -n "$my_agents_prefix"; and test -x "$my_agents_prefix/bin/claude"
            set my_agents_cli "$my_agents_prefix/bin/claude"
        else
            set my_agents_cli claude
        end
    end
    if test -z "$ANTHROPIC_BASE_URL"; and nc -z 127.0.0.1 ${PROXY_PORT} 2>/dev/null
        ANTHROPIC_BASE_URL=${url} command "$my_agents_cli" $argv
    else
        command "$my_agents_cli" $argv
    end
end
${RC_END}`;
  }
  return `${RC_START}
# Routes \`claude\` through the local inspector proxy when the panel is running.
# Falls back to a direct connection when the panel is off. Remove with: npx my-agents uninstall-proxy
claude() (
  my_agents_cli="$CLAUDE_CLI"
  if [ -z "$my_agents_cli" ]; then
    my_agents_prefix="$(command npm prefix --global 2>/dev/null)"
    if [ -n "$my_agents_prefix" ] && [ -x "$my_agents_prefix/bin/claude" ]; then
      my_agents_cli="$my_agents_prefix/bin/claude"
    else
      my_agents_cli=claude
    fi
  fi
  if [ -z "$ANTHROPIC_BASE_URL" ] && command -v nc >/dev/null 2>&1 && nc -z 127.0.0.1 ${PROXY_PORT} 2>/dev/null; then
    ANTHROPIC_BASE_URL="${url}" command "$my_agents_cli" "$@"
  else
    command "$my_agents_cli" "$@"
  fi
)
${RC_END}`;
}

const rcEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function installProxy() {
  const files = detectRcFiles();
  const re = new RegExp('(?:' + rcEsc(RC_START) + '[\\s\\S]*?' + rcEsc(RC_END) + '|' + rcEsc(LEGACY_RC_START) + '[\\s\\S]*?' + rcEsc(LEGACY_RC_END) + ')', 'g');
  const done = [];
  for (const rc of files) {
    let content = '';
    try { content = fs.readFileSync(rc, 'utf8'); } catch {}
    const block = proxyBlock(rc);
    let next, action;
    if (re.test(content)) {
      let first = true;
      next = content.replace(re, () => { if (!first) return ''; first = false; return block; }); action = 'updated';
    } else {
      if (content) { try { fs.writeFileSync(rc + '.my-agents-bak', content); } catch {} }
      next = content + (content && !content.endsWith('\n') ? '\n' : '') + '\n' + block + '\n';
      action = 'installed';
    }
    try {
      fs.mkdirSync(path.dirname(rc), { recursive: true });
      fs.writeFileSync(rc, next);
      done.push(`  ${action === 'updated' ? '↻' : '+'} ${rc}`);
    } catch (e) { done.push(`  ✗ ${rc} (${e.message})`); }
  }
  console.log(`✅ Inspector proxy set up in ${done.length} shell file(s):`);
  console.log(done.join('\n'));
  console.log(`\n   \`claude\` now routes through http://127.0.0.1:${PROXY_PORT} whenever the panel is running,`);
  console.log(`   and connects directly when it's off — no breakage either way.`);
  const primary = files.find(f => f.endsWith('.zshrc')) || files.find(f => f.endsWith('.bashrc')) || files[0];
  console.log(`\n   ⚠ 已开着的终端不会自动生效（外部进程无法改你当前 shell）。二选一：`);
  console.log(`     · 开一个新终端窗口，或`);
  console.log(`     · 在要用 claude 的终端里执行:  source ${primary}`);
  console.log(`   然后 \`type claude\` 显示 "shell function" 即已生效。`);
}

function uninstallProxy() {
  const files = detectRcFiles();
  const re = new RegExp('\\n*(?:' + rcEsc(RC_START) + '[\\s\\S]*?' + rcEsc(RC_END) + '|' + rcEsc(LEGACY_RC_START) + '[\\s\\S]*?' + rcEsc(LEGACY_RC_END) + ')\\n*', 'g');
  let n = 0;
  for (const rc of files) {
    let content = '';
    try { content = fs.readFileSync(rc, 'utf8'); } catch { continue; }
    if (!re.test(content)) continue;
    fs.writeFileSync(rc, content.replace(re, '\n'));
    console.log(`  − ${rc}`);
    n++;
  }
  console.log(n ? `✅ Removed proxy block from ${n} file(s). Open a new terminal to apply.` : 'ℹ No my-agents block found.');
}

// 代理钩子是否已写进任一 shell rc
function isProxyHookInstalled() {
  return detectRcFiles().some(rc => {
    try { const text = fs.readFileSync(rc, 'utf8'); return text.includes(RC_START) || text.includes(LEGACY_RC_START); } catch { return false; }
  });
}

// 启动时自动接入 shell（幂等）：没装过才装，装过跳过；CCP_NO_PROXY_SETUP=1 可关闭
function ensureProxyInstalled() {
  if (process.env.CCP_NO_PROXY_SETUP) return;
  if (isProxyHookInstalled()) return;
  console.log('⚙️  首次启动：正在把 `claude` 接入 Inspector 代理（面板开着才走代理，关了自动直连）…');
  try { installProxy(); } catch (e) { console.log('   （自动接入失败，可手动运行 install-proxy：' + e.message + '）'); }
  console.log('   不想自动接入？设 CCP_NO_PROXY_SETUP=1 启动，或运行 uninstall-proxy 移除。');
}

const CLI_CMD = process.argv[2];
// `my-agents node …` runs only the remote node daemon, never the panel.
if (CLI_CMD === 'node') { require('./node/daemon').run(process.argv.slice(3)); return; }
if (CLI_CMD === 'cluster') { require('./node/cluster-cli').run(process.argv.slice(3)); return; }
if (CLI_CMD === 'witness') { require('./node/witness').run(process.argv.slice(3)); return; }
if (CLI_CMD === 'install-proxy') { installProxy(); process.exit(0); }
if (CLI_CMD === 'uninstall-proxy') { uninstallProxy(); process.exit(0); }
if (CLI_CMD === 'migrate-data') {
  const { resolveDataDir, migrateDataDir } = require('./core/data-dir');
  const from = process.env.CLAUDE_DIR || path.join(os.homedir(), '.claude'), current = resolveDataDir({ claudeDir: from });
  const to = current.legacy ? path.join(os.homedir(), '.my-agents') : current.dir;
  const { copied, skipped } = migrateDataDir({ from, to });
  console.log(`已复制 ${copied.length} 项到 ${to}${skipped.length ? `，${skipped.length} 项已存在未覆盖` : ''}。原文件保留在 ${from} 作为备份。`);
  console.log('请重启面板（含后台服务）以使用新目录；仍在运行的旧版面板会继续写旧目录。');
  process.exit(0);
}
if (CLI_CMD === '--help' || CLI_CMD === '-h') {
  console.log('my-agents            start the panel + inspector proxy');
  console.log('my-agents migrate-data     copy panel data from ~/.claude to ~/.my-agents (originals kept)');
  console.log('my-agents node --hub ws://<hub>:4321 --token <token>   serve this machine\'s engines to a hub');
  console.log('my-agents node --stdio     same, over stdio (the hub launches it via SSH)');
  console.log('my-agents cluster init|add|join|status    configure a panel cluster');
  console.log('my-agents witness          run a voter-only cluster witness');
  console.log('my-agents install-proxy    add a smart `claude` wrapper to your shell rc');
  console.log('my-agents uninstall-proxy  remove it');
  process.exit(0);
}
const CLAUDE_DIR = process.env.CLAUDE_DIR || path.join(os.homedir(), '.claude');
// The panel's own files; Claude's files (settings, transcripts) stay in CLAUDE_DIR.
const DATA_DIR = require('./core/data-dir').resolveDataDir({ claudeDir: CLAUDE_DIR }).dir;
const BIND_HOST = process.env.MY_AGENTS_BIND || '127.0.0.1';
const auth = HISTORY_WORKER ? null : require('./http/auth').createAuth({ port: PORT, bindHost: BIND_HOST, dir: DATA_DIR, publicHosts: (process.env.MY_AGENTS_PUBLIC_HOSTS || '').split(',').filter(Boolean) });
const sessionStore = createSessionStore(DATA_DIR);

const TYPES = {
  commands:  { dir: path.join(CLAUDE_DIR, 'commands'),  layout: 'flat', ext: '.md' },  // <name>.md
  skills:    { dir: path.join(CLAUDE_DIR, 'skills'),    layout: 'nested' },            // <name>/SKILL.md
  agents:    { dir: path.join(CLAUDE_DIR, 'agents'),    layout: 'flat', ext: '.md' },  // <name>.md
  workflows: { dir: path.join(CLAUDE_DIR, 'workflows'), layout: 'flat', ext: '.js' },  // <name>.js（Workflow 工具的命名工作流）
};

// ---------- i18n 框架 ----------
// 新增语言：在 STRINGS 里加一个语言字典即可（可以只翻译一部分，缺失的 key 自动回退 en → zh）。
// 前端 index.html 的 I18N/LANGS 同步加一份即可出现在下拉框里。
const DEFAULT_LANG = 'zh';
const STRINGS = {
  zh: {
    errInvalidName: '名称不合法（仅允许字母、数字、- _ .）',
    errExists: '同名资源已存在',
    errNotFound: '资源不存在',
    errContentStr: 'content 必须是字符串',
    errInstalledReadonly: '该资源由工具安装（软链接），不允许在面板中编辑',
    errCmdReadonly: '内置/插件命令不允许编辑',
    errCmdDelete: '内置命令不能删除；插件命令请用 /plugin 管理插件',
    errPluginOp: '插件不支持此操作，安装请在 Claude Code 里用 /plugin',
    errConfigOp: '配置文件只支持查看和编辑',
    errJson: 'JSON 格式错误: ',
    uninstallNote: '已从 installed_plugins.json 移除，缓存目录保留；重启 Claude Code 生效',
    builtinPath: '(Claude Code 内置命令，无磁盘文件)',
    builtinNote: '这是 Claude Code 程序内置的命令，不能在面板中编辑或删除。',
    unknownPath: '(未知路径)',
    missingDir: ' · ⚠ 安装目录缺失',
    brokenWarn: '⚠ 安装目录不存在，插件可能已损坏。',
    tblField: '字段', tblValue: '值', marketplace: '市场', version: '版本',
    installedAt: '安装时间', updated: '最近更新', installPath: '安装路径',
    secCommands: '提供的命令', secSkills: '提供的技能', secAgents: '提供的 Agents',
    unitCommands: '命令', unitSkills: '技能',
    cfgClaudeMdName: 'CLAUDE.md 全局指令', cfgClaudeMdDesc: '每次会话都会注入的全局说明（~/CLAUDE.md）',
    cfgClaudeDirName: 'CLAUDE.md（.claude 目录）', cfgClaudeDirDesc: '用户级记忆文件（~/.claude/CLAUDE.md）',
    cfgSettingsName: 'settings.json 设置与 Hooks', cfgSettingsDesc: '权限、hooks、环境变量等全局设置',
    cfgSettingsLocalDesc: '本机私有设置（不入库）',
    cfgKeybindName: 'keybindings.json 快捷键', cfgKeybindDesc: '自定义键位绑定',
    sesProject: '项目', sesTime: '时间范围', sesPromptCount: '提示词数量',
    sesTranscript: '完整记录', sesNoTranscript: '（记录文件不存在）',
    sesResume: '恢复此会话', sesPrompts: '提示词历史',
    cfgProjMdDesc: '项目级指令文件', cfgProjSettingsDesc: '项目级设置', cfgMemoryDesc: '项目记忆文件（~/.claude/projects/.../memory）',
    errQueryShort: '搜索词至少 2 个字符', errBadBundle: '不是有效的 my-agents 配置包',
    budgetNotify: '今日 Claude Code 已花费 ${cost}，超出预算 ${budget}！', cfgMergedName: '🧩 CLAUDE.md 合并视图',
    cfgMergedDesc: 'Claude 实际看到的全部指令（全局 + 项目各层合并）', cfgMergedPath: '(虚拟视图，只读)', cfgMergedEmpty: '没有找到任何 CLAUDE.md 文件',
  },
  en: {
    errInvalidName: 'Invalid name (only letters, digits, - _ . allowed)',
    errExists: 'An item with this name already exists',
    errNotFound: 'Not found',
    errContentStr: 'content must be a string',
    errInstalledReadonly: 'This item was installed by a tool (symlink) and cannot be edited here',
    errCmdReadonly: 'Built-in and plugin commands cannot be edited',
    errCmdDelete: 'Built-in commands cannot be deleted; manage plugin commands via /plugin',
    errPluginOp: 'Not supported for plugins; install via /plugin inside Claude Code',
    errConfigOp: 'Config files only support viewing and editing',
    errJson: 'Invalid JSON: ',
    uninstallNote: 'Removed from installed_plugins.json (cache kept). Restart Claude Code to take effect',
    builtinPath: '(built into Claude Code, no file on disk)',
    builtinNote: 'This command is built into Claude Code and cannot be edited or deleted here.',
    unknownPath: '(unknown path)',
    missingDir: ' · ⚠ install dir missing',
    brokenWarn: '⚠ Install directory missing; the plugin may be broken.',
    tblField: 'Field', tblValue: 'Value', marketplace: 'Marketplace', version: 'Version',
    installedAt: 'Installed', updated: 'Updated', installPath: 'Install path',
    secCommands: 'Commands', secSkills: 'Skills', secAgents: 'Agents',
    unitCommands: 'commands', unitSkills: 'skills',
    cfgClaudeMdName: 'CLAUDE.md (global instructions)', cfgClaudeMdDesc: 'Global instructions injected into every session (~/CLAUDE.md)',
    cfgClaudeDirName: 'CLAUDE.md (.claude dir)', cfgClaudeDirDesc: 'User-level memory file (~/.claude/CLAUDE.md)',
    cfgSettingsName: 'settings.json (settings & hooks)', cfgSettingsDesc: 'Global settings: permissions, hooks, env vars',
    cfgSettingsLocalDesc: 'Machine-local settings (not checked in)',
    cfgKeybindName: 'keybindings.json (shortcuts)', cfgKeybindDesc: 'Custom key bindings',
    sesProject: 'Project', sesTime: 'Time range', sesPromptCount: 'Prompt count',
    sesTranscript: 'Transcript', sesNoTranscript: '(transcript file missing)',
    sesResume: 'Resume this session', sesPrompts: 'Prompt history',
    cfgProjMdDesc: 'Project-level instructions', cfgProjSettingsDesc: 'Project-level settings', cfgMemoryDesc: 'Project memory file (~/.claude/projects/.../memory)',
    errQueryShort: 'Query must be at least 2 characters', errBadBundle: 'Not a valid my-agents bundle',
    budgetNotify: 'Claude Code spent ${cost} today, over your ${budget} budget!', cfgMergedName: '🧩 CLAUDE.md merged view',
    cfgMergedDesc: 'Everything Claude actually sees (global + project layers merged)', cfgMergedPath: '(virtual view, read-only)', cfgMergedEmpty: 'No CLAUDE.md files found',
  },
  ja: {
    errInvalidName: '名前が無効です（英数字と - _ . のみ使用可能）',
    errExists: '同名のリソースが既に存在します',
    errNotFound: '見つかりません',
    errContentStr: 'content は文字列である必要があります',
    errInstalledReadonly: 'ツールによりインストールされたリソース（シンボリックリンク）のため編集できません',
    errCmdReadonly: '組み込み／プラグインコマンドは編集できません',
    errCmdDelete: '組み込みコマンドは削除できません。プラグインコマンドは /plugin で管理してください',
    errPluginOp: 'プラグインではこの操作はできません。インストールは Claude Code の /plugin で',
    errConfigOp: '設定ファイルは表示と編集のみサポートしています',
    errJson: 'JSON 形式エラー: ',
    uninstallNote: 'installed_plugins.json から削除しました（キャッシュは保持）。Claude Code の再起動後に反映されます',
    builtinPath: '（Claude Code 組み込みコマンド、ファイルなし）',
    builtinNote: 'これは Claude Code に組み込まれたコマンドで、ここでは編集・削除できません。',
    unknownPath: '（不明なパス）',
    missingDir: ' · ⚠ インストールディレクトリがありません',
    brokenWarn: '⚠ インストールディレクトリが存在しません。プラグインが破損している可能性があります。',
    tblField: '項目', tblValue: '値', marketplace: 'マーケット', version: 'バージョン',
    installedAt: 'インストール日', updated: '更新日', installPath: 'インストールパス',
    secCommands: '提供コマンド', secSkills: '提供スキル', secAgents: '提供エージェント',
    unitCommands: 'コマンド', unitSkills: 'スキル',
    cfgClaudeMdName: 'CLAUDE.md グローバル指示', cfgClaudeMdDesc: '毎セッションに注入されるグローバル指示（~/CLAUDE.md）',
    cfgClaudeDirName: 'CLAUDE.md（.claude ディレクトリ）', cfgClaudeDirDesc: 'ユーザーレベルのメモリファイル（~/.claude/CLAUDE.md）',
    cfgSettingsName: 'settings.json 設定と Hooks', cfgSettingsDesc: '権限・hooks・環境変数などのグローバル設定',
    cfgSettingsLocalDesc: 'ローカル専用設定（リポジトリ外）',
    cfgKeybindName: 'keybindings.json ショートカット', cfgKeybindDesc: 'カスタムキーバインド',
    sesProject: 'プロジェクト', sesTime: '期間', sesPromptCount: 'プロンプト数',
    sesTranscript: 'トランスクリプト', sesNoTranscript: '（記録ファイルなし）',
    sesResume: 'このセッションを再開', sesPrompts: 'プロンプト履歴',
    cfgProjMdDesc: 'プロジェクトレベルの指示ファイル', cfgProjSettingsDesc: 'プロジェクトレベルの設定', cfgMemoryDesc: 'プロジェクトメモリファイル（~/.claude/projects/.../memory）',
    errQueryShort: '検索語は2文字以上必要です', errBadBundle: '有効な my-agents バンドルではありません',
    budgetNotify: '本日 Claude Code で ${cost} 使用、予算 ${budget} を超過！', cfgMergedName: '🧩 CLAUDE.md 統合ビュー',
    cfgMergedDesc: 'Claude が実際に見る全指示（グローバル + プロジェクト各層を統合）', cfgMergedPath: '（仮想ビュー、読み取り専用）', cfgMergedEmpty: 'CLAUDE.md ファイルが見つかりません',
  },
};
const SUPPORTED_LANGS = Object.keys(STRINGS);
// 取字符串：当前语言 → en → 默认语言，逐级回退，翻译不全也能工作
function T(lang, key) {
  return STRINGS[lang]?.[key] ?? STRINGS.en[key] ?? STRINGS[DEFAULT_LANG][key] ?? key;
}

// Claude Code 内置斜杠命令（程序自带，磁盘上没有文件，只读展示）
// 描述按语言存放，缺失语言自动回退 en → zh；新增语言时给需要的条目补 ja/xx 字段即可
const BUILTINS = [
  ['add-dir', '添加额外的工作目录到当前会话', 'Add an additional working directory to the session'],
  ['agents', '管理 subagent（子代理）配置', 'Manage subagent configurations'],
  ['bug', '向 Anthropic 反馈 bug', 'Report a bug to Anthropic'],
  ['clear', '清空当前会话历史', 'Clear the current conversation history'],
  ['compact', '压缩会话上下文（可附带保留重点的说明）', 'Compact conversation context (optionally with focus instructions)'],
  ['config', '打开设置面板（主题、模型等）', 'Open the settings panel (theme, model, etc.)'],
  ['context', '查看当前上下文占用情况', 'Show current context usage'],
  ['cost', '查看当前会话的 token 花费统计', 'Show token cost statistics for the session'],
  ['doctor', '检查 Claude Code 安装的健康状态', 'Check the health of your Claude Code installation'],
  ['exit', '退出 Claude Code', 'Exit Claude Code'],
  ['export', '导出当前会话到文件或剪贴板', 'Export the conversation to a file or clipboard'],
  ['fast', '切换快速输出模式（Opus）', 'Toggle fast output mode (Opus)'],
  ['help', '查看帮助和可用命令', 'Show help and available commands'],
  ['hooks', '管理 hooks 配置', 'Manage hooks configuration'],
  ['ide', '连接 IDE（VS Code / JetBrains）', 'Connect to an IDE (VS Code / JetBrains)'],
  ['init', '初始化项目，生成 CLAUDE.md', 'Initialize the project and generate CLAUDE.md'],
  ['install-github-app', '安装 GitHub App 以支持 @claude 提及', 'Install the GitHub App for @claude mentions'],
  ['login', '登录 Anthropic 账号', 'Log in to your Anthropic account'],
  ['logout', '登出当前账号', 'Log out of the current account'],
  ['mcp', '管理 MCP 服务器连接', 'Manage MCP server connections'],
  ['memory', '编辑记忆文件（CLAUDE.md 等）', 'Edit memory files (CLAUDE.md, etc.)'],
  ['model', '切换/设置当前使用的模型', 'Switch or set the current model'],
  ['output-style', '设置输出风格', 'Set the output style'],
  ['permissions', '查看与管理工具权限', 'View and manage tool permissions'],
  ['pr-comments', '查看当前 PR 的评论', 'View comments on the current PR'],
  ['resume', '恢复历史会话', 'Resume a previous session'],
  ['review', '请求代码审查', 'Request a code review'],
  ['rewind', '回退会话与代码到之前的检查点', 'Rewind conversation and code to a checkpoint'],
  ['statusline', '配置终端底部状态栏', 'Configure the terminal status line'],
  ['status', '查看账号与系统状态', 'Show account and system status'],
  ['terminal-setup', '配置终端换行键绑定', 'Configure terminal newline key binding'],
  ['todos', '查看当前任务列表', 'Show the current todo list'],
  ['usage', '查看用量与限额', 'Show usage and limits'],
  ['vim', '切换 Vim 编辑模式', 'Toggle Vim editing mode'],
];
function builtinCommands(lang) {
  return BUILTINS.map(([name, zh, en]) => {
    const desc = { zh, en };
    return {
      name, description: desc[lang] ?? desc.en ?? desc.zh,
      origin: 'installed', source: 'builtin', key: 'b!' + name,
    };
  });
}

// 已安装插件提供的命令/技能（都会出现在 / 提示里），来自 installed_plugins.json
function listPluginCommands() {
  const manifest = path.join(CLAUDE_DIR, 'plugins', 'installed_plugins.json');
  const items = [];
  let plugins;
  try { plugins = JSON.parse(fs.readFileSync(manifest, 'utf8')).plugins || {}; } catch { return items; }
  for (const [fullName, installs] of Object.entries(plugins)) {
    const install = Array.isArray(installs) ? installs[0] : installs;
    if (!install || !install.installPath) continue;
    const pluginName = fullName.split('@')[0];
    // 插件的 commands/*.md
    const cmdDir = path.join(install.installPath, 'commands');
    if (fs.existsSync(cmdDir)) {
      for (const f of fs.readdirSync(cmdDir)) {
        if (!f.endsWith('.md')) continue;
        const content = fs.readFileSync(path.join(cmdDir, f), 'utf8');
        const name = f.replace(/\.md$/, '');
        items.push({ name, description: summarize(content), origin: 'installed', source: 'plugin:' + pluginName, key: `p!${pluginName}!c!${name}` });
      }
    }
    // 插件的 skills/*/SKILL.md（同样可通过 / 调用）
    const skillDir = path.join(install.installPath, 'skills');
    if (fs.existsSync(skillDir)) {
      for (const d of fs.readdirSync(skillDir)) {
        const fp = path.join(skillDir, d, 'SKILL.md');
        if (!fs.existsSync(fp)) continue;
        const content = fs.readFileSync(fp, 'utf8');
        items.push({ name: d, description: summarize(content), origin: 'installed', source: 'plugin:' + pluginName, key: `p!${pluginName}!s!${d}` });
      }
    }
  }
  return items;
}

// ---------- 插件专区 ----------
const PLUGIN_MANIFEST = path.join(CLAUDE_DIR, 'plugins', 'installed_plugins.json');

function readPluginManifest() {
  try { return JSON.parse(fs.readFileSync(PLUGIN_MANIFEST, 'utf8')); } catch { return { version: 2, plugins: {} }; }
}

function pluginContents(installPath) {
  const out = { commands: [], skills: [], agents: [] };
  const cmdDir = path.join(installPath, 'commands');
  if (fs.existsSync(cmdDir)) {
    for (const f of fs.readdirSync(cmdDir)) {
      if (!f.endsWith('.md')) continue;
      out.commands.push({ name: f.replace(/\.md$/, ''), description: summarize(fs.readFileSync(path.join(cmdDir, f), 'utf8')) });
    }
  }
  const skillDir = path.join(installPath, 'skills');
  if (fs.existsSync(skillDir)) {
    for (const d of fs.readdirSync(skillDir)) {
      const fp = path.join(skillDir, d, 'SKILL.md');
      if (fs.existsSync(fp)) out.skills.push({ name: d, description: summarize(fs.readFileSync(fp, 'utf8')) });
    }
  }
  const agentDir = path.join(installPath, 'agents');
  if (fs.existsSync(agentDir)) {
    for (const f of fs.readdirSync(agentDir)) {
      if (f.endsWith('.md')) out.agents.push({ name: f.replace(/\.md$/, ''), description: summarize(fs.readFileSync(path.join(agentDir, f), 'utf8')) });
    }
  }
  return out;
}

function pluginDescription(installPath) {
  try {
    const pj = path.join(installPath, '.claude-plugin', 'plugin.json');
    if (fs.existsSync(pj)) {
      const d = JSON.parse(fs.readFileSync(pj, 'utf8')).description;
      if (d) return d;
    }
    const readme = path.join(installPath, 'README.md');
    if (fs.existsSync(readme)) return summarize(fs.readFileSync(readme, 'utf8'));
  } catch {}
  return '';
}

function listPlugins(lang) {
  const { plugins } = readPluginManifest();
  return Object.entries(plugins).map(([fullName, installs]) => {
    const install = Array.isArray(installs) ? installs[0] : installs;
    const [name, marketplace] = fullName.split('@');
    const exists = install && install.installPath && fs.existsSync(install.installPath);
    const c = exists ? pluginContents(install.installPath) : { commands: [], skills: [], agents: [] };
    const parts = [];
    if (c.commands.length) parts.push(`${c.commands.length} ${T(lang, 'unitCommands')}`);
    if (c.skills.length) parts.push(`${c.skills.length} ${T(lang, 'unitSkills')}`);
    if (c.agents.length) parts.push(`${c.agents.length} agents`);
    return {
      name, key: fullName, origin: 'user', // 插件专区不参与自建/安装过滤
      description: `${marketplace} · v${install?.version || '?'}${parts.length ? ' · ' + parts.join(' / ') : ''}${exists ? '' : T(lang, 'missingDir')}`,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function pluginDetail(fullName, lang) {
  const { plugins } = readPluginManifest();
  const installs = plugins[fullName];
  if (!installs) return null;
  const install = Array.isArray(installs) ? installs[0] : installs;
  const [name, marketplace] = fullName.split('@');
  const ip = install.installPath || '';
  const exists = ip && fs.existsSync(ip);
  let md = `# ${name}\n\n`;
  md += `| ${T(lang, 'tblField')} | ${T(lang, 'tblValue')} |\n|---|---|\n`;
  md += `| ${T(lang, 'marketplace')} | ${marketplace} |\n| ${T(lang, 'version')} | ${install.version || '?'} |\n`;
  if (install.installedAt) md += `| ${T(lang, 'installedAt')} | ${install.installedAt.slice(0, 10)} |\n`;
  if (install.lastUpdated) md += `| ${T(lang, 'updated')} | ${install.lastUpdated.slice(0, 10)} |\n`;
  md += `| ${T(lang, 'installPath')} | \`${ip}\` |\n`;
  const desc = exists ? pluginDescription(ip) : '';
  if (desc) md += `\n${desc}\n`;
  if (exists) {
    const c = pluginContents(ip);
    for (const [sec, list, pre] of [['secCommands', c.commands, '/'], ['secSkills', c.skills, ''], ['secAgents', c.agents, '']]) {
      if (!list.length) continue;
      md += `\n## ${T(lang, sec)}（${list.length}）\n\n`;
      for (const x of list) md += `- \`${pre}${x.name}\` — ${x.description}\n`;
    }
  } else {
    md += `\n> ${T(lang, 'brokenWarn')}\n`;
  }
  return { name, path: ip || T(lang, 'unknownPath'), meta: {}, content: md, origin: 'installed', plugin: true };
}

// ---------- 项目 / 会话 / 统计 ----------
const HISTORY_FILE = path.join(CLAUDE_DIR, 'history.jsonl');
let _histCache = { mtime: -1, entries: [] };
function readHistory() {
  try {
    const st = fs.statSync(HISTORY_FILE);
    if (st.mtimeMs !== _histCache.mtime) {
      const entries = [];
      for (const line of fs.readFileSync(HISTORY_FILE, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { entries.push(JSON.parse(line)); } catch {}
      }
      _histCache = { mtime: st.mtimeMs, entries };
    }
  } catch { _histCache = { mtime: -1, entries: [] }; }
  return _histCache.entries;
}

// 从 history 提取真实项目路径（只保留磁盘上仍存在的目录）
function knownProjects() {
  const seen = new Set();
  for (const e of readHistory()) if (e.project) seen.add(e.project);
  for (const session of codexSessions.list()) if (session.project) seen.add(session.project);
  for (const meta of Object.values(sessionStore.read())) if (!meta.deleted && meta.project) seen.add(meta.project);
  return [...seen].filter(p => {
    try { return path.isAbsolute(p) && fs.statSync(p).isDirectory(); } catch { return false; }
  }).sort();
}

// 项目路径 → ~/.claude/projects/ 下的目录名
const encodeProject = p => p.replace(/[\/.]/g, '-');

// ---------- 航程 Voyage：把散乱的会话织成一条时间线 + 故事线 ----------
// 纯本地启发式，全部来自 history.jsonl（长期保留，比 transcript 完整）。
function voyageData() {
  const hasT = new Set([...transcriptFiles().sessionFiles].map(fp => path.basename(fp, '.jsonl')));
  const map = new Map();
  for (const e of readHistory()) {
    if (!e.sessionId || !e.timestamp) continue;
    let s = map.get(e.sessionId);
    if (!s) { s = { id: e.sessionId, project: e.project || '', title: e.display || '', prompts: 0, start: e.timestamp, end: e.timestamp }; map.set(e.sessionId, s); }
    s.prompts++;
    if (e.timestamp < s.start) { s.start = e.timestamp; if (e.display) s.title = e.display; }
    if (e.timestamp > s.end) s.end = e.timestamp;
  }
  const sessions = [...map.values()].sort((a, b) => a.start - b.start).map(s => ({
    id: s.id, proj: s.project ? s.project.split('/').pop() : '(unknown)',
    title: (s.title || s.id).slice(0, 120), prompts: s.prompts, start: s.start, end: s.end,
    hasTranscript: hasT.has(s.id),
  }));
  if (!sessions.length) return { span: null, totalSessions: 0, activeDays: 0, projects: [], days: [], storylines: [] };

  // 项目稳定配色（按首次出现顺序）
  const projOrder = [];
  for (const s of sessions) if (!projOrder.includes(s.proj)) projOrder.push(s.proj);

  // 时间之河：按天聚合
  const byDay = {};
  for (const s of sessions) {
    const d = localDay(new Date(s.start));
    (byDay[d] ||= { date: d, sessions: [] }).sessions.push({ id: s.id, proj: s.proj, title: s.title, prompts: s.prompts, hasTranscript: s.hasTranscript });
  }
  const days = Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date));

  // 故事线（航段）：同项目内按时间断点(>2天)切分成连续作业段
  const GAP = 2 * 86400e3;
  const byProj = {};
  for (const s of sessions) (byProj[s.proj] ||= []).push(s);
  const storylines = [];
  for (const [proj, list] of Object.entries(byProj)) {
    list.sort((a, b) => a.start - b.start);
    let leg = null;
    for (const s of list) {
      if (!leg || s.start - leg.end > GAP) { leg = { proj, sessions: [], start: s.start, end: s.end }; storylines.push(leg); }
      leg.sessions.push({ id: s.id, title: s.title, start: s.start, prompts: s.prompts, hasTranscript: s.hasTranscript });
      leg.end = Math.max(leg.end, s.end);
    }
  }
  for (const l of storylines) {
    l.sessionCount = l.sessions.length;
    l.promptCount = l.sessions.reduce((n, x) => n + x.prompts, 0);
    l.days = Math.max(1, Math.round((l.end - l.start) / 86400e3) + 1);
    l.from = localDay(new Date(l.start)); l.to = localDay(new Date(l.end));
    l.title = l.sessions[0].title; // 首程 = 这段航行的起点意图
  }
  storylines.sort((a, b) => b.end - a.end);

  return {
    span: { from: days[0].date, to: days[days.length - 1].date },
    totalSessions: sessions.length,
    activeDays: days.length,
    projects: projOrder,
    days,
    storylines: storylines.slice(0, 80),
  };
}

// 读 transcript 开头，取工作目录与第一条用户提问。
// `claude -p`（含面板里发起的对话）不写 history.jsonl，只能从 transcript 本身补齐项目与标题。
function transcriptHead(fp) {
  const head = { cwd: '', title: '' };
  let text = '';
  try {
    const fd = fs.openSync(fp, 'r');
    const buf = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    text = buf.toString('utf8', 0, n);
  } catch { return head; }
  for (const line of text.split('\n')) {
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (!head.cwd && d.cwd) head.cwd = d.cwd;
    if (!head.title && d.type === 'user' && !d.isMeta && d.message) {
      const t = transcriptUserText(d.message.content);
      if (t) head.title = t.replace(/\s+/g, ' ').slice(0, 200);
    }
    if (head.cwd && head.title) break;
  }
  return head;
}
// 用户消息里真正由人输入的文本（排除工具返回、命令回显等系统注入内容）
function transcriptUserText(content) {
  const text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.filter(b => b && b.type === 'text' && !(/^\[(?:my-agents|Claude Panel) 飞书发送上下文，本轮有效\]\n/.test(b.text || '') && /\[\/(?:my-agents|Claude Panel) 飞书发送上下文\]$/.test(b.text || ''))).map(b => b.text || '').join('\n') : '';
  const t = text.trim();
  if (/^\[Request interrupted by user(?: for tool use)?\]$/i.test(t)) return '';
  if (!t || /^<(command-|local-command|system-reminder|bash-|task-notification)/.test(t) || t.startsWith('Caveat:')) return '';
  return t;
}
const transcriptTitleCache = new Map();
function latestTranscriptPrompt(fp) {
  try {
    const st = fs.statSync(fp), cached = transcriptTitleCache.get(fp);
    if (cached?.mtime === st.mtimeMs && cached.size === st.size) return cached.value;
    let value = { title: '', at: 0 };
    const fd = fs.openSync(fp, 'r');
    try {
      for (let size = Math.min(65536, st.size); size; size = Math.min(size * 2, st.size)) {
        const start = st.size - size, buffer = Buffer.alloc(size);
        fs.readSync(fd, buffer, 0, size, start);
        const lines = buffer.toString('utf8').split('\n');
        for (let i = lines.length - 1; i >= (start ? 1 : 0); i--) {
          let d; try { d = JSON.parse(lines[i]); } catch { continue; }
          if (d.type !== 'user' || d.isMeta || d.isSidechain || !d.message) continue;
          const text = transcriptUserText(d.message.content);
          const hasImage = Array.isArray(d.message.content) && d.message.content.some(b => b.type === 'image');
          if (text || hasImage) { value = { title: normalizeTitle(text) || '图片对话', at: Date.parse(d.timestamp) || st.mtimeMs }; break; }
        }
        if (value.title || size === st.size) break;
      }
    } finally { fs.closeSync(fd); }
    transcriptTitleCache.set(fp, { mtime: st.mtimeMs, size: st.size, value }); return value;
  } catch { return { title: '', at: 0 }; }
}

const sessionMessageCache = new Map();
function pageSessionMessages(value, { before, limit = 80 } = {}) {
  const total = value.messages.length;
  const end = before === undefined ? total : Math.max(0, Math.min(total, Number(before) || 0));
  const start = limit === 0 ? 0 : Math.max(0, end - limit);
  return { ...value, messages: value.messages.slice(start, end), truncated: start > 0, historyBefore: start, messageCount: total };
}
// 会话对话内容，供面板里接续聊天时展示上文
function sessionMessages(id, options = {}) {
  if (isCodexSession(id)) {
    const value = codexSessions.messages(id);
    if (value) return pageSessionMessages(value, options);
  }
  const prompts = readHistory().filter(e => e.sessionId === id);
  let project = (prompts.find(e => e.project) || {}).project || '';
  let fp = project ? path.join(CLAUDE_DIR, 'projects', encodeProject(project), id + '.jsonl') : '';
  if (!fp || !fs.existsSync(fp)) fp = transcriptPathFor(id);
  if (!fp) {
    const meta = sessionStore.read()[id];
    return meta?.project && !meta.deleted ? { id, project: meta.project, messages: meta.initialPrompt ? [{ role: 'user', text: meta.initialPrompt }] : [], truncated: false } : null;
  }
  if (!project) project = transcriptHead(fp).cwd;
  const stat = fs.statSync(fp), revision = `${stat.mtimeMs}:${stat.size}`;
  const cached = sessionMessageCache.get(fp);
  if (cached?.revision === revision) return pageSessionMessages(cached.value, options);
  const messages = [];
  let lines = [];
  try { lines = fs.readFileSync(fp, 'utf8').split('\n'); } catch { return null; }
  const toolsById = new Map();
  for (const line of lines) {
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d.isSidechain || d.isMeta) continue;
    if (d.type === 'system' && d.subtype === 'turn_duration') {
      const last = messages.at(-1); const duration = d.durationMs ?? d.duration_ms;
      if (last?.role === 'assistant' && typeof duration === 'number' && duration >= 0) last.durationMs = duration;
    }
    if (!d.message) continue;
    const timestamp = messageTimestamp(d.timestamp);
    if (d.type === 'user') {
      for (const block of Array.isArray(d.message.content) ? d.message.content : []) {
        const tool = block.type === 'tool_result' && toolsById.get(block.tool_use_id);
        if (tool) { tool.output = block.content; tool.state = block.is_error ? 'error' : 'done'; }
      }
      const t = transcriptUserText(d.message.content);
      const images = (Array.isArray(d.message.content) ? d.message.content : []).filter(b => b?.type === 'image' && b.source?.type === 'base64' && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(b.source.media_type)).map(b => ({ mimeType: b.source.media_type, data: b.source.data }));
      if (t || images.length) messages.push({ role: 'user', text: t, images, ...(timestamp ? { timestamp } : {}) });
    } else if (d.type === 'assistant' && Array.isArray(d.message.content)) {
      let add = ''; const tools = [];
      for (const b of d.message.content) {
        if (b.type === 'text' && b.text) add += (add ? '\n\n' : '') + b.text;
        else if (b.type === 'tool_use') {
          if (toolsById.has(b.id)) continue;
          const tool = { id: b.id, name: b.name, input: b.input, state: 'interrupted' };
          tools.push(tool); toolsById.set(b.id, tool);
        }
      }
      if (!add && !tools.length) continue;
      const prev = messages[messages.length - 1];
      if (prev && prev.role === 'assistant') { if (add) prev.text = prev.text + '\n\n' + add; prev.tools.push(...tools); if (timestamp) prev.timestamp = timestamp; }
      else messages.push({ role: 'assistant', text: add, tools, ...(timestamp ? { timestamp } : {}) });
    }
  }
  const value = { id, project, messages: annotateMessageTimings(messages) };
  sessionMessageCache.delete(fp);
  sessionMessageCache.set(fp, { revision, value });
  while (sessionMessageCache.size > 2) sessionMessageCache.delete(sessionMessageCache.keys().next().value);
  return pageSessionMessages(value, options);
}

// Codex rollouts are keyed by thread id; Claude transcripts take precedence on collision.
function isCodexSession(id) {
  return !!codexSessions.pathFor(id) && !transcriptPathFor(id);
}
function sessionEngine(id) { return isCodexSession(id) || sessionStore.read()[id]?.engine === 'codex' ? 'codex' : 'claude'; }
const sessionPreviewCache = new Map();
function readSessionPreviews(items) {
  const { sessionPreview } = require('./core/session-previews');
  return items.map(item => {
    try {
      const fp = transcriptPathFor(item.id) || codexSessions.pathFor(item.id);
      const stat = fp ? fs.statSync(fp) : null;
      const signature = JSON.stringify([stat?.mtimeMs, stat?.size, item.first, item.last]);
      const cached = sessionPreviewCache.get(item.id);
      if (cached?.signature === signature) return cached.value;
      const history = sessionMessages(item.id, { limit: 0 });
      const value = sessionPreview(history, { ...item, historyAvailable: !!fp });
      sessionPreviewCache.set(item.id, { signature, value });
      if (sessionPreviewCache.size > 200) sessionPreviewCache.delete(sessionPreviewCache.keys().next().value);
      return value;
    } catch { return sessionPreview(null, item); }
  });
}
function readSessionUserPage({ item, page }) {
  const fp = transcriptPathFor(item.id) || codexSessions.pathFor(item.id);
  return require('./core/session-previews').userMessagePage(sessionMessages(item.id, { limit: 0 }), page, { ...item, historyAvailable: !!fp });
}
function listSessions() {
  const sessionMetadata = sessionStore.read();
  // 只列磁盘上仍有 transcript 的会话——这些才能查看详情/回放/关联抓包。
  // Claude Code 约 30 天清理 transcript，但 history.jsonl 会长期保留，
  // 若按 history 列会出现大量点开就 404 的“幽灵会话”。
  const idToFile = new Map();
  for (const fp of transcriptFiles().sessionFiles) idToFile.set(path.basename(fp, '.jsonl'), fp);
  const map = new Map();
  for (const e of readHistory()) {
    if (!e.sessionId || !idToFile.has(e.sessionId)) continue;
    let s = map.get(e.sessionId);
    if (!s) {
      s = { id: e.sessionId, title: e.display || '', firstTitle: e.display || '', project: e.project || '', count: 0, first: e.timestamp || 0, last: e.timestamp || 0, promptAt: e.timestamp || 0 };
      map.set(e.sessionId, s);
    }
    s.count++;
    const ts = e.timestamp || 0;
    if (ts >= s.last) { s.last = ts; s.title = e.display || s.title; s.promptAt = ts; }
    if (ts < s.first) { s.first = ts; s.firstTitle = e.display || s.firstTitle; }
  }
  // transcript 存在但 history 没记标题的，用文件时间兜底
  for (const [id, fp] of idToFile) {
    let mt = 0;
    try { mt = fs.statSync(fp).mtimeMs; } catch {}
    // CLI history can lag behind continued sessions and does not record -p
    // requests. Transcript activity must advance existing sessions as well.
    const latest = latestTranscriptPrompt(fp);
    if (map.has(id)) {
      const session = map.get(id); session.last = Math.max(session.last, mt);
      if (latest.title && latest.at >= (session.promptAt || 0)) { session.title = latest.title; session.promptAt = latest.at; }
      continue;
    }
    const head = transcriptHead(fp);
    map.set(id, { id, title: latest.title || head.title || id.slice(0, 8), firstTitle: head.title, promptAt: latest.at, project: head.cwd, count: 0, first: mt, last: mt });
  }
  for (const s of codexSessions.list()) {
    if (!map.has(s.id)) map.set(s.id, { id: s.id, engine: 'codex', title: s.title, firstTitle: s.firstTitle, promptAt: s.promptAt, project: s.project, count: s.count, first: s.first, last: s.last });
  }
  // A panel session exists as soon as its first input is accepted, even while
  // the CLI is still starting and has not created its transcript yet.
  for (const [id, meta] of Object.entries(sessionMetadata)) {
    if (!map.has(id) && meta.project && meta.createdAt) map.set(id, { id, engine: meta.engine || 'claude', title: meta.title || '新对话', project: meta.project, count: 0, first: meta.createdAt, last: meta.lastAt || meta.createdAt });
  }
  return [...map.values()].filter(s => !sessionMetadata[s.id]?.deleted).map(s => {
    const meta = sessionMetadata[s.id] || {}, manual = isManualTitle(meta, s.firstTitle);
    const pendingInput = manager.busy(s.id);
    const automatic = meta.autoTitle && (pendingInput || meta.autoTitleAt >= (s.promptAt || 0)) ? meta.autoTitle : s.promptAt ? s.title : meta.title || s.title;
    return { ...s, ...(meta.worktree ? { worktree: meta.worktree } : {}), ...(meta.node ? { node: meta.node } : {}), engine: s.engine || 'claude', title: manual ? meta.title : automatic || meta.title || s.id, titleSource: manual ? 'manual' : 'auto', last: Math.max(s.last, meta.lastAt || 0) };
  }).sort((a, b) => b.last - a.last);
}

// 按 session id 找 transcript 文件路径（history 无记录时兜底）
function transcriptPathFor(id) {
  for (const fp of transcriptFiles().sessionFiles) {
    if (path.basename(fp, '.jsonl') === id) return fp;
  }
  return '';
}

function codexSessionDetail(id, lang) {
  const s = codexSessions.list().find(item => item.id === id);
  if (!s) return null;
  const fmtTime = ts => ts ? new Date(ts).toISOString().replace('T', ' ').slice(0, 16) : '?';
  const title = sessionStore.read()[id]?.title || s.title || id;
  const prompts = (codexSessions.messages(id)?.messages || []).filter(m => m.role === 'user');
  let md = `# ${title}\n\n| ${T(lang, 'tblField')} | ${T(lang, 'tblValue')} |\n|---|---|\n`;
  md += `| Engine | Codex${s.model ? ' · `' + s.model + '`' : ''} |\n| Session ID | \`${id}\` |\n| ${T(lang, 'sesProject')} | \`${s.project || '?'}\` |\n`;
  md += `| ${T(lang, 'sesTime')} | ${fmtTime(s.first)} → ${fmtTime(s.last)} |\n| ${T(lang, 'sesPromptCount')} | ${prompts.length} |\n| ${T(lang, 'sesTranscript')} | \`${s.path}\` |\n`;
  md += `\n## ${T(lang, 'sesResume')}\n\n\`\`\`\ncd ${s.project || '~'} && codex resume ${id}\n\`\`\`\n`;
  if (prompts.length) md += `\n## ${T(lang, 'sesPrompts')}（${prompts.length}）\n\n` + prompts.map(p => `- ${(p.text || '').replace(/\s+/g, ' ').slice(0, 200)}`).join('\n') + '\n';
  return { name: title.slice(0, 60), path: s.path, meta: { engine: 'codex' }, content: md, origin: 'user', session: true, hasTranscript: true, project: s.project, engine: 'codex' };
}
function codexSessionReplay(id) {
  const value = codexSessions.messages(id);
  if (!value) return null;
  const turns = value.messages.map(m => m.role === 'user' ? { role: 'user', ts: '', text: m.text || (m.images?.length ? '[image]' : '') }
    : { role: 'assistant', ts: '', text: m.text, thinking: '', tools: (m.tools || []).map(t => ({ name: t.name, input: typeof t.input === 'string' ? t.input : JSON.stringify(t.input || {}, null, 2), result: typeof t.output === 'string' ? t.output : t.output === undefined ? '' : JSON.stringify(t.output) })), model: '', msgId: '' });
  const caps = captureStore.list().filter(r => r.engine === 'codex' && r.sessionId === id && /\/responses/.test(r.path));
  const cap = caps.map(r => captureStore.get(r.id)).find(r => r?.system) || {};
  return { id, project: value.project, engine: 'codex', turns, truncated: false, systemPrompt: cap.system || '', toolDefs: cap.tools || [], clientVersion: cap.clientVersion || '', userAgent: cap.userAgent || '', captured: !!cap.system, proxyInstalled: true, totalRounds: caps.length };
}
function sessionDetail(id, lang) {
  if (isCodexSession(id)) return codexSessionDetail(id, lang);
  const prompts = readHistory().filter(e => e.sessionId === id);
  prompts.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  let project = prompts[0] && prompts[0].project || '';
  let transcript = project ? path.join(CLAUDE_DIR, 'projects', encodeProject(project), id + '.jsonl') : '';
  if (!transcript || !fs.existsSync(transcript)) transcript = transcriptPathFor(id); // 兜底
  if (!prompts.length && !transcript) return null; // 既无历史也无记录，才真不存在
  const hasTranscript = transcript && fs.existsSync(transcript);
  const head = hasTranscript && (!project || !prompts.length) ? transcriptHead(transcript) : {};
  if (!project) project = head.cwd || '';
  const fmtTime = ts => ts ? new Date(ts).toISOString().replace('T', ' ').slice(0, 16) : '?';
  const title = sessionStore.read()[id]?.title || (prompts[0] && prompts[0].display) || head.title || id;
  const first = prompts[0], last = prompts[prompts.length - 1];
  let md = `# ${title}\n\n`;
  md += `| ${T(lang, 'tblField')} | ${T(lang, 'tblValue')} |\n|---|---|\n`;
  md += `| Session ID | \`${id}\` |\n`;
  md += `| ${T(lang, 'sesProject')} | \`${project || '?'}\` |\n`;
  if (first) md += `| ${T(lang, 'sesTime')} | ${fmtTime(first.timestamp)} → ${fmtTime(last.timestamp)} |\n`;
  md += `| ${T(lang, 'sesPromptCount')} | ${prompts.length} |\n`;
  md += `| ${T(lang, 'sesTranscript')} | ${hasTranscript ? '`' + transcript + '`' : T(lang, 'sesNoTranscript')} |\n`;
  md += `\n## ${T(lang, 'sesResume')}\n\n\`\`\`\ncd ${project || '~'} && claude --resume ${id}\n\`\`\`\n`;
  if (prompts.length) {
    md += `\n## ${T(lang, 'sesPrompts')}（${prompts.length}）\n\n`;
    for (const p of prompts) {
      const text = (p.display || '').replace(/\s+/g, ' ').slice(0, 200);
      md += `- **${fmtTime(p.timestamp)}** ${text}\n`;
    }
  }
  return { name: title.slice(0, 60), path: hasTranscript ? transcript : T(lang, 'sesNoTranscript'), meta: {}, content: md, origin: 'user', session: true, hasTranscript, project };
}

// 用量统计：与 ccusage 同源 —— 直接扫描 ~/.claude/projects/**/*.jsonl 的 assistant 消息 usage，
// 按 message.id + requestId 全局去重；按文件 mtime 增量缓存，只重新解析有变化的文件。
const _usageCache = new Map(); // filePath -> { mtimeMs, size, parsed }

function localDay(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const PARSE_VERSION = 3; // 解析结构变更时 +1，旧缓存自动重建
function parseTranscript(fp) {
  const out = { v: PARSE_VERSION, records: [], userMsgs: 0, userByDay: {}, hourCounts: {}, firstTs: null, toolUses: [] };
  let content;
  try { content = fs.readFileSync(fp, 'utf8'); } catch { return out; }
  for (const line of content.split('\n')) {
    if (!line) continue;
    const isAssistant = line.includes('"type":"assistant"');
    const isUser = !isAssistant && line.includes('"type":"user"');
    if (!isAssistant && !isUser) continue;
    const tsm = line.match(/"timestamp":"([^"]+)"/);
    const ts = tsm ? tsm[1] : null;
    if (ts && (!out.firstTs || ts < out.firstTs)) out.firstTs = ts;
    if (ts) {
      const h = new Date(ts).getHours();
      out.hourCounts[h] = (out.hourCounts[h] || 0) + 1;
    }
    if (isUser) {
      out.userMsgs++;
      if (ts) { const d = localDay(ts); out.userByDay[d] = (out.userByDay[d] || 0) + 1; }
      continue;
    }
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const m = d.message;
    if (!m) continue;
    // 工具调用 → 技能/智能体/工作流使用统计（tool_use.id 用于去重流式重复行）
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (!b || b.type !== 'tool_use' || !b.id || !b.input) continue;
        let kind = null, name = null;
        if (b.name === 'Skill') { kind = 'skills'; name = b.input.skill; }
        else if (b.name === 'Task' || b.name === 'Agent') { kind = 'agents'; name = b.input.subagent_type; }
        else if (b.name === 'Workflow') { kind = 'workflows'; name = b.input.name; }
        if (kind && typeof name === 'string' && name) out.toolUses.push({ id: b.id, kind, name });
      }
    }
    if (!m.usage || !m.model || m.model === '<synthetic>') continue;
    const u = m.usage;
    // 缓存写分 5 分钟 / 1 小时两档（1 小时价格是 2 倍），算费用时要区分
    const c1 = (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0;
    out.records.push({
      key: (m.id || '') + '|' + (d.requestId || ''),
      model: m.model,
      day: ts ? localDay(ts) : null,
      hour: ts ? new Date(ts).getHours() : null,
      ms: ts ? new Date(ts).getTime() : 0,
      in: u.input_tokens || 0, out: u.output_tokens || 0,
      cr: u.cache_read_input_tokens || 0, cc: u.cache_creation_input_tokens || 0, c1,
    });
  }
  // 流式响应同一条消息会写多行、output_tokens 逐行递增：同 key 只保留最终（各字段最大）值
  const byKey = new Map();
  const rest = [];
  for (const r of out.records) {
    if (r.key === '|') { rest.push(r); continue; }
    const prev = byKey.get(r.key);
    if (!prev) byKey.set(r.key, r);
    else {
      prev.in = Math.max(prev.in, r.in); prev.out = Math.max(prev.out, r.out);
      prev.cr = Math.max(prev.cr, r.cr); prev.cc = Math.max(prev.cc, r.cc);
      prev.c1 = Math.max(prev.c1, r.c1);
    }
  }
  out.records = [...byKey.values(), ...rest];
  return out;
}

// 官方定价（$/M token）：{i: input, o: output}；缓存写 5m=1.25×in、1h=2×in，缓存读=0.1×in
// 已用 ccusage 的逐日 cost 校验过一致
function priceFor(model) {
  if (/fable-5|mythos-5/.test(model)) return { i: 10, o: 50 };
  if (/opus-4/.test(model)) return { i: 5, o: 25 };
  if (/sonnet-4/.test(model)) return { i: 3, o: 15 };
  if (/haiku-4/.test(model)) return { i: 1, o: 5 };
  return null;
}
function costOf(model, v) {
  const p = priceFor(model);
  if (!p) return null;
  return (v.in * p.i + v.out * p.o + (v.cc - v.c1) * p.i * 1.25 + v.c1 * p.i * 2 + v.cr * p.i * 0.1) / 1e6;
}
const shortModel = m => m.replace(/^claude-/, '').replace(/-\d{8}$/, '');
const fmtK = n => n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);

// 递归收集全部 .jsonl（会话目录下还有 subagent 子目录，ccusage 也会统计它们）
function transcriptFiles() {
  const projRoot = path.join(CLAUDE_DIR, 'projects');
  const files = [];
  const sessionFiles = new Set(); // 仅顶层会话文件用于会话计数
  if (!fs.existsSync(projRoot)) return { files, sessionFiles };
  (function walk(dir, depth) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 4) walk(fp, depth + 1); }
      else if (e.name.endsWith('.jsonl')) {
        files.push(fp);
        if (depth === 1) sessionFiles.add(fp);
      }
    }
  })(projRoot, 0);
  return { files, sessionFiles };
}

// 带 mtime 缓存的单文件解析
function parsedFor(fp) {
  let st;
  try { st = fs.statSync(fp); } catch { return null; }
  let entry = _usageCache.get(fp);
  if (!entry || entry.mtimeMs !== st.mtimeMs || entry.size !== st.size || entry.parsed.v !== PARSE_VERSION) {
    entry = { mtimeMs: st.mtimeMs, size: st.size, parsed: parseTranscript(fp) };
    _usageCache.set(fp, entry);
  }
  return entry.parsed;
}

// 使用次数统计：命令来自 history.jsonl（长期），技能/智能体/工作流来自 transcripts 的工具调用（约 30 天）
function usageCounts() {
  const counts = { commands: {}, skills: {}, agents: {}, workflows: {} };
  for (const e of readHistory()) {
    const disp = e.display || '';
    if (!disp.startsWith('/') || disp.length < 2) continue;
    const name = disp.slice(1).split(/\s/)[0];
    if (!/^[\w:-]+$/.test(name)) continue;
    counts.commands[name] = (counts.commands[name] || 0) + 1;
  }
  const seen = new Set();
  for (const fp of transcriptFiles().files) {
    const p = parsedFor(fp);
    if (!p || !p.toolUses) continue;
    for (const tu of p.toolUses) {
      if (seen.has(tu.id)) continue; // 跨文件去重（resume 会复制历史）
      seen.add(tu.id);
      // 插件命名空间 plugin:skill 归到技能短名
      const short = tu.name.includes(':') ? tu.name.split(':').pop() : tu.name;
      counts[tu.kind][short] = (counts[tu.kind][short] || 0) + 1;
    }
  }
  return counts;
}

// Wrapped 分享卡片数据：按天数窗口聚合（days=0 表示全部）
function wrappedStats(days) {
  const cutoff = days > 0 ? localDay(new Date(Date.now() - (days - 1) * 86400e3)) : '';
  const cutoffMs = days > 0 ? Date.now() - days * 86400e3 : 0;
  const seen = new Set();
  const models = {}, byDay = {}, hourCounts = {};
  let cost = 0, tokens = 0, msgs = 0, costKnown = true;
  for (const fp of transcriptFiles().files) {
    const p = parsedFor(fp);
    if (!p) continue;
    for (const [d, n] of Object.entries(p.userByDay)) {
      if (d >= cutoff) { byDay[d] = (byDay[d] || 0) + n; msgs += n; }
    }
    for (const r of p.records) {
      if (!r.day || r.day < cutoff) continue;
      if (r.key !== '|') { if (seen.has(r.key)) continue; seen.add(r.key); }
      msgs++;
      byDay[r.day] = (byDay[r.day] || 0) + 1;
      if (r.hour !== null) hourCounts[r.hour] = (hourCounts[r.hour] || 0) + 1;
      const t = models[r.model] ||= { tokens: 0 };
      const tk = r.in + r.out + r.cc + r.cr;
      t.tokens += tk; tokens += tk;
      const c = costOf(r.model, { in: r.in, out: r.out, cc: r.cc, c1: r.c1, cr: r.cr });
      if (c === null) costKnown = false; else cost += c;
    }
  }
  // 命令 top3 与会话数（history 有时间戳，可精确按窗口过滤）
  const cmdCounts = {};
  const sessionIds = new Set();
  for (const e of readHistory()) {
    if ((e.timestamp || 0) < cutoffMs) continue;
    if (e.sessionId) sessionIds.add(e.sessionId);
    const disp = e.display || '';
    if (disp.startsWith('/') && disp.length > 1) {
      const name = disp.slice(1).split(/\s/)[0];
      if (/^[\w:-]+$/.test(name)) cmdCounts[name] = (cmdCounts[name] || 0) + 1;
    }
  }
  const activeDays = Object.keys(byDay).length;
  // 最长连续活跃天数
  const sorted = Object.keys(byDay).sort();
  let streak = 0, cur = 0, prev = null;
  for (const d of sorted) {
    cur = (prev && (new Date(d) - new Date(prev)) === 86400e3) ? cur + 1 : 1;
    if (cur > streak) streak = cur;
    prev = d;
  }
  const busiest = sorted.reduce((b, d) => (!b || byDay[d] > byDay[b] ? d : b), null);
  const peakHour = Object.entries(hourCounts).reduce((b, [h, n]) => (!b || n > b[1] ? [h, n] : b), null);
  const lateNight = [0, 1, 2, 3, 4, 5].reduce((s, h) => s + (hourCounts[h] || 0), 0);
  const topModel = Object.entries(models).sort((a, b) => b[1].tokens - a[1].tokens)[0];
  return {
    days, from: cutoff || sorted[0] || '', to: localDay(new Date()),
    cost: Math.round(cost * 100) / 100, costKnown, tokens, messages: msgs,
    sessions: sessionIds.size, activeDays, streak,
    busiestDay: busiest ? { date: busiest, messages: byDay[busiest] } : null,
    topCommands: Object.entries(cmdCounts).sort((a, b) => b[1] - a[1]).slice(0, 3),
    topModel: topModel ? { name: shortModel(topModel[0]), tokens: topModel[1].tokens } : null,
    peakHour: peakHour ? Number(peakHour[0]) : null,
    lateNightMessages: lateNight,
  };
}

// ---------- 全局搜索 ----------
function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(b => (b && b.type === 'text') ? b.text : '').join(' ');
  return '';
}

function searchTranscripts(q) {
  const ql = q.toLowerCase();
  const out = [];
  const { files, sessionFiles } = transcriptFiles();
  for (const fp of files) {
    if (!sessionFiles.has(fp)) continue; // 只搜主会话，跳过 subagent 记录
    let content;
    try { content = fs.readFileSync(fp, 'utf8'); } catch { continue; }
    if (!content.toLowerCase().includes(ql)) continue;
    const sid = path.basename(fp, '.jsonl');
    for (const line of content.split('\n')) {
      if (!line.toLowerCase().includes(ql)) continue;
      const isU = line.includes('"type":"user"');
      const isA = !isU && line.includes('"type":"assistant"');
      if (!isU && !isA) continue;
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      if (d.isSidechain) continue;
      const text = extractText(d.message && d.message.content);
      const idx = text.toLowerCase().indexOf(ql);
      if (idx < 0) continue;
      out.push({
        session: sid,
        role: isU ? 'user' : 'assistant',
        ts: d.timestamp || '',
        project: d.cwd || '',
        snippet: text.slice(Math.max(0, idx - 60), idx + q.length + 120).replace(/\s+/g, ' ').trim(),
      });
      if (out.length >= 200) break;
    }
    if (out.length >= 200) break;
  }
  out.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  return out.slice(0, 80);
}

// ---------- 会话回放 ----------
function sessionReplay(id) {
  if (isCodexSession(id)) return codexSessionReplay(id);
  const prompts = readHistory().filter(e => e.sessionId === id);
  const project = (prompts[0] && prompts[0].project) || '';
  let fp = project ? path.join(CLAUDE_DIR, 'projects', encodeProject(project), id + '.jsonl') : '';
  if (!fp || !fs.existsSync(fp)) fp = transcriptPathFor(id); // 兜底：按 id 直接找
  if (!fp || !fs.existsSync(fp)) return null;
  const raw = fs.readFileSync(fp, 'utf8').split('\n');
  // 第一遍：收集 tool_result（在后续 user 行里，按 tool_use_id 配对）
  const toolResults = new Map();
  for (const line of raw) {
    if (!line.includes('"tool_result"')) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const content = d.message && d.message.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || b.type !== 'tool_result' || !b.tool_use_id) continue;
      const c = b.content;
      const text = typeof c === 'string' ? c
        : Array.isArray(c) ? c.map(x => (x && x.type === 'text') ? x.text : '').join('\n')
        : JSON.stringify(c || '');
      toolResults.set(b.tool_use_id, (b.is_error ? '⚠ ' : '') + text);
    }
  }
  // 第二遍：构建对话轮次（含思考过程、工具输入/返回、每轮耗时）
  const byMsgId = new Map(); // 流式重复行：同 message.id 保留最后一行
  const turns = [];
  for (const line of raw) {
    if (!line) continue;
    const isU = line.includes('"type":"user"');
    const isA = !isU && line.includes('"type":"assistant"');
    const isDur = !isU && !isA && line.includes('"turn_duration"');
    if (!isU && !isA && !isDur) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.isSidechain) continue;
    if (isDur) {
      if (d.durationMs) turns.push({ role: 'meta', ts: d.timestamp || '', durationMs: d.durationMs, messageCount: d.messageCount || 0 });
      continue;
    }
    const m = d.message;
    if (!m) continue;
    if (isU) {
      const text = extractText(m.content);
      if (!text.trim()) continue; // 纯 tool_result 消息已在第一遍消费
      turns.push({ role: 'user', ts: d.timestamp || '', text: text });
    } else {
      const text = extractText(m.content);
      const content = Array.isArray(m.content) ? m.content : [];
      const thinking = content.filter(b => b && b.type === 'thinking' && b.thinking)
        .map(b => b.thinking).join('\n\n');
      const tools = content.filter(b => b && b.type === 'tool_use').map(b => ({
        name: b.name,
        input: JSON.stringify(b.input || {}, null, 2), // 缩进美化，完整参数
        result: toolResults.get(b.id) || '',
      }));
      if (!text.trim() && !tools.length && !thinking) continue;
      const turn = { role: 'assistant', ts: d.timestamp || '', text: text, thinking, tools, model: m.model || '', msgId: m.id || '' };
      if (m.id) {
        const prev = byMsgId.get(m.id);
        if (prev) {
          // 流式分行写入：thinking/text/tool_use 可能各占一行，按字段取最长值合并
          if (turn.text.length > prev.text.length) prev.text = turn.text;
          if (turn.thinking.length > prev.thinking.length) prev.thinking = turn.thinking;
          if (turn.tools.length > prev.tools.length) prev.tools = turn.tools;
          continue;
        }
        byMsgId.set(m.id, turn);
      }
      turns.push(turn);
    }
  }
  // 关联 Inspector 抓包：响应 message.id 匹配到本会话的轮次，
  // 就把真实系统提示词 / 思考过程 / 客户端版本回填进回放（这些 transcript 里没有）
  let systemPrompt = '', clientVersion = '', userAgent = '', toolDefs = [];
  const msgIds = new Set();
  for (const turn of turns) {
    if (turn.role !== 'assistant' || !turn.msgId) continue;
    msgIds.add(turn.msgId);
    const cap = captureStore.getByMessageId(turn.msgId);
    if (!cap) continue;
    if (!systemPrompt) systemPrompt = cap.system || '';
    if (!toolDefs.length) toolDefs = cap.tools || [];
    if (!clientVersion && cap.clientVersion) clientVersion = cap.clientVersion;
    if (!userAgent && cap.userAgent) userAgent = cap.userAgent;
    if (cap.thinking && !turn.thinking) { turn.thinking = cap.thinking; turn.thinkingLive = true; }
  }
  // 每个抓包（一次 API 往返）按响应 message.id 建索引
  const roundByMsg = new Map();
  for (const r of captureStore.list()) {
    if (r.respMsgId && msgIds.has(r.respMsgId)) {
      roundByMsg.set(r.respMsgId, { id: r.id, model: shortModel(r.model || '?'), ts: r.ts,
        durationMs: r.durationMs, messagesCount: r.messagesCount, hasThinking: r.hasThinking, toolCount: r.toolCount });
    }
  }
  // 把每轮归到它所属的用户提问下：一条 query 后、下一条 query 前的所有 assistant 轮次都属于它
  let curUser = null, totalRounds = 0;
  for (const turn of turns) {
    if (turn.role === 'user') { curUser = turn; turn.rounds = []; }
    else if (turn.role === 'assistant' && turn.msgId && curUser) {
      const rd = roundByMsg.get(turn.msgId);
      if (rd) { curUser.rounds.push(rd); totalRounds++; }
    }
  }
  const truncated = false;
  return { id, project, turns, truncated, systemPrompt, toolDefs, clientVersion, userAgent, captured: !!systemPrompt, proxyInstalled: isProxyHookInstalled(), totalRounds };
}

// ---------- Live 快照 / 面板配置（预算） ----------
const PANEL_CONFIG = path.join(DATA_DIR, 'panel-config.json');
function readPanelConfig() {
  try { return JSON.parse(fs.readFileSync(PANEL_CONFIG, 'utf8')); } catch { return {}; }
}
function writePanelConfig(cfg) {
  fs.writeFileSync(PANEL_CONFIG, JSON.stringify(cfg, null, 2), 'utf8');
}

let _budgetNotifiedDay = '';
function liveSnapshot(lang) {
  const today = localDay(new Date());
  const now = Date.now();
  const seen = new Set();
  let todayCost = 0, todayTokens = 0, todayMsgs = 0, burn10 = 0;
  let activeSessions = 0;
  for (const fp of transcriptFiles().files) {
    const entry = _usageCache.get(fp);
    const p = parsedFor(fp);
    if (!p) continue;
    if (entry && now - entry.mtimeMs < 2 * 60e3) activeSessions++;
    for (const r of p.records) {
      if (r.day !== today) continue;
      if (r.key !== '|') { if (seen.has(r.key)) continue; seen.add(r.key); }
      todayMsgs++;
      todayTokens += r.in + r.out + r.cc + r.cr;
      const c = costOf(r.model, { in: r.in, out: r.out, cc: r.cc, c1: r.c1, cr: r.cr }) || 0;
      todayCost += c;
      if (r.ms && now - r.ms < 10 * 60e3) burn10 += c;
    }
  }
  const cfg = readPanelConfig();
  const budget = Number(cfg.dailyBudget) || 0;
  const overBudget = budget > 0 && todayCost > budget;
  // 超预算通知：macOS 每天最多提醒一次
  if (overBudget && _budgetNotifiedDay !== today && process.platform === 'darwin') {
    _budgetNotifiedDay = today;
    const msg = T(lang, 'budgetNotify').replace('{cost}', todayCost.toFixed(2)).replace('{budget}', String(budget));
    try {
      require('child_process').execFile('osascript', ['-e',
        `display notification ${JSON.stringify(msg)} with title "my-agents" sound name "Sosumi"`]);
    } catch {}
  }
  return {
    today, cost: Math.round(todayCost * 100) / 100, tokens: todayTokens, messages: todayMsgs,
    burnPerHour: Math.round(burn10 * 6 * 100) / 100, // 近10分钟折算每小时
    activeSessions, budget, overBudget,
  };
}

// ---------- CLAUDE.md 合并视图 ----------
function mergedClaudeMd(lang, scope) {
  const cands = [
    [path.join(os.homedir(), 'CLAUDE.md'), '~/CLAUDE.md'],
    [path.join(CLAUDE_DIR, 'CLAUDE.md'), '~/.claude/CLAUDE.md'],
  ];
  if (scope) {
    cands.push([path.join(scope, 'CLAUDE.md'), path.join(scope, 'CLAUDE.md')]);
    cands.push([path.join(scope, '.claude', 'CLAUDE.md'), path.join(scope, '.claude', 'CLAUDE.md')]);
  }
  const parts = [];
  for (const [fp, label] of cands) {
    if (!fs.existsSync(fp)) continue;
    parts.push(`## 📄 ${label}\n\n${fs.readFileSync(fp, 'utf8').trim()}`);
  }
  return `# ${T(lang, 'cfgMergedName')}\n\n> ${T(lang, 'cfgMergedDesc')}\n\n` +
    (parts.join('\n\n---\n\n') || `*${T(lang, 'cfgMergedEmpty')}*`);
}

// ---------- 配置包导出 / 导入 ----------
function exportBundle() {
  const bundle = { format: 'my-agents-bundle', version: 1, exportedAt: new Date().toISOString() };
  for (const type of Object.keys(TYPES)) {
    bundle[type] = {};
    for (const it of listItems(type)) {
      if (it.origin !== 'user') continue; // 只导出自建的
      const fp = filePathOf(type, it.name);
      try { bundle[type][it.name] = fs.readFileSync(fp, 'utf8'); } catch {}
    }
  }
  return bundle;
}

function importBundle(bundle) {
  const created = [], skipped = [], invalid = [];
  for (const type of Object.keys(TYPES)) {
    for (const [name, content] of Object.entries(bundle[type] || {})) {
      if (typeof content !== 'string' || !safeName(name)) { invalid.push(`${type}/${name}`); continue; }
      const fp = filePathOf(type, name);
      if (fs.existsSync(fp)) { skipped.push(`${type}/${name}`); continue; }
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, content, 'utf8');
      created.push(`${type}/${name}`);
    }
  }
  return { created, skipped, invalid };
}

function readStats() {
  const projRoot = path.join(CLAUDE_DIR, 'projects');
  if (!fs.existsSync(projRoot)) return null;
  const { files, sessionFiles } = transcriptFiles();
  const seen = new Set();
  const modelUsage = {}, byDay = {}, hourCounts = {}, dayModels = {};
  let totalMessages = 0, firstTs = null;
  for (const fp of files) {
    const p = parsedFor(fp);
    if (!p) continue;
    totalMessages += p.userMsgs;
    if (p.firstTs && (!firstTs || p.firstTs < firstTs)) firstTs = p.firstTs;
    for (const [h, n] of Object.entries(p.hourCounts)) hourCounts[h] = (hourCounts[h] || 0) + n;
    for (const [d, n] of Object.entries(p.userByDay)) {
      (byDay[d] ||= { messageCount: 0 }).messageCount += n;
    }
    for (const r of p.records) {
      if (r.key !== '|' && seen.has(r.key)) continue; // 全局去重（重试/续写产生的重复计费行）
      if (r.key !== '|') seen.add(r.key);
      totalMessages++;
      const t = modelUsage[r.model] ||= { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
      t.inputTokens += r.in; t.outputTokens += r.out; t.cacheReadInputTokens += r.cr; t.cacheCreationInputTokens += r.cc;
      if (r.day) {
        (byDay[r.day] ||= { messageCount: 0 }).messageCount++;
        const dm = (dayModels[r.day] ||= {});
        const v = dm[r.model] ||= { in: 0, out: 0, cc: 0, c1: 0, cr: 0 };
        v.in += r.in; v.out += r.out; v.cc += r.cc; v.c1 += r.c1; v.cr += r.cr;
      }
    }
  }
  const dailyActivity = Object.entries(byDay)
    .map(([date, v]) => ({ date, messageCount: v.messageCount }))
    .sort((a, b) => a.date.localeCompare(b.date));
  // ccusage daily 风格的逐日明细表
  const totals = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0, costKnown: true };
  const dailyTable = Object.entries(dayModels).sort((a, b) => a[0].localeCompare(b[0])).map(([date, models]) => {
    const row = { date, models: [], input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0, costKnown: true };
    for (const [m, v] of Object.entries(models)) {
      row.models.push(shortModel(m));
      row.input += v.in; row.output += v.out; row.cacheCreate += v.cc; row.cacheRead += v.cr;
      const c = costOf(m, v);
      if (c === null) row.costKnown = false; else row.cost += c;
    }
    row.models.sort();
    row.totalTokens = row.input + row.output + row.cacheCreate + row.cacheRead;
    totals.input += row.input; totals.output += row.output;
    totals.cacheCreate += row.cacheCreate; totals.cacheRead += row.cacheRead;
    totals.cost += row.cost;
    if (!row.costKnown) totals.costKnown = false;
    return row;
  });
  totals.totalTokens = totals.input + totals.output + totals.cacheCreate + totals.cacheRead;
  return {
    totalSessions: sessionFiles.size, totalMessages,
    firstSessionDate: firstTs, dailyActivity,
    modelUsage, hourCounts, dailyTable, totals,
    usage: usageCounts(), source: 'transcripts',
  };
}

// scope（项目根路径）→ 各资源目录；scope 为空时用全局 ~/.claude
function typesFor(scope) {
  if (!scope) return TYPES;
  const base = path.join(scope, '.claude');
  return {
    commands:  { dir: path.join(base, 'commands'),  layout: 'flat', ext: '.md' },
    skills:    { dir: path.join(base, 'skills'),    layout: 'nested' },
    agents:    { dir: path.join(base, 'agents'),    layout: 'flat', ext: '.md' },
    workflows: { dir: path.join(base, 'workflows'), layout: 'flat', ext: '.js' },
  };
}

// ---------- 配置专区 ----------
function configFiles(lang, scope) {
  let candidates;
  if (scope) {
    const base = path.join(scope, '.claude');
    candidates = [
      { key: 'claude-md', name: 'CLAUDE.md', path: path.join(scope, 'CLAUDE.md'), desc: T(lang, 'cfgProjMdDesc') },
      { key: 'claude-dir-md', name: 'CLAUDE.md (.claude)', path: path.join(base, 'CLAUDE.md'), desc: T(lang, 'cfgProjMdDesc') },
      { key: 'settings', name: 'settings.json', path: path.join(base, 'settings.json'), desc: T(lang, 'cfgProjSettingsDesc') },
      { key: 'settings-local', name: 'settings.local.json', path: path.join(base, 'settings.local.json'), desc: T(lang, 'cfgSettingsLocalDesc') },
    ];
    // 项目记忆目录 ~/.claude/projects/<encoded>/memory/*.md
    const memDir = path.join(CLAUDE_DIR, 'projects', encodeProject(scope), 'memory');
    if (fs.existsSync(memDir)) {
      for (const f of fs.readdirSync(memDir).sort()) {
        if (!f.endsWith('.md')) continue;
        candidates.push({ key: 'mem-' + f.replace(/\.md$/, ''), name: '🧠 ' + f, path: path.join(memDir, f), desc: T(lang, 'cfgMemoryDesc') });
      }
    }
  } else {
    candidates = [
      { key: 'claude-md', name: T(lang, 'cfgClaudeMdName'), path: path.join(os.homedir(), 'CLAUDE.md'), desc: T(lang, 'cfgClaudeMdDesc') },
      { key: 'claude-dir-md', name: T(lang, 'cfgClaudeDirName'), path: path.join(CLAUDE_DIR, 'CLAUDE.md'), desc: T(lang, 'cfgClaudeDirDesc') },
      { key: 'settings', name: T(lang, 'cfgSettingsName'), path: path.join(CLAUDE_DIR, 'settings.json'), desc: T(lang, 'cfgSettingsDesc') },
      { key: 'settings-local', name: 'settings.local.json', path: path.join(CLAUDE_DIR, 'settings.local.json'), desc: T(lang, 'cfgSettingsLocalDesc') },
      { key: 'keybindings', name: T(lang, 'cfgKeybindName'), path: path.join(CLAUDE_DIR, 'keybindings.json'), desc: T(lang, 'cfgKeybindDesc') },
    ];
  }
  return candidates.filter(f => fs.existsSync(f.path));
}
function pluginCommandPath(key) {
  const m = key.match(/^p!([\w.-]+)!(c|s)!([\w.-]+)$/);
  if (!m) return null;
  const [, pluginName, kind, name] = m;
  const manifest = path.join(CLAUDE_DIR, 'plugins', 'installed_plugins.json');
  let plugins;
  try { plugins = JSON.parse(fs.readFileSync(manifest, 'utf8')).plugins || {}; } catch { return null; }
  for (const [fullName, installs] of Object.entries(plugins)) {
    if (fullName.split('@')[0] !== pluginName) continue;
    const install = Array.isArray(installs) ? installs[0] : installs;
    if (!install || !install.installPath) continue;
    return kind === 'c'
      ? path.join(install.installPath, 'commands', name + '.md')
      : path.join(install.installPath, 'skills', name, 'SKILL.md');
  }
  return null;
}

// ---------- helpers ----------
function safeName(name) {
  // 防目录穿越：只允许字母数字、中划线、下划线、点（不允许 .. 和斜杠）
  if (typeof name !== 'string' || !name.length) return null;
  if (!/^[\w.-]+$/.test(name) || name.includes('..')) return null;
  return name;
}

function filePathOf(type, name, scope) {
  const t = typesFor(scope)[type];
  if (!t) return null;
  const n = safeName(name);
  if (!n) return null;
  return t.layout === 'nested'
    ? path.join(t.dir, n, 'SKILL.md')
    : path.join(t.dir, n + (t.ext || '.md'));
}

function isInstalled(type, name, scope) {
  // 软链接视为通过工具安装的资源
  const t = typesFor(scope)[type];
  const target = t.layout === 'nested' ? path.join(t.dir, name) : path.join(t.dir, name + '.md');
  try { return fs.lstatSync(target).isSymbolicLink(); } catch { return false; }
}

function parseFrontmatter(content) {
  const meta = {};
  let body = content;
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (m) {
    body = content.slice(m[0].length);
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
      if (kv) {
        let v = kv[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        meta[kv[1]] = v;
      }
    }
  }
  return { meta, body };
}

// 工作流脚本：从 export const meta = {...} 里提取 description
function jsMetaDescription(content) {
  const m = content.match(/description:\s*(['"`])((?:\\.|(?!\1).)*)\1/);
  return m ? m[2] : (content.split(/\r?\n/).find(l => l.trim().startsWith('//')) || '').replace(/^\s*\/\/\s*/, '').slice(0, 200);
}

function summarize(content) {
  const { meta, body } = parseFrontmatter(content);
  if (meta.description) return meta.description;
  const firstLine = body.split(/\r?\n/).find(l => l.trim() && !l.startsWith('#'));
  const firstHeading = body.split(/\r?\n/).find(l => l.startsWith('#'));
  return (firstLine || firstHeading || '').replace(/^#+\s*/, '').slice(0, 200);
}

function listItems(type, scope) {
  const t = typesFor(scope)[type];
  if (!fs.existsSync(t.dir)) return [];
  const items = [];
  if (t.layout === 'nested') {
    for (const name of fs.readdirSync(t.dir)) {
      const dirPath = path.join(t.dir, name);
      // 软链接 = 通过 axon-cli 等工具安装；真实目录 = 用户自建
      const lstat = fs.lstatSync(dirPath);
      const isLink = lstat.isSymbolicLink();
      let isDir;
      try { isDir = fs.statSync(dirPath).isDirectory(); } catch { continue; } // 跳过失效软链接
      if (!isDir) continue;
      const fp = path.join(dirPath, 'SKILL.md');
      if (!fs.existsSync(fp)) continue;
      const stat = fs.statSync(fp);
      const content = fs.readFileSync(fp, 'utf8');
      items.push({ name, description: summarize(content), mtime: stat.mtimeMs, size: stat.size, origin: isLink ? 'installed' : 'user' });
    }
  } else {
    const ext = t.ext || '.md';
    for (const f of fs.readdirSync(t.dir)) {
      if (!f.endsWith(ext) || f.startsWith('.')) continue;
      const fp = path.join(t.dir, f);
      const isLink = fs.lstatSync(fp).isSymbolicLink();
      const stat = fs.statSync(fp);
      const content = fs.readFileSync(fp, 'utf8');
      const desc = ext === '.js' ? jsMetaDescription(content) : summarize(content);
      items.push({ name: f.slice(0, -ext.length), description: desc, mtime: stat.mtimeMs, size: stat.size, origin: isLink ? 'installed' : 'user' });
    }
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

function sendJSON(res, code, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(data);
}

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > limit) { reject(new Error('请求内容过大')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ---------- Inspector：本地反向代理抓包 ----------
// 用法：ANTHROPIC_BASE_URL=http://localhost:<PROXY_PORT> claude
// 面板即可看到每个请求的完整 payload（系统提示词、工具定义、消息、流式响应含 thinking）
const CAPTURES_FILE = path.join(DATA_DIR, 'panel-captures.jsonl');
const captureStore = createCaptureStore(CAPTURES_FILE);
function loadCaptures() { captureStore.load(); }
// Recover legacy captures only through exact response IDs; copied history stays ambiguous.
let captureLinkPromise, captureLinkRevision = -1, captureLinkAt = 0;
function linkCaptureSessions() {
  if (captureLinkPromise) return captureLinkPromise;
  if (captureLinkRevision === captureStore.revision && Date.now() - captureLinkAt < 10000) return Promise.resolve();
  const wanted = new Set(captureStore.list().filter(r => r.sessionSource !== 'metadata' && r.respMsgId).map(r => r.respMsgId));
  const complete = () => { captureLinkRevision = captureStore.revision; captureLinkAt = Date.now(); };
  if (!wanted.size) { complete(); return Promise.resolve(); }
  captureLinkPromise = historyWorker.read('captureOwners', [...wanted]).then(owners => { captureStore.linkSessions(new Map(owners)); complete(); }).finally(() => { captureLinkPromise = null; });
  return captureLinkPromise;
}

function captureOwners(ids) {
  const wanted = new Set(ids), owners = new Map();
  for (const file of transcriptFiles().sessionFiles) {
    const sessionId = path.basename(file, '.jsonl').toLowerCase();
    for (const record of parsedFor(file)?.records || []) {
      const id = record.key.split('|')[0];
      if (!wanted.has(id)) continue;
      if (!owners.has(id)) owners.set(id, sessionId);
      else if (owners.get(id) !== sessionId) owners.set(id, '');
    }
  }
  return [...owners];
}

function captureNavigationFor(id) {
  const navigation = captureStore.navigation(id);
  const session = navigation.sessionId ? listSessions().find(item => item.id === navigation.sessionId) : null;
  return { ...navigation, sessionTitle: session?.title || '' };
}
function persistCapture(rec) { captureStore.append(rec); }

function sseExtract(raw) {
  // 从流式响应里抽取：输出文本、thinking、usage、响应消息 id（用于和 transcript 关联）
  let text = '', thinking = '', usage = null, model = '', msgId = '';
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    let ev;
    try { ev = JSON.parse(line.slice(5)); } catch { continue; }
    if (ev.type === 'content_block_delta' && ev.delta) {
      if (ev.delta.type === 'text_delta') text += ev.delta.text || '';
      if (ev.delta.type === 'thinking_delta') thinking += ev.delta.thinking || '';
    }
    if (ev.type === 'message_start' && ev.message) {
      model = ev.message.model || '';
      msgId = ev.message.id || '';
      usage = ev.message.usage || usage;
    }
    if (ev.type === 'message_delta' && ev.usage) usage = { ...usage, ...ev.usage };
  }
  return { text, thinking, usage, model, msgId };
}

// 从 user-agent 提取 Claude Code 版本，如 "claude-cli/2.1.3 (external, cli)" → "2.1.3"
function parseClientVersion(ua) {
  if (!ua) return '';
  const m = ua.match(/claude-cli\/(\S+)/i) || ua.match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : '';
}

// 按 content-encoding 解压响应体（Anthropic API 会 gzip/br 压缩，直接 toString 是乱码）
function decodeBody(buf, encoding) {
  try {
    if (encoding === 'gzip') return zlib.gunzipSync(buf);
    if (encoding === 'br') return zlib.brotliDecompressSync(buf);
    if (encoding === 'deflate') return zlib.inflateSync(buf);
  } catch {}
  return buf;
}

// 生成不截断的可读结构；完整内容块另保存在 requestBody 中
function summarizeMessage(m) {
  const parts = [];
  const c = m.content;
  if (typeof c === 'string') parts.push({ kind: 'text', text: c });
  else if (Array.isArray(c)) {
    for (const b of c) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text') parts.push({ kind: 'text', text: (b.text || '') });
      else if (b.type === 'tool_use') parts.push({ kind: 'tool_use', name: b.name, input: JSON.stringify(b.input || {}, null, 2) });
      else if (b.type === 'tool_result') {
        const rc = b.content;
        const text = typeof rc === 'string' ? rc : Array.isArray(rc) ? rc.map(x => (x && x.type === 'text') ? x.text : (x && x.type === 'image' ? '[image]' : '')).join('\n') : JSON.stringify(rc || '');
        parts.push({ kind: 'tool_result', text: (b.is_error ? '⚠ ' : '') + text });
      } else if (b.type === 'image') parts.push({ kind: 'image', text: '[image]' });
    }
  }
  return { role: m.role, parts };
}

// Upstream failures seen by the proxies surface as warnings in the session's active turn.
function warnUpstream(rec) {
  if (rec.status < 400 || !rec.sessionId) return;
  const run = manager.get(rec.sessionId);
  if (!run) return;
  const meta = registry.get(run.engine)?.meta || {};
  manager.warn(rec.sessionId, `上游返回 ${rec.status}，${meta.short || run.engine} 可能正在重试。${meta.upstreamHint || ''}。`);
}
function recordExchange(reqPath, status, durationMs, reqBody, resBody, isStream, reqHeaders, resEncoding, upstreamId, upstreamName, requestInfo = {}) {
  resBody = decodeBody(resBody, resEncoding);
  const ua = (reqHeaders && (reqHeaders['user-agent'] || reqHeaders['User-Agent'])) || '';
  let rec = {
    upstreamId: upstreamId || '', upstreamName: upstreamName || '',
    id: requestInfo.id ?? captureStore.nextId(), ts: new Date().toISOString(), path: reqPath, status, durationMs,
    ...(requestInfo.id != null ? { requestOrder: requestInfo.requestOrder ?? requestInfo.id, startedAt: requestInfo.startedAt } : {}),
    sessionId: requestInfo.sessionId || '', method: requestInfo.method || 'POST', routing: requestInfo.routing || null, incomplete: !!requestInfo.incomplete,
    model: '', system: '', tools: [], messagesCount: 0, lastUser: '', respMsgId: '',
    userAgent: ua, clientVersion: parseClientVersion(ua),
    anthropicVersion: (reqHeaders && reqHeaders['anthropic-version']) || '',
    betas: (reqHeaders && (reqHeaders['anthropic-beta'] || '')),
    outText: '', thinking: '', usage: null,
    requestBytes: reqBody.length, responseBytes: resBody.length,
    // 原始正文保留完整 JSON / SSE，包括图片、工具 ID、schema 及未知内容块。
    requestBody: reqBody.toString('utf8'), responseBody: resBody.toString('utf8'),
  };
  // Upstreams with their own wire format parse the exchange; the default (Anthropic) is parsed below.
  const upstream = upstreams.for(reqPath);
  if (upstream?.extract) {
    upstream.extract(rec, { stream: isStream });
    warnUpstream(rec);
    try { persistCapture(rec); } catch (e) { console.error('抓包保存失败：', e.message); }
    return;
  }
  try {
    const b = JSON.parse(reqBody.toString('utf8'));
    rec.model = b.model || '';
    rec.messagesCount = Array.isArray(b.messages) ? b.messages.length : 0;
    // 系统提示词：string 或 [{type:'text',text}] 数组
    rec.system = typeof b.system === 'string' ? b.system
      : Array.isArray(b.system) ? b.system.map(s => s.text || '').join('\n\n') : '';
    rec.tools = Array.isArray(b.tools)
      ? b.tools
      : [];
    const lastU = (b.messages || []).filter(m => m.role === 'user').pop();
    if (lastU) rec.lastUser = extractText(lastU.content);
    // 完整上下文：这一轮真正发给大模型的全部消息（文本 + 工具调用 + 工具返回），供仔细分析
    rec.messages = Array.isArray(b.messages) ? b.messages.map(summarizeMessage) : [];
  } catch {}
  try {
    const rtext = resBody.toString('utf8');
    if (isStream) {
      const s = sseExtract(rtext);
      rec.outText = s.text;
      rec.thinking = s.thinking;
      rec.usage = s.usage;
      rec.respMsgId = s.msgId;
      if (!rec.model) rec.model = s.model;
    } else {
      const r = JSON.parse(rtext);
      rec.outText = extractText(r.content);
      rec.usage = r.usage || null;
      rec.respMsgId = r.id || '';
      if (!rec.model) rec.model = r.model || '';
    }
  } catch {}
  warnUpstream(rec);
  try { persistCapture(rec); } catch (e) { console.error('抓包保存失败：', e.message); }
}

const accountRouter = require('./proxy-router').createRouter({
  dir: DATA_DIR, claudeDir: CLAUDE_DIR, port: PROXY_PORT, record: recordExchange,
  reserveCapture: () => ({ id: captureStore.nextId(), startedAt: new Date().toISOString() }),
});
// Codex on remote nodes authenticates with this per-process token; the proxy swaps it for this machine's login.
const codexRelayToken = crypto.randomBytes(24).toString('hex');
const readCodexAuth = () => { try { return JSON.parse(fs.readFileSync(path.join(CODEX_HOME, 'auth.json'), 'utf8')); } catch { return null; } };
const codexProxy = createCodexProxy({
  record: recordExchange, reserveCapture: () => ({ id: captureStore.nextId(), startedAt: new Date().toISOString() }),
  relay: { token: codexRelayToken, credentials: mode => codexCredentials(readCodexAuth(), mode) },
});
const upstreams = createUpstreams();
upstreams.add({ id: 'anthropic', engine: 'claude', handle: accountRouter.handle }, { isDefault: true });
upstreams.add({
  id: 'openai', engine: 'codex', match: isCodexPath, handle: codexProxy.handle,
  extract(rec, { stream }) {
    const { finished, ...extracted } = extractResponses(rec.requestBody, rec.responseBody, stream);
    Object.assign(rec, extracted, { anthropicVersion: '', betas: '' });
    if (finished === 'response.completed') rec.incomplete = false; // 上游收到终止事件后才断开连接，不算中断
  },
});
const proxyServer = http.createServer(upstreams.handle);
// Panel-started Codex runs go through the capture proxy unless disabled.
const codexCaptureEnabled = () => process.env.CCP_CODEX_CAPTURE !== '0' && readPanelConfig().codexCapture !== false;
function codexAuthMode() {
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(CODEX_HOME, 'auth.json'), 'utf8'));
    if (auth.auth_mode) return String(auth.auth_mode).toLowerCase().replace(/[^a-z]/g, '');
    return auth.tokens ? 'chatgpt' : auth.OPENAI_API_KEY ? 'apikey' : '';
  } catch { return ''; }
}
const codexProfile = require('./engines/codex/profile').createCodexProfile({ home: CODEX_HOME, port: PROXY_PORT, apiKey: () => codexAuthMode() === 'apikey', format: () => require('./engines/codex/profile').codexProfileFormat(resolveCodex().path) });
function codexStatus() {
  const cli = resolveCodex();
  return { cli: cli.path, version: cli.version, candidates: cli.candidates, home: CODEX_HOME, authMode: codexAuthMode(), capture: codexCaptureEnabled(), proxyPort: Number(PROXY_PORT), profile: codexProfile.status() };
}
// ---------- engines ----------
const registry = createRegistry({ defaultEngine: 'claude' });
registry.addNode({ id: 'local', label: '本机', host: createLocalHost() });
// Registration order matters: Claude transcripts win id collisions with Codex threads.
registry.register(createClaudeEngine({
  accounts: accountRouter,
  transcripts: { path: transcriptPathFor, messages: id => sessionMessages(id, { limit: 0 })?.messages || [] },
}));
registry.register(createCodexEngine({
  sessions: codexSessions,
  // Panel-started Codex runs go through the capture proxy unless disabled; resumed threads keep their provider.
  capture: ({ provider }) => (provider ? provider === 'panel' : codexCaptureEnabled()) ? { config: codexProviderConfig(PROXY_PORT, { apiKey: codexAuthMode() === 'apikey' }) } : null,
}));
const manager = createSessionManager({
  registry,
  ensureNode: id => nodeHub.ensure(id),
  history: {
    async ownerOf(id) {
      const meta = sessionStore.read()[id] || {};
      if (meta.engine && registry.has(meta.engine)) return { engine: meta.engine, node: meta.node || 'local', project: meta.project, worktree: meta.worktree };
      // Unrecorded sessions (started in a terminal) can only be found on this machine.
      for (const engine of registry.node('local').engines.values()) if (await engine.owns(id)) return { engine: engine.id, node: 'local' };
      return null;
    },
    messages: id => sessionMessages(id),
    touch(id, { engine, node, cwd, worktree, prompt }) {
      const meta = sessionStore.read()[id] || {};
      const fp = transcriptPathFor(id);
      const created = engine ? { engine, ...(node && node !== 'local' ? { node } : {}), project: cwd, ...(worktree ? { worktree } : {}), initialPrompt: meta.initialPrompt || prompt, createdAt: meta.createdAt || Date.now() } : {};
      sessionStore.update(id, { ...autoTitlePatch(meta, prompt, fp ? transcriptHead(fp).title : ''), ...created, lastAt: Date.now() });
    },
  },
});

if (!HISTORY_WORKER) loadCaptures();
proxyServer.on('error', e => {
  // 端口被占等情况：只关掉 Inspector，别拖垮整个面板
  console.warn(`⚠ Inspector 代理未能在 ${PROXY_PORT} 启动（${e.code || e.message}）；面板其余功能正常。可设 PROXY_PORT=其它端口。`);
});
if (!HISTORY_WORKER) proxyServer.listen(PROXY_PORT, '127.0.0.1');

let cluster;
const clusterLeadership = { canStart: () => !cluster || cluster.canStart() };
const macRuntime = require('./mac-runtime').createMacRuntime({ dir: DATA_DIR, claudeDir: CLAUDE_DIR, serverPath: path.join(__dirname, 'server.js'), port: PORT, proxyPort: PROXY_PORT, claudeInfo: HISTORY_WORKER ? undefined : resolveClaude() });
const feishuGateway = require('./feishu-gateway').createFeishuGateway({
  dir: DATA_DIR, runtime: macRuntime, replyURL: `http://127.0.0.1:${PORT}/api/feishu/reply`, leadership: clusterLeadership,
  panel: {
    sessions: listSessions,
    projects: knownProjects,
    cluster: { status: () => cluster?.status() || { enabled: false, nodeId: 'local', role: 'leader', leader: 'local' }, transfer: target => cluster?.transfer(target) || Promise.reject(new Error('未配置集群')) },
    running: id => manager.busy(id) || !!accountRouter.sessions().items.find(item => item.id === id)?.running,
    submit: async ({ gatewayContext, ...input }) => {
      const run = manager.get(input.sessionId), live = run && !run.job.closed;
      if (!live && accountRouter.sessions().items.some(item => item.id === input.sessionId && item.running)) throw new Error('此会话正在外部 CLI 中运行，请等本轮结束后续接；可先用 /history 查看记录');
      if (live && (run.job.meta.model || '') === (input.model || '')) { manager.send(input.sessionId, { ...input, context: gatewayContext }); return { sessionId: run.id }; }
      const { sessionId, run: started } = await manager.start({ ...input, context: gatewayContext });
      return { sessionId, cwd: started.job.meta.cwd, worktree: started.job.meta.worktree };
    },
    engine: id => sessionEngine(id),
    engines: () => registry.list().map(engine => ({ id: engine.id, ...engine.meta, capabilities: engine.capabilities })),
    engineInfo: (engine, node = 'local') => registry.adapter(engine, node)?.detect?.() || {},
    models: ({ engine, sessionId, refresh }) => registry.get(engine)?.capabilities?.accounts ? accountRouter.models({ sessionId, refresh }) : Promise.resolve({ models: [] }),
    validModel: (engine, model, node = 'local') => !!(registry.adapter(engine, node) || registry.get(engine))?.validModel(model),
    currentModel: id => { const run = manager.get(id); return run && !run.job.closed ? run.job.meta.model || '' : ''; },
    nodes: () => nodeHub.list().filter(node => node.id !== 'local').map(node => ({ id: node.id, label: node.label, connected: node.connected, platform: node.platform, home: node.home })),
    routes: () => ({ ...accountRouter.status(), pins: accountRouter.sessions().routes }),
    route: input => accountRouter.route(input),
    resetRoutes: () => accountRouter.reset(),
    pinRoute: (id, accountId) => accountRouter.setSessionRoute(id, accountId),
    codex: () => { const { version, authMode, capture } = codexStatus(); return { version, authMode, capture }; },
    setCodexCapture: capture => writePanelConfig({ ...readPanelConfig(), codexCapture: capture }),
    watch: (id, listener) => manager.watch(id, listener),
    permission: async (id, requestId, behavior) => manager.respondPermission(id, requestId, behavior),
    pendingPermissions: id => manager.pendingPermissions(id),
    history: id => sessionMessages(id)?.messages || [],
    sessionPreviews: items => historyWorker.read('sessionPreviews', items),
    sessionUserPage: (item, page) => historyWorker.read('sessionUserPage', { item, page }),
    rename: (id, title) => { if (!listSessions().some(item => item.id === id)) throw new Error('会话不存在'); if (!title.trim() || title.trim().length > 80) throw new Error('名称需为 1–80 个字符'); sessionStore.update(id, { title: title.trim(), titleSource: 'manual' }); },
    stop: async id => { if (!manager.stop(id)) throw new Error('当前没有可停止的 Panel 任务；外部 CLI 进程请在其原入口停止'); },
  },
});

const larkSetup = require('./lark-setup').createLarkSetup({ dir: DATA_DIR, configure: input => feishuGateway.configure(input) });

// Usage annotations must never delay the resource list itself.
let resourceUsage, resourceUsageAt = 0, resourceUsagePending;
function resourceUsageSnapshot() {
  if (!resourceUsagePending && Date.now() - resourceUsageAt > 2000) {
    resourceUsagePending = historyWorker.read('usage').then(value => { resourceUsage = value; resourceUsageAt = Date.now(); }).catch(error => console.warn('资源用量统计：' + error.message)).finally(() => { resourceUsagePending = null; });
  }
  return resourceUsage;
}
// ---------- server ----------
const server = http.createServer(async (req, res) => {
  // 仅本机访问
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const parts = url.pathname.split('/').filter(Boolean); // e.g. ['api','skills','lark']
  const langParam = url.searchParams.get('lang');
  const lang = SUPPORTED_LANGS.includes(langParam) ? langParam : DEFAULT_LANG;
  // scope = 项目根路径；只接受 history 里出现过且仍存在的项目，防任意路径读写
  let scope = url.searchParams.get('scope') || '';
  if (scope && !knownProjects().includes(scope)) scope = '';

  try {
    if (req.method === 'GET' && ['/mermaid-ui.js', '/vendor/mermaid/mermaid.tiny.js'].includes(url.pathname)) {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
      return fs.createReadStream(path.join(__dirname, url.pathname.slice(1))).pipe(res);
    }
    if (url.pathname === '/feishu-ui.js' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(fs.readFileSync(path.join(__dirname, 'feishu-ui.js')));
    }
    if (url.pathname === '/panel.css' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(fs.readFileSync(path.join(__dirname, 'panel.css')));
    }
    if (parts[0] !== 'api') {
      // 静态页面
      if (auth.login(req, res, url)) { res.writeHead(302, { Location: '/' }); return res.end(); }
      if (!auth.pageAllowed(req)) { res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('需要访问令牌：请用启动日志中的链接打开面板'); }
      const html = fs.readFileSync(path.join(__dirname, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    // Every API route shares one Host/Origin/token guard.
    const denied = auth.check(req);
    if (denied) return sendJSON(res, 403, { error: denied });
    const type = parts[1];
    if (type === 'claude' && req.method === 'GET') { const info = resolveClaude(); return sendJSON(res, 200, { cli: info.path, version: info.version, source: info.source, candidates: info.candidates }); }
    if (url.searchParams.get('engine') === 'codex' && ['skills', 'config', 'commands', 'agents', 'plugins', 'workflows'].includes(type)) {
      if (parts.length > 3) return sendJSON(res, 404, { error: '资源不存在' });
      const requestedScope = url.searchParams.get('scope') || '';
      if (requestedScope && !scope) return sendJSON(res, 400, { error: '项目不在已知工作区内' });
      try {
        const input = ['POST', 'PUT'].includes(req.method) ? JSON.parse(await readBody(req) || '{}') : {};
        const result = codexResources.execute({ type, method: req.method, key: parts[2] ? decodeURIComponent(parts[2]) : '', scope, input });
        return sendJSON(res, result.status, result.data);
      } catch (error) { return sendJSON(res, error.status || 400, { error: error.message }); }
    }

    if (type === 'feishu') {
      res.setHeader('Cache-Control', 'no-store');
      if (req.method === 'GET' && parts[2] === 'messages') return sendJSON(res, 200, await feishuGateway.messages({ before: url.searchParams.has('before') ? url.searchParams.get('before') : undefined, userId: url.searchParams.get('userId'), chatId: url.searchParams.get('chatId') }));
      if (req.method === 'GET') return sendJSON(res, 200, { ...feishuGateway.status(), cliSetup: larkSetup.status() });
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return sendJSON(res, 415, { error: '需要 application/json' });
      if (req.method === 'POST' && parts[2] === 'contacts' && parts.length === 4) {
        try {
          if (parts[3] === 'refresh') return sendJSON(res, 200, await feishuGateway.refreshContacts());
          if (parts[3] === 'label') return sendJSON(res, 200, await feishuGateway.labelContact(JSON.parse(await readBody(req) || '{}')));
          return sendJSON(res, 404, { error: '联系人操作不存在' });
        } catch (error) { return sendJSON(res, 400, { error: error.message }); }
      }
      if (req.method === 'POST' && parts.length === 3 && parts[2] === 'reply') {
        try { return sendJSON(res, 200, await feishuGateway.sendReply(JSON.parse(await readBody(req)))); }
        catch (e) { return sendJSON(res, 400, { error: e.message }); }
      }
      if (req.method === 'POST' && parts.length === 3 && parts[2] === 'secret') return sendJSON(res, 200, { appSecret: feishuGateway.revealSecret() });
      if (req.method === 'POST' && parts[2] === 'setup') {
        const input = JSON.parse(await readBody(req) || '{}');
        if (input.cancel) { larkSetup.cancel(); return sendJSON(res, 200, larkSetup.status()); }
        if (input.repairCallbacks) return sendJSON(res, 202, await larkSetup.repairCallbacks());
        if (input.recover) return sendJSON(res, 200, await larkSetup.recover());
        return sendJSON(res, 202, await larkSetup.start(input.domain));
      }
      if (req.method === 'POST' && parts[2] === 'pairing') {
        if (feishuGateway.status().phase !== 'connected') return sendJSON(res, 409, { error: '请先连接机器人，再生成配对命令' });
        return sendJSON(res, 200, feishuGateway.newPairing());
      }
      if (req.method === 'POST' && parts[2] === 'connect') { await feishuGateway.start(); return sendJSON(res, 200, feishuGateway.status()); }
      if (req.method === 'PUT' && parts.length === 2) {
        const input = JSON.parse(await readBody(req));
        const result = await feishuGateway.configure(input);
        if (typeof input.autoStart === 'boolean') macRuntime.setAutoStart(input.autoStart);
        return sendJSON(res, 200, { ...result, runtime: macRuntime.status() });
      }
      return sendJSON(res, 405, { error: 'method not allowed' });
    }

    if (type === 'choose-folder' && req.method === 'POST') {
      if (folderPickerBusy) return sendJSON(res, 409, { error: '文件夹选择器已打开' });
      folderPickerBusy = true;
      try {
        const selected = await chooseFolder();
        const folder = selected ? fs.realpathSync(selected) : null;
        if (folder && !fs.statSync(folder).isDirectory()) return sendJSON(res, 400, { error: '请选择文件夹' });
        return sendJSON(res, 200, { path: folder });
      } finally { folderPickerBusy = false; }
    }

    if (type === 'cluster') {
      res.setHeader('Cache-Control', 'no-store');
      if (req.method === 'GET') return sendJSON(res, 200, cluster.status());
      if (req.method === 'POST' && parts[2] === 'transfer') {
        const { target } = JSON.parse(await readBody(req, 64 * 1024) || '{}');
        return sendJSON(res, 202, await cluster.transfer(String(target || '')));
      }
      return sendJSON(res, 404, { error: '接口不存在' });
    }

    if (type === 'nodes') {
      res.setHeader('Cache-Control', 'no-store');
      if (req.method === 'GET' && parts.length === 2) return sendJSON(res, 200, { nodes: nodeHub.list(), ...require('./node/connection-hint').connectionHint({ port: PORT, bindHost: BIND_HOST, token: auth.token }) });
      try {
        if (req.method === 'POST' && parts.length === 2) return sendJSON(res, 201, { node: nodeHub.add(JSON.parse(await readBody(req, 64 * 1024) || '{}')) });
        const id = decodeURIComponent(parts[2] || '');
        if (req.method === 'DELETE' && parts.length === 3) { req.resume(); return sendJSON(res, nodeHub.remove(id) ? 200 : 404, { ok: true }); }
        if (req.method === 'POST' && parts.length === 4 && parts[3] === 'reconnect') { req.resume(); nodeHub.reconnect(id); return sendJSON(res, 202, { ok: true }); }
      } catch (e) { return sendJSON(res, e.status || 400, { error: e instanceof SyntaxError ? 'JSON 格式无效' : e.message }); }
      return sendJSON(res, 404, { error: '接口不存在' });
    }
    if (type === 'engines' && req.method === 'GET') {
      return sendJSON(res, 200, { default: registry.defaultId(), engines: registry.list().map(registry.describe), nodes: registry.nodes().map(node => ({ id: node.id, label: node.label, remote: node.remote })) });
    }

    // Chat sessions run through the session manager, whatever the engine or node.
    if (type === 'chat' && ['POST', 'GET'].includes(req.method)) {
      const id = parts[2] ? decodeURIComponent(parts[2]) : '';
      if (req.method === 'GET' && parts.length === 3 && id === 'status') return sendJSON(res, 200, { running: manager.running() });
      if (req.method === 'GET' && parts.length === 4 && parts[3] === 'events') {
        const run = manager.get(id);
        if (!run) return sendJSON(res, 404, { error: '此任务已结束，请重新打开会话查看结果' });
        return run.job.subscribe(res);
      }
      if (req.method !== 'POST') return sendJSON(res, 405, { error: 'method not allowed' });
      if (parts.length === 4 && parts[3] === 'stop') {
        req.resume();
        manager.stop(id);
        return sendJSON(res, 200, { ok: true });
      }
      let input;
      try { input = JSON.parse(await readBody(req, 30 * 1024 * 1024)); } catch { return sendJSON(res, 400, { error: 'JSON 格式无效或请求过大' }); }
      if (typeof input.gatewayContext === 'string' && input.context === undefined) input.context = input.gatewayContext;
      try {
        if (parts.length === 4 && parts[3] === 'permission') {
          manager.respondPermission(id, input.id, input.behavior);
          return sendJSON(res, 200, { ok: true });
        }
        if (parts.length === 4 && parts[3] === 'input') return sendJSON(res, 202, { ok: true, ...manager.send(id, input) });
        if (parts.length !== 2) return sendJSON(res, 404, { error: '接口不存在' });
        const { run } = await manager.start(input);
        return run.job.subscribe(res);
      } catch (e) {
        if (!e.status) console.warn('会话启动失败：', e.message);
        return sendJSON(res, e.status || 400, { error: e.message });
      }
    }

    // Account credentials are only available through same-origin JSON management requests.
    if (type === 'proxy') {
      res.setHeader('Cache-Control', 'no-store');
      if (req.method === 'GET' && parts.length === 2) return sendJSON(res, 200, accountRouter.status());
      if (req.method === 'GET' && parts[2] === 'sessions') return sendJSON(res, 200, accountRouter.sessions());
      if (req.method === 'GET' && parts[2] === 'models' && parts.length === 3) {
        try { return sendJSON(res, 200, await accountRouter.models({ accountId: url.searchParams.get('accountId') || '', sessionId: url.searchParams.get('sessionId') || '', refresh: url.searchParams.get('refresh') === '1' })); }
        catch (error) { return sendJSON(res, 400, { error: error.message }); }
      }
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return sendJSON(res, 415, { error: '需要 application/json' });
      try {
        if (req.method === 'PUT' && parts.length === 2) return sendJSON(res, 200, accountRouter.save(JSON.parse(await readBody(req))));
        if (req.method === 'POST' && parts[2] === 'import') return sendJSON(res, 200, accountRouter.importSettings());
        if (req.method === 'POST' && parts[2] === 'setup') return sendJSON(res, 200, accountRouter.setup());
        if (req.method === 'POST' && parts[2] === 'reset') return sendJSON(res, 200, accountRouter.reset());
        if (req.method === 'PUT' && parts[2] === 'sessions' && parts.length === 4) return sendJSON(res, 200, accountRouter.setSessionRoute(decodeURIComponent(parts[3]), JSON.parse(await readBody(req)).accountId || ''));
        return sendJSON(res, 405, { error: 'method not allowed' });
      } catch (e) { return sendJSON(res, 400, { error: e instanceof SyntaxError ? 'JSON 格式无效' : e.message }); }
    }

    if (type === 'codex') {
      res.setHeader('Cache-Control', 'no-store');
      if (req.method === 'GET' && parts.length === 2) return sendJSON(res, 200, codexStatus());
      if (req.method === 'GET' && parts[2] === 'stats') return sendJSON(res, 200, await codexStats.read());
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return sendJSON(res, 415, { error: '需要 application/json' });
      let body; try { body = JSON.parse(await readBody(req) || '{}'); } catch { return sendJSON(res, 400, { error: 'JSON 格式无效' }); }
      if (req.method === 'PUT' && parts.length === 2) {
        if (typeof body.capture === 'boolean') writePanelConfig({ ...readPanelConfig(), codexCapture: body.capture });
        resolveCodex({ refresh: true });
        return sendJSON(res, 200, codexStatus());
      }
      if (req.method === 'POST' && parts[2] === 'profile') {
        codexProfile.install(!!body.remove);
        return sendJSON(res, 200, codexStatus());
      }
      return sendJSON(res, 405, { error: 'method not allowed' });
    }

    if (type === 'account-usage' && req.method === 'GET') {
      const byAccount = new Map();
      for (const r of captureStore.list()) {
        if (r.engine === 'codex') continue; // Codex 用量在 Codex 卡片单独展示
        const id = r.upstreamId || 'unknown';
        const row = byAccount.get(id) || { id, name: r.upstreamName || (id === 'unknown' ? '未标记账号' : id), requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, costKnown: true, lastUsedAt: '' };
        row.requests++;
        row.inputTokens += r.usage?.input_tokens || 0;
        row.outputTokens += r.usage?.output_tokens || 0;
        row.cacheReadTokens += r.usage?.cache_read_input_tokens || 0;
        row.cacheWriteTokens += r.usage?.cache_creation_input_tokens || 0;
        if (r.model && r.usage) {
          const value = { in: r.usage.input_tokens || 0, out: r.usage.output_tokens || 0, cr: r.usage.cache_read_input_tokens || 0, cc: r.usage.cache_creation_input_tokens || 0, c1: r.usage.cache_creation?.ephemeral_1h_input_tokens || 0 };
          const cost = costOf(r.model, value); if (cost === null) row.costKnown = false; else row.cost += cost;
        }
        if (!row.lastUsedAt || r.ts > row.lastUsedAt) row.lastUsedAt = r.ts;
        byAccount.set(id, row);
      }
      return sendJSON(res, 200, { accounts: [...byAccount.values()].sort((a, b) => b.requests - a.requests), limit: null, source: 'proxy-captures' });
    }

    // ---- 项目列表 ----
    if (type === 'projects' && req.method === 'GET') {
      return sendJSON(res, 200, { items: knownProjects().map(p => ({ path: p, name: path.basename(p) })) });
    }

    // ---- 航程 Voyage ----
    if (type === 'voyage' && req.method === 'GET') {
      return sendJSON(res, 200, voyageData());
    }

    // ---- 统计 ----
    if (type === 'stats' && req.method === 'GET') {
      const s = await historyWorker.read('stats');
      return s ? sendJSON(res, 200, s) : sendJSON(res, 404, { error: T(lang, 'errNotFound') });
    }

    // ---- 使用次数 ----
    if (type === 'usage' && req.method === 'GET') {
      return sendJSON(res, 200, await historyWorker.read('usage'));
    }

    // ---- Wrapped 分享卡片 ----
    if (type === 'wrapped' && req.method === 'GET') {
      const days = Math.max(0, parseInt(url.searchParams.get('days') || '7', 10) || 0);
      return sendJSON(res, 200, await historyWorker.read('wrapped', days));
    }

    // ---- 全局搜索 ----
    if (type === 'search' && req.method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim();
      if (q.length < 2) return sendJSON(res, 400, { error: T(lang, 'errQueryShort') });
      return sendJSON(res, 200, { q, results: await historyWorker.read('search', q) });
    }

    // ---- Statusline：终端状态栏一行文本 ----
    if (type === 'statusline' && req.method === 'GET') {
      const w = await historyWorker.read('wrapped', 1);
      const line = `$${w.cost.toFixed(2)} today · ${fmtK(w.tokens)} tok${w.topModel ? ' · ' + w.topModel.name : ''}`;
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(line);
    }

    // ---- Live（SSE，3 秒推送一次今日快照） ----
    if (type === 'live' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      let pushing = false;
      const push = async () => {
        if (pushing || res.destroyed) return; pushing = true;
        try { const snapshot = await historyWorker.read('live', lang); if (!res.destroyed) res.write(`data: ${JSON.stringify(snapshot)}\n\n`); } catch {}
        finally { pushing = false; }
      };
      push();
      const timer = setInterval(push, 3000);
      req.on('close', () => clearInterval(timer));
      return;
    }

    // ---- 面板配置（预算等） ----
    if (type === 'panel-config') {
      if (req.method === 'GET') return sendJSON(res, 200, readPanelConfig());
      if (req.method === 'PUT') {
        let cfg;
        try { cfg = JSON.parse(await readBody(req) || '{}'); } catch (e) { return sendJSON(res, 400, { error: T(lang, 'errJson') + e.message }); }
        writePanelConfig({ ...readPanelConfig(), ...cfg });
        _budgetNotifiedDay = ''; // 改预算后重置当日提醒
        return sendJSON(res, 200, { ok: true });
      }
      return sendJSON(res, 405, { error: 'method not allowed' });
    }

    // ---- Inspector 抓包 ----
    if (type === 'inspector') {
      if (req.method === 'GET') {
        if (parts.length === 2) linkCaptureSessions().catch(error => console.warn('历史抓包关联：' + error.message));
        else await linkCaptureSessions();
      }
      if (req.method === 'GET' && parts.length === 2) {
        if (url.searchParams.get('since') === String(captureStore.revision)) return sendJSON(res, 200, { unchanged: true, revision: captureStore.revision });
        return sendJSON(res, 200, {
          proxyPort: Number(PROXY_PORT),
          linking: !!captureLinkPromise,
          revision: captureStore.revision,
          items: captureStore.list().map(r => ({
            key: String(r.id), engine: r.engine || 'claude', sessionId: r.sessionId, startedAt: r.startedAt, purpose: r.purpose, purposeInferred: r.purposeInferred,
            name: `${shortModel(r.model || '?')} · ${r.status} · ${({ compaction: '压缩/摘要（推测）', title: '标题生成（推测）', count_tokens: 'Token 计数', models: '模型列表', oauth: '认证', other: '其他接口' })[r.purpose] || '模型请求'}`,
            description: `${r.upstreamName ? r.upstreamName + ' · ' : ''}${r.ts.slice(11, 19)}${r.clientVersion ? ' · cli ' + r.clientVersion : ''} · ${r.messagesCount} msgs · ${Math.round(r.durationMs / 1000)}s${r.hasThinking ? ' · 💭' : ''}`,
            origin: 'user',
          })),
        });
      }
      if (req.method === 'GET' && parts.length === 4 && parts[3] === 'navigation') {
        if (!captureStore.metadata(decodeURIComponent(parts[2]))) return sendJSON(res, 404, { error: T(lang, 'errNotFound') });
        return sendJSON(res, 200, { navigation: captureNavigationFor(decodeURIComponent(parts[2])) });
      }
      if (req.method === 'GET' && parts.length === 3) {
        const r = captureStore.get(decodeURIComponent(parts[2]));
        if (!r) return sendJSON(res, 404, { error: T(lang, 'errNotFound') });
        return sendJSON(res, 200, { ...r, ...captureStore.metadata(r.id), navigation: captureNavigationFor(r.id) });
      }
      if (req.method === 'DELETE' && parts.length === 2) {
        captureStore.clear();
        return sendJSON(res, 200, { ok: true });
      }
      return sendJSON(res, 405, { error: 'method not allowed' });
    }

    // ---- 配置包导出 / 导入 ----
    if (type === 'export' && req.method === 'GET') {
      const bundle = exportBundle();
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="my-agents-bundle.json"',
      });
      return res.end(JSON.stringify(bundle, null, 2));
    }
    if (type === 'import' && req.method === 'POST') {
      let bundle;
      try { bundle = JSON.parse(await readBody(req) || '{}'); } catch (e) { return sendJSON(res, 400, { error: T(lang, 'errJson') + e.message }); }
      if (!['my-agents-bundle', 'claude-panel-bundle'].includes(bundle.format)) return sendJSON(res, 400, { error: T(lang, 'errBadBundle') });
      return sendJSON(res, 200, importBundle(bundle));
    }

    // ---- 会话历史 ----
    if (type === 'sessions') {
      if ((req.method === 'PATCH' || req.method === 'DELETE') && parts.length === 3) {
        const id = decodeURIComponent(parts[2]);
        if (!listSessions().some(s => s.id === id)) return sendJSON(res, 404, { error: T(lang, 'errNotFound') });
        if (req.method === 'DELETE') {
          sessionStore.update(id, { deleted: true });
          return sendJSON(res, 200, { ok: true });
        }
        let input;
        try { input = JSON.parse(await readBody(req)); } catch { return sendJSON(res, 400, { error: 'JSON 格式无效' }); }
        const title = typeof input.title === 'string' ? input.title.trim() : '';
        if (!title || title.length > 80) return sendJSON(res, 400, { error: '请输入 1–80 个字符的会话名称' });
        sessionStore.update(id, { title, titleSource: 'manual' });
        return sendJSON(res, 200, { ok: true, title });
      }
      if (req.method === 'GET' && parts.length === 2) {
        res.setHeader('Cache-Control', 'no-store');
        const items = listSessions().map(s => ({
          name: (s.title || s.id).slice(0, 80),
          key: s.id,
          description: `${path.basename(s.project || '') || '?'} · ${s.count ? s.count + ' × · ' : ''}${s.last ? new Date(s.last).toISOString().slice(0, 10) : '?'}`,
          origin: 'user',
          titleSource: s.titleSource,
          engine: s.engine,
        }));
        return sendJSON(res, 200, { items });
      }
      if (req.method === 'GET' && parts.length === 4 && parts[3] === 'messages') {
        res.setHeader('Cache-Control', 'no-store');
        const id = decodeURIComponent(parts[2]), running = manager.get(id);
        if (running && !url.searchParams.has('before')) return sendJSON(res, 200, { ...running.baseHistory, id: running.id, project: running.job.meta.cwd, worktree: running.job.meta.worktree, messages: running.baseMessages, liveReplay: true, jobId: running.job.meta.jobId });
        const fp = transcriptPathFor(id) || codexSessions.pathFor(id);
        let revision = '';
        if (fp) { const st = fs.statSync(fp); revision = `${st.mtimeMs}:${st.size}`; }
        if (revision && url.searchParams.get('since') === revision) return sendJSON(res, 200, { unchanged: true, revision });
        const r = sessionMessages(id, { before: url.searchParams.has('before') ? url.searchParams.get('before') : undefined, limit: Math.max(1, Number(url.searchParams.get('limit')) || 80) });
        return r ? sendJSON(res, 200, { ...r, worktree: sessionStore.read()[id]?.worktree || null, revision }) : sendJSON(res, 404, { error: T(lang, 'errNotFound') });
      }
      if (req.method === 'GET' && parts.length === 4 && parts[3] === 'replay') {
        const r = sessionReplay(decodeURIComponent(parts[2]));
        return r ? sendJSON(res, 200, r) : sendJSON(res, 404, { error: T(lang, 'errNotFound') });
      }
      if (req.method === 'GET' && parts.length === 3) {
        const d = sessionDetail(decodeURIComponent(parts[2]), lang);
        return d ? sendJSON(res, 200, d) : sendJSON(res, 404, { error: T(lang, 'errNotFound') });
      }
      return sendJSON(res, 405, { error: 'method not allowed' });
    }

    // ---- 插件专区 ----
    if (type === 'plugins') {
      if (req.method === 'GET' && parts.length === 2) return sendJSON(res, 200, { items: listPlugins(lang) });
      if (req.method === 'GET' && parts.length === 3) {
        const d = pluginDetail(decodeURIComponent(parts[2]), lang);
        return d ? sendJSON(res, 200, d) : sendJSON(res, 404, { error: T(lang, 'errNotFound') });
      }
      if (req.method === 'DELETE' && parts.length === 3) {
        const fullName = decodeURIComponent(parts[2]);
        const manifest = readPluginManifest();
        if (!manifest.plugins[fullName]) return sendJSON(res, 404, { error: T(lang, 'errNotFound') });
        delete manifest.plugins[fullName];
        fs.writeFileSync(PLUGIN_MANIFEST, JSON.stringify(manifest, null, 2), 'utf8');
        return sendJSON(res, 200, { ok: true, note: T(lang, 'uninstallNote') });
      }
      return sendJSON(res, 405, { error: T(lang, 'errPluginOp') });
    }

    // ---- 配置专区 ----
    if (type === 'config') {
      const files = configFiles(lang, scope);
      if (req.method === 'GET' && parts.length === 2) {
        const items = [{ name: T(lang, 'cfgMergedName'), key: 'merged', description: T(lang, 'cfgMergedDesc'), origin: 'user' }]
          .concat(files.map(f => ({ name: f.name, key: f.key, description: f.desc, origin: 'user' })));
        return sendJSON(res, 200, { items });
      }
      // 合并视图：虚拟只读文件
      if (decodeURIComponent(parts[2] || '') === 'merged') {
        if (req.method !== 'GET') return sendJSON(res, 403, { error: T(lang, 'errConfigOp') });
        return sendJSON(res, 200, {
          name: T(lang, 'cfgMergedName'), path: T(lang, 'cfgMergedPath'), meta: {},
          content: mergedClaudeMd(lang, scope), origin: 'installed', config: true,
        });
      }
      const file = files.find(f => f.key === decodeURIComponent(parts[2] || ''));
      if (parts.length === 3 && !file) return sendJSON(res, 404, { error: T(lang, 'errNotFound') });
      if (req.method === 'GET' && parts.length === 3) {
        return sendJSON(res, 200, {
          name: file.name, path: file.path, meta: {},
          content: fs.readFileSync(file.path, 'utf8'),
          origin: 'user', lang: file.path.endsWith('.json') ? 'json' : 'md', config: true,
        });
      }
      if (req.method === 'PUT' && parts.length === 3) {
        const { content } = JSON.parse(await readBody(req) || '{}');
        if (typeof content !== 'string') return sendJSON(res, 400, { error: T(lang, 'errContentStr') });
        if (file.path.endsWith('.json')) {
          try { JSON.parse(content); } catch (e) { return sendJSON(res, 400, { error: T(lang, 'errJson') + e.message }); }
        }
        fs.writeFileSync(file.path, content, 'utf8');
        return sendJSON(res, 200, { ok: true });
      }
      return sendJSON(res, 405, { error: T(lang, 'errConfigOp') });
    }

    if (!TYPES[type]) return sendJSON(res, 404, { error: `unknown type: ${type}` });

    // GET /api/<type>  → 列表
    if (req.method === 'GET' && parts.length === 2) {
      let items = listItems(type, scope).map(it => ({ ...it, source: it.origin === 'installed' ? 'installed' : 'user', key: it.name }));
      if (type === 'commands' && !scope) {  // 项目作用域下只显示项目自己的命令
        items = items.concat(listPluginCommands(), builtinCommands(lang));
      }
      // 合并使用次数（全局作用域下才有意义）
      const usage = !scope ? resourceUsageSnapshot() : null;
      const uc = usage?.[type];
      if (uc) items = items.map(it => ({ ...it, uses: uc[it.name] || 0 }));
      return sendJSON(res, 200, { items, usagePending: !scope && !usage });
    }

    // GET /api/<type>/<name|key>  → 详情
    if (req.method === 'GET' && parts.length === 3) {
      const name = decodeURIComponent(parts[2]);
      // 内置命令：无磁盘文件，返回描述
      if (type === 'commands' && name.startsWith('b!')) {
        const b = builtinCommands(lang).find(c => c.key === name);
        if (!b) return sendJSON(res, 404, { error: T(lang, 'errNotFound') });
        const en = lang === 'en';
        return sendJSON(res, 200, {
          name: b.name,
          path: en ? '(built into Claude Code, no file on disk)' : '(Claude Code 内置命令，无磁盘文件)',
          meta: {},
          content: `# /${b.name}\n\n${b.description}\n\n> ${en ? 'This command is built into Claude Code and cannot be edited or deleted here.' : '这是 Claude Code 程序内置的命令，不能在面板中编辑或删除。'}`,
          origin: 'installed', builtin: true,
        });
      }
      // 插件命令/技能
      if (type === 'commands' && name.startsWith('p!')) {
        const fp = pluginCommandPath(name);
        if (!fp || !fs.existsSync(fp)) return sendJSON(res, 404, { error: T(lang, 'errNotFound') });
        const content = fs.readFileSync(fp, 'utf8');
        const { meta } = parseFrontmatter(content);
        return sendJSON(res, 200, { name: name.split('!').pop(), path: fp, meta, content, origin: 'installed' });
      }
      const fp = filePathOf(type, name, scope);
      if (!fp || !fs.existsSync(fp)) return sendJSON(res, 404, { error: T(lang, 'errNotFound') });
      const content = fs.readFileSync(fp, 'utf8');
      const { meta } = parseFrontmatter(content);
      return sendJSON(res, 200, {
        name, path: fp, meta, content,
        lang: fp.endsWith('.js') ? 'js' : undefined,
        origin: isInstalled(type, name, scope) ? 'installed' : 'user',
      });
    }

    // POST /api/<type>  → 新建 { name, content }
    if (req.method === 'POST' && parts.length === 2) {
      const { name, content } = JSON.parse(await readBody(req) || '{}');
      const fp = filePathOf(type, name, scope);
      if (!fp) return sendJSON(res, 400, { error: T(lang, 'errInvalidName') });
      if (fs.existsSync(fp)) return sendJSON(res, 409, { error: T(lang, 'errExists') });
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, content ?? '', 'utf8');
      return sendJSON(res, 201, { ok: true, path: fp });
    }

    // PUT /api/<type>/<name>  → 更新 { content }
    if (req.method === 'PUT' && parts.length === 3) {
      const name = decodeURIComponent(parts[2]);
      if (name.includes('!')) return sendJSON(res, 403, { error: T(lang, 'errCmdReadonly') });
      const fp = filePathOf(type, name, scope);
      if (!fp) return sendJSON(res, 400, { error: T(lang, 'errInvalidName') });
      if (!fs.existsSync(fp)) return sendJSON(res, 404, { error: T(lang, 'errNotFound') });
      if (isInstalled(type, name, scope)) return sendJSON(res, 403, { error: T(lang, 'errInstalledReadonly') });
      const { content } = JSON.parse(await readBody(req) || '{}');
      if (typeof content !== 'string') return sendJSON(res, 400, { error: T(lang, 'errContentStr') });
      fs.writeFileSync(fp, content, 'utf8');
      return sendJSON(res, 200, { ok: true });
    }

    // DELETE /api/<type>/<name>
    if (req.method === 'DELETE' && parts.length === 3) {
      const name = decodeURIComponent(parts[2]);
      if (name.includes('!')) return sendJSON(res, 403, { error: T(lang, 'errCmdDelete') });
      const fp = filePathOf(type, name, scope);
      if (!fp || !fs.existsSync(fp)) return sendJSON(res, 404, { error: T(lang, 'errNotFound') });
      const target = typesFor(scope)[type].layout === 'nested' ? path.dirname(fp) : fp;
      if (fs.lstatSync(target).isSymbolicLink()) {
        // 安装的资源：只移除链接本身，不动 ~/.agents 下的源文件
        fs.unlinkSync(target);
      } else if (typesFor(scope)[type].layout === 'nested') {
        fs.rmSync(target, { recursive: true, force: true });
      } else {
        fs.rmSync(target);
      }
      return sendJSON(res, 200, { ok: true });
    }

    sendJSON(res, 405, { error: 'method not allowed' });
  } catch (e) {
    sendJSON(res, 500, { error: e.message });
  }
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n⚠ 端口 ${PORT} 已被占用——面板可能已经在运行了：http://localhost:${PORT}`);
    console.error(`  直接在浏览器打开即可；或换端口启动：  PORT=其它端口 npx my-agents\n`);
  } else {
    console.error(`启动失败：${e.message}`);
  }
  process.exit(1); // 干净退出，不抛未捕获堆栈
});
// Remote nodes dial in over WebSocket on the panel port, or are launched over SSH.
// Claude and Codex on remote nodes go through this panel's proxy, relayed over the node link.
const nodeHub = require('./node/hub').createNodeHub({ registry, token: auth?.token, dir: DATA_DIR, routing: {
  target: `http://127.0.0.1:${PROXY_PORT}`,
  engines: {
    async claude(options) {
      const env = await accountRouteEnv(accountRouter, options);
      if (!env.ANTHROPIC_BASE_URL) return null;
      // Unless the run picks a model, use this panel's default rather than one pinned in the node's settings.
      if (!env.ANTHROPIC_MODEL) { try { const { model } = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'settings.json'), 'utf8')); if (typeof model === 'string' && model) env.ANTHROPIC_MODEL = model; } catch {} }
      return env;
    },
    // Codex uses this machine's Codex login, which never leaves it (see engines/codex/proxy.js).
    codex: Object.assign(() => {
      const mode = codexAuthMode() === 'apikey' ? 'api-key' : 'chatgpt';
      if (!codexCredentials(readCodexAuth(), mode)) return null;
      return { MY_AGENTS_CODEX_BASE: mode === 'api-key' ? '/codex-openai/v1' : '/backend-api/codex', [RELAY_TOKEN_ENV]: codexRelayToken };
    }, { accounts: false }),
  },
} });
let clusterNetwork = null;
let clusterConfig = null;
try { clusterConfig = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'panel-cluster.json'), 'utf8')); } catch {}
if (clusterConfig?.clusterId && clusterConfig?.nodeId && clusterConfig?.token && Array.isArray(clusterConfig.members)) {
  clusterNetwork = require('./node/cluster-peer').createClusterNetwork({ token: clusterConfig.token, selfId: clusterConfig.nodeId, members: clusterConfig.members });
  cluster = require('./core/cluster').createCluster({ dir: DATA_DIR, config: clusterConfig, network: clusterNetwork, gateway: feishuGateway });
} else cluster = require('./core/cluster').createStandalone(feishuGateway);
server.on('upgrade', (req, socket, head) => { if (clusterNetwork?.upgrade(req, socket, head)) return; if (!nodeHub.upgrade(req, socket, head)) socket.destroy(); });
if (!HISTORY_WORKER) server.listen(PORT, BIND_HOST, () => {
  console.log(`my-agents 已启动: http://localhost:${PORT}`);
  if (auth.requireToken) console.log(`远程访问链接（含令牌，勿外传）: http://<host>:${PORT}/?token=${auth.token}`);
  console.log(`管理目录: ${CLAUDE_DIR}`);
  if (DATA_DIR !== CLAUDE_DIR) console.log(`数据目录: ${DATA_DIR}`);
  console.log(`Inspector 代理: http://localhost:${PROXY_PORT}`);
  ensureProxyInstalled();
  feishuGateway.bootstrapRuntime();
  nodeHub.start();
  cluster.start().catch(e => console.warn('集群启动：' + e.message));
});
const stopPanel = async () => {
  const forceExit = setTimeout(() => process.exit(0), 8000); forceExit.unref();
  larkSetup.close();
  macRuntime.close();
  codexStats.close();
  historyWorker?.close();
  await cluster.stop().catch(() => {});
  manager.shutdown();
  nodeHub.stop();
  process.exit(0);
};
process.once('SIGTERM', stopPanel);
process.once('SIGINT', stopPanel);

if (HISTORY_WORKER) parentPort.on('message', ({ id, type, input }) => {
  try {
    const handlers = { stats: readStats, usage: usageCounts, wrapped: wrappedStats, live: liveSnapshot, search: searchTranscripts, captureOwners, sessionPreviews: readSessionPreviews, sessionUserPage: readSessionUserPage };
    if (!Object.hasOwn(handlers, type)) throw new Error('Unknown history operation');
    parentPort.postMessage({ id, value: handlers[type](input) });
  } catch (error) { parentPort.postMessage({ id, error: error.message }); }
});
