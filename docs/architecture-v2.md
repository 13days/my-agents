# my-agents 架构 v2：引擎 / 渠道 / 运行位置全面插件化

> 状态：P0–P5 已在 `refactor/arch-v2` 分支实现（2026-11-08）。第 1–4 节是设计稿，实际落地与设计的差异见第 6 节。

## 1. 现状诊断

### 1.1 根本问题：没有"引擎"这个抽象

项目里"引擎"只是一个字符串，且是**封闭的二值集合**：凡不是 `'codex'` 就当 `'claude'`。

| 位置 | 表现 |
|---|---|
| server.js | Claude 聊天逻辑 ~165 行内联在 HTTP handler（1999–2164）；Codex 是 `startCodexChat`；`/input` `/stop` `/permission` 靠鸭子类型的 `running` 对象，Codex 伪造了 `child`/`permissions`（1824–1825） |
| index.html | ~70 处引擎分支、6 处手写引擎列表、6 套引擎切换 UI、2 套完全不同的统计渲染器、按中文描述前缀正则猜抓包引擎（1391） |
| feishu-gateway.js | `'codex' ? 'Codex' : 'Claude Code'` 出现 15+ 次；`/codex` `/claude` 命令写死；卡片按钮列表写死 |
| 后端默认值 | 不带 `engine=codex` 就是 Claude；资源接口用 query 参数切引擎 |

加第三个引擎，需要改动的点超过 100 处，且多数是"默认落到 Claude"的静默错误。

### 1.2 Claude 与 Codex 的行为差异（大部分本不该存在）

| 能力 | Claude Code | Codex | 结论 |
|---|---|---|---|
| 进程模型 | 每会话一个长驻 `claude -p --input-format stream-json` | 每轮一个 `codex exec [resume]` | 合理差异，应被适配器吸收 |
| 会话 ID | 面板预分配 | CLI 返回后才知道 → 前端/飞书到处做临时 ID 映射 | **应由核心层统一分配稳定 ID**，引擎原生 ID 只做映射 |
| 文本输出 | 流式 delta | 仅 `item.completed` 整段 | 能力差异，事件协议要能表达 |
| 思考摘要 | 已解析 `thinking_delta` 但丢弃 | 有 `reasoning` | Claude 侧是遗漏 |
| 工具 | `Bash`/`Edit` + `tool_input` 增量 | `shell`/`apply_patch`；实时 ID 用 `msgId-itemId`，历史用 `call_id` → **重开会话后工具对不上** | 需要统一工具模型 + 修 bug |
| 插话/打断 | control_request 注入 | SIGINT 后 resume 重跑 | 两套几乎相同的队列（chat-session.js / codex-engine.js:148） |
| 权限 | `--dangerously-skip-permissions` + autoApprove | `--dangerously-bypass-approvals-and-sandbox`，respond 直接抛错 | **权限 UI/飞书授权卡片全部是死代码**，且无任何确认 |
| done 载荷 | `{cost, turns}` | `{cost:null, turns:1, usage}` | 统一为 usage + 可选 cost |
| 历史解析 | server.js 内，有缓存 | codex-sessions.js，无缓存 | 统一 Transcript Provider |
| 统计 | history-worker（费用/预算/Wrapped/搜索） | codex-stats（token/额度） | 统一 Usage 模型，专属视图作插件 |
| 抓包接入 | `--settings` env / shell rc 包装函数 | `-c` 覆盖 / config.toml profile | 应由适配器声明"如何指向代理" |
| 账号路由 | 多账号/故障转移 | 无 | Upstream 层能力，与引擎解耦 |
| 资源 | 命令/技能/智能体/插件/工作流/配置 | 技能/AGENTS.md/config.toml | Resource Provider 声明支持的类型 |
| 环境变量 | 正常 | **Codex 子进程被注入了 `claudeEnvironment`（CLAUDE_CLI、Claude 的 PATH）** | bug |

### 1.3 架构问题

1. **飞书网关通过 HTTP 回环调用自己的 `/api/chat`**，解析第一帧 SSE 拿 sessionId 后取消流（server.js:1722–1733）。原因是没有可调用的"启动会话"函数。
2. **server.js 是上帝文件**：CLI 安装、i18n、资源、历史分析、代理记录、飞书接线，加上一个 ~720 行按 `parts[n]` 匹配的路由函数；它同时还是 history worker 的入口。
3. **处处假设本机**：直接读 `~/.claude` `~/.codex`、`spawn`、`fs.realpathSync(cwd)`、原生文件夹选择器、代理地址写死 `127.0.0.1`、launchd/caffeinate、启动时改写 shell rc。
4. **状态散落**：`activeChats` 只在内存里，服务一重启所有运行中任务丢失（就是你截图里的 `Failed to fetch`）。飞书状态、会话元数据都放在 `CLAUDE_DIR` 里，渠道和面板的数据寄居在某个引擎的目录下。
5. **前端**：单文件 3000 行，~25 个顶层可变全局，三套 i18n（`t`/`ui`/`rt`，`rt` 不支持日文），网络断开直接把 `Failed to fetch` 抛给用户，离开聊天视图会丢掉 `meta`/`done` 事件。

### 1.4 安全

- `/api` **无鉴权**，只靠 loopback；Host/Origin 校验复制粘贴了 7 次，且**不带 Origin 的请求一律放行**。
- 未受保护的写接口包括 `config` PUT（写 Claude `settings.json`，hooks = 任意代码执行）、资源增删、`import`、`inspector` DELETE 等。
- 两个引擎都关闭了权限和沙箱；飞书消息可直接触发任意命令。
- 飞书 appSecret 明文存储，且有 `revealSecret` HTTP 接口。

**任何远程化之前，必须先有统一鉴权。**

---

## 2. 目标架构

```
┌──────────────────────────── Hub（面板服务）────────────────────────────┐
│  Channels            Core                              Registry        │
│  ┌────────┐   ┌──────────────────────────────┐   ┌──────────────────┐  │
│  │ Web    │──▶│ ConversationRouter            │   │ engines          │  │
│  │ Feishu │──▶│  绑定 / 命令 / 锁 / 视图归约   │   │ channels         │  │
│  │ Slack… │   ├──────────────────────────────┤   │ upstreams        │  │
│  └────────┘   │ SessionManager                │   │ nodes            │  │
│               │  稳定会话ID / 输入队列 / 停止  │   └──────────────────┘  │
│  HTTP API ───▶│  权限代理 / 事件日志(可重放)   │                         │
│  (鉴权中间件)  └──────────────┬───────────────┘   Capture & Upstreams   │
│                              │ EngineAdapter 接口  (代理/账号路由/抓包)  │
└──────────────────────────────┼─────────────────────────────────────────┘
                               │
              ┌────────────────┴────────────────┐
        LocalNode（进程内）               RemoteNode（开发机上的 my-agents node）
        Host = 本机 fs/spawn             Host = WebSocket RPC，CLI 在远端跑
        ├ claude adapter                 ├ claude adapter
        ├ codex adapter                  ├ codex adapter
        └ <future> adapter               └ …
```

核心原则：**Core 和 Channel 不认识任何具体引擎；Engine 不认识任何具体渠道；Engine 不直接碰本机，只通过 Host。**

### 2.1 Host：运行位置抽象

```js
/** @interface Host */
{
  id, label, platform,                 // 'local' | 'devbox-xxx'
  spawn(cmd, args, { cwd, env }),      // 返回 { stdin, stdout, stderr, kill, exited }
  exec(cmd, args, opts),               // 一次性命令（--version、npm prefix）
  fs: { read, write, list, stat, watch, realpath },
  homeDir(), tmpDir(),
  pickFolder?(),                       // 仅本机有原生选择器
  reach(port) → url,                   // 远端 CLI 如何回连 Hub 的抓包代理（反向隧道）
}
```

- `LocalHost`：包装 `child_process` 和 `fs`。
- `RemoteHost`：Hub 与 `my-agents node`（同一个 npm 包的子命令）之间用 WebSocket + JSON-RPC 通信，双向 token 鉴权。spawn 的 stdio 走多路复用流。
- macOS 的 launchd/caffeinate 降级为 `LocalHost` 的可选能力，不再散落在业务代码里。

### 2.2 EngineAdapter：引擎插件接口

```js
/** @interface EngineAdapter */
{
  id: 'codex',
  meta: { label: 'Codex', emblem, color },
  capabilities: {
    streamingText: false,
    reasoning: true,
    permissions: 'none' | 'ask' | 'policy',
    steer: 'inject' | 'restart' | 'none',
    images: 'inline' | 'file',
    models: { list: true, free: true },
    resources: ['skills', 'instructions', 'config'],
    usage: { tokens: true, cost: false, rateLimits: true },
    capture: true,
  },

  detect(host) → { installed, version, path, source },
  createSession(host, { cwd, model, nativeId?, policy, network }) → EngineSession,
  transcripts: { list(host), read(host, nativeId) → Message[], remove(host, nativeId) },
  resources?:  ResourceProvider,      // 声明式：类型、路径根、只读规则
  usage?:      UsageProvider,         // 输出统一 Usage 记录
  network?:    { configure(proxyUrl) → { env?, args?, cleanup? } },  // 如何把 CLI 指向抓包代理
  ui?:         { statsPanel?, connectionPanel? },                   // 前端插件模块名
}

/** @interface EngineSession */
{
  nativeId: Promise<string>,          // Codex 异步得到，Claude 立即 resolve
  send(input: { text, images, mode: 'steer'|'queue' }),
  stop(),
  respondPermission(id, decision),
  events: AsyncIterable<AgentEvent>,
  close(),
}
```

具体引擎只需实现适配器，放在 `engines/claude/`、`engines/codex/`，通过 `registry.register(adapter)` 注册。**新增引擎 = 新增一个目录**，不改 Core、Channel 和前端。

### 2.3 AgentEvent：统一事件协议 v1

```ts
type AgentEvent =
  | { type: 'session.ready',    sessionId, nativeId, engine }
  | { type: 'turn.started',     turnId, input }
  | { type: 'text.delta',       turnId, text }            // 不支持流式的引擎只发一次 completed
  | { type: 'text.completed',   turnId, text }
  | { type: 'reasoning.delta',  turnId, text }
  | { type: 'tool.started',     turnId, toolId, name, kind, input }   // kind: shell|edit|read|search|web|task|other
  | { type: 'tool.delta',       turnId, toolId, inputDelta }
  | { type: 'tool.completed',   turnId, toolId, output, isError }
  | { type: 'permission.requested', turnId, requestId, tool, input }
  | { type: 'permission.resolved',  requestId, decision, by: 'user'|'policy' }
  | { type: 'turn.completed',   turnId, usage: { input, output, cached, reasoning }, cost?, interrupted? }
  | { type: 'warning' | 'error', turnId?, code, message, retryable }
  | { type: 'session.idle' | 'session.closed' }
```

- 每个事件带递增 `seq`，SSE 用它作 `id:`，断线后用 `Last-Event-ID` 自动续传。
- `toolId` 由适配器保证实时和历史一致，修掉 Codex 重开会话后工具对不上的问题。
- 历史回放（`transcripts.read`）也输出同一套 `Message`/`ToolCall` 结构，前端只需要一个渲染器。

### 2.4 SessionManager：与引擎无关的会话运行时

- **稳定会话 ID**：Hub 统一分配 `sessionId`，持久化映射 `sessionId → { engine, node, nativeId, cwd }`。Codex 的临时 ID、`originalSessionId`、卡片 ID 翻译全部删除。
- **一个通用输入队列**：按 `capabilities.steer` 选择注入或重启策略，替代现在两套几乎重复的实现。
- **权限代理**：策略（`auto` / `ask` / `deny-dangerous`）按会话和渠道配置。引擎支持 `ask` 时把决策路由到发起渠道（网页按钮 / 飞书卡片），不支持时显式标记"此引擎无交互授权"，而不是保留死代码。
- **事件日志落盘**（每会话 jsonl，带 seq）：服务重启后能恢复"最后状态"，前端自动重连。正在运行的进程如何处理见第 4 节。
- 对外是普通函数调用：`manager.start()` / `send()` / `stop()` / `subscribe(sessionId, fromSeq)`。Web API 和飞书都直接调用它，**取消 HTTP 回环**。

### 2.5 Channel：渠道插件

```js
/** @interface ChannelAdapter */
{
  id: 'feishu',
  start(ctx), stop(),
  // 入站：把平台消息规范化后交给 router.receive({ channel, scopeKey, user, text, images, replyTo })
  // 出站：渲染 Core 归约出的 ConversationView
  renderer: { open(view) → handle, update(handle, view), finish(handle, view) },
  capabilities: { cards, edit, reactions, buttons, threads },
}
```

渠道无关的部分上移到 `core/conversation/`：

- 绑定（scopeKey → 每引擎会话）、每 scope 串行锁（**卡片按钮点击也必须进锁**）、去重
- 命令注册表：`/use <engine>`、`/new [engine] [path]`、`/sessions`、`/stop`。引擎命令从 registry 自动生成，`/codex`、`/claude` 作为别名保留兼容
- 视图归约器 `reduce(view, AgentEvent)`：一份实现，替代现在 detailed 模式和 simple-reply 两套
- 渠道上下文**不再拼进用户 prompt**：通过适配器的 `systemContext` 注入，或作为 MCP 工具暴露"发卡片"能力，避免污染会话记录

飞书只剩：SDK 连接、@ 解析、卡片和 Markdown 渲染、表情回应、图片下载、联系人、安装向导。

### 2.6 Capture & Upstreams：网络层

- `UpstreamProvider` 注册表：`anthropic`（多账号、故障转移、轮询、会话固定）、`openai-chatgpt`、`openai-api`。按请求路径或 header 匹配，**引擎通过 `network.configure(proxyUrl)` 声明如何接入**。
- 抓包记录直接携带 `engine` 和 `sessionId` 字段，前端不再靠描述文字猜。
- 账号路由能力属于 upstream，不属于引擎。未来 Codex 想要多账号，只需给 openai upstream 实现同一个接口。
- 远程节点：CLI 在远端，代理地址由 `host.reach(port)` 给出（Hub 监听 + 反向隧道，或 node 本地起一个转发代理，把记录回传 Hub）。
- 不再静默修改 shell rc。终端接入改为显式的"安装接入"按钮，可一键撤销。

### 2.7 HTTP API v2

```
GET    /api/v2/engines                       → [{ id, meta, capabilities, nodes:[{node, installed, version}] }]
GET    /api/v2/nodes                         → 本机 + 远端节点及在线状态
GET    /api/v2/sessions?engine&node&q        POST /api/v2/sessions    { engine, node, cwd, model, input }
GET    /api/v2/sessions/:id                  DELETE / PATCH
POST   /api/v2/sessions/:id/input            /stop   /permissions/:rid
GET    /api/v2/sessions/:id/events           SSE，支持 Last-Event-ID
GET    /api/v2/sessions/:id/messages
GET    /api/v2/engines/:id/resources/:type[/:key]     由 ResourceProvider 提供
GET    /api/v2/engines/:id/usage?range                 统一 Usage
GET    /api/v2/engines/:id/models
GET    /api/v2/captures …   /api/v2/upstreams …   /api/v2/channels/:id …
```

- 一个路由器（小型 path matcher，不引入框架）加一个**鉴权中间件**：
  - Host/Origin 校验，缺 Origin 的写请求必须带 token
  - 本机安装生成 token；页面通过启动时打开的一次性链接写入 cookie
  - 非 loopback 监听时强制开启
- 旧 `/api/*` 在过渡期保留，作为薄适配层转到 v2，前端迁移完再删。

### 2.8 前端

- 拆成原生 ES modules（无构建）：`web/core/`（api、store、sse、i18n、router）、`web/views/`、`web/engines/<id>.js`（专属统计面板、接入面板）。
- **能力驱动**：启动时拉取 `/api/v2/engines`。所有引擎列表、标签、图标、颜色、功能开关都从 registry + capabilities 读取，删掉全部 `=== 'codex'`。
- 一个统一的 `<engine-switch>` 组件替代 6 套切换 UI；一个消息和工具渲染器服务实时与历史。
- 一套 i18n（`t(key)`），合并 `ui()`/`rt()`，补齐日文。
- 网络层：统一错误分类（离线 / 服务重启 / 4xx / 5xx），SSE 自动重连 + `Last-Event-ID` 续传。不再显示 `Failed to fetch`。
- 聊天流的事件处理与当前视图解耦：事件写进会话 store，视图只订阅，离开再回来不丢状态。

### 2.9 数据目录

迁移到 `~/.my-agents/`（可用 `MY_AGENTS_HOME` 覆盖），带 `schemaVersion`：

```
~/.my-agents/
  config.json            面板配置
  secrets.json (0600)    飞书 secret、账号 key、节点 token（不再提供明文回显接口）
  sessions.json          sessionId → engine/node/nativeId/title/cwd
  events/<sessionId>.jsonl
  captures/
  channels/feishu/state.json
  nodes.json
```

~~首次启动时从 `CLAUDE_DIR` 下的旧文件自动迁移~~ → 实现改为显式迁移，见第 6 节。

---

## 3. 目录结构

```
src/
  server.js                 组装：加载 registry → 启动 Hub
  http/  router.js  auth.js  routes/{engines,sessions,captures,upstreams,channels,resources}.js
  core/
    registry.js             引擎/渠道/上游/节点注册
    events.js               AgentEvent 定义 + 校验
    session-manager.js  input-queue.js  permission-broker.js  event-log.js
    conversation/  router.js  bindings.js  commands.js  view-reducer.js
    store/                  原子写、带版本的 JSON 存储
  hosts/  local.js  remote.js  protocol.js
  node/   daemon.js         `my-agents node` 远端守护
  engines/
    claude/ index.js  session.js  transcripts.js  resources.js  usage.js  network.js  cli.js
    codex/  …（同结构）
  upstreams/ anthropic-accounts.js  openai.js  capture-proxy.js  capture-store.js
  channels/  web/  feishu/ {index,sdk,renderer,cards,markdown,contacts,inbox,setup}.js
web/  index.html  core/  views/  engines/
tests/
  contract/engine.contract.test.js     每个适配器都必须通过的契约测试（假 CLI 驱动）
  contract/channel.contract.test.js
```

**契约测试**是扩展性的保障：新引擎只要通过 `engine.contract.test.js`，Core、渠道和前端就能保证工作。

---

## 4. 迁移计划（每步可独立发布，测试保持全绿）

| 阶段 | 内容 | 用户可见收益 |
|---|---|---|
| **P0 安全与急修** | 鉴权中间件 + 统一 Origin/Host 校验 + token；修 Codex 环境注入、Codex 工具 ID 不一致、`recordExchange` 提前 return、飞书卡片点击不进锁和重复报错、私聊卡片绑定错位、`/input` 校验 cwd、部分写入；前端网络错误分类 | 安全；不再出现 `Failed to fetch` |
| **P1 引擎接口** | `core/events.js` + `EngineAdapter` + `SessionManager` + 通用输入队列；把 Claude 内联逻辑和 codex-engine 迁成两个适配器；`/api/chat` 和飞书改为直接调用 manager（去掉回环）；稳定会话 ID；事件日志落盘 + SSE 续传；契约测试 | 服务重启后可续看；两引擎行为一致；Claude 显示思考摘要 |
| **P2 Registry 驱动前端** | `/api/v2/engines`；前端拆模块；能力驱动替换约 70 处分支；统一 i18n；统一消息渲染 | 加引擎时前端零改动 |
| **P3 渠道核心** | 从飞书抽出 bindings/commands/locks/view-reducer；Web 聊天也走 ConversationRouter；渠道上下文改为系统注入或 MCP 工具 | 加 Slack 等渠道只需写 transport + renderer |
| **P4 Host 抽象 + 数据目录** | 所有 fs/spawn 改走 Host；资源、历史、统计改为 Provider；数据迁移到 `~/.my-agents`；Upstream 注册表 | 为远程化铺路 |
| **P5 远程节点** | `my-agents node` 守护 + RemoteHost + 节点管理 UI + 抓包代理回连 | 连接开发机上的 Claude Code / Codex |
| **P6 权限** | 权限代理打通，支持按渠道 `ask` 策略（引擎支持时） | 飞书和网页上真正可用的授权确认 |

### 关于"服务重启任务中断"

P1 的事件日志能保证重启后**看得到**完整进度。要让任务**不因重启中断**，需要把引擎进程放在独立的 runner 进程里，Hub 重启时只断开再重连。这一点和 P5 的 node 守护是同一个机制：本机也跑一个 local node，Hub 只是它的客户端。建议 P5 一并完成，P1 先做到"可续看 + 明确提示"。

---

## 5. 决策结果

1. **旧 API**：`/api/*` 保留，事件名不变（meta、input、turn、text、reasoning、tool、tool_input、tool_result、permission、permission_resolved、warning、error、done、idle、stopped、end），未引入 `/api/v2`。
2. **权限**：保持全自动。
3. **远程连接**：两种都支持——节点主动连 Hub（WebSocket），以及 Hub 通过 SSH 启动 `my-agents node --stdio`。
4. **依赖**：引入 `ws`（此前已作为飞书 SDK 的传递依赖安装）。

## 6. 实现状态与设计差异

### 6.1 模块

| 模块 | 职责 |
|---|---|
| `core/registry.js` | 节点 → 引擎；`adapter(engine, node)`、`describe`、`find`（id / 名称 / 别名） |
| `core/session-manager.js` | 运行中会话、ID 别名（Codex 由 CLI 生成 ID）、空闲与保留计时、就绪前事件缓冲 |
| `core/turn-queue.js` | 所有引擎共用的输入队列（排队 / 插话 / 打断） |
| `core/upstreams.js` | 抓包代理按路径分发；各上游自带抓包解析 |
| `core/data-dir.js` | 面板数据目录解析与迁移 |
| `engines/claude`、`engines/codex` | 适配器：`{ id, meta, capabilities, detect, validModel, owns, open }` |
| `hosts/local.js` | 本机 Host：spawn、resolveDir、只读文件访问 |
| `channels/engine-catalog.js` | 渠道侧的引擎名称、别名、能力查询；飞书不再判断具体引擎 id |
| `http/auth.js` | Host 白名单、Origin 校验、非 loopback 强制 token |
| `node/` | 远程节点：`rpc` `transports` `agent`（节点侧） `remote`（Hub 侧代理适配器） `hub`（接入与 SSH 管理） `daemon`（CLI） |

### 6.2 与设计稿的差异

- **远程化在适配器层，而不是 Host 层。** 设计稿里 RemoteHost 把 spawn 和 fs 通过 RPC 转发；实际上 Hub 与节点之间传的是"会话"级 RPC（`session.open/submit/stop`，事件以通知回传）。CLI 进程、stdio 解析、引擎特有逻辑全部在节点本地跑，网络上只有事件。好处：协议小、对延迟不敏感、断线语义清晰。
- **事件协议沿用现有事件名**，没有改成 `turn.started` 之类的点号命名。前端、飞书、测试都不用迁移。
- **数据目录不自动迁移。** 本机上旧版面板可能仍在运行并写 `~/.claude/panel-*`，自动搬迁会让两边数据分叉。规则：`MY_AGENTS_HOME` > `~/.my-agents`（存在即启用）> 旧目录。`my-agents migrate-data` 只复制、不覆盖、保留原文件。Claude 自己的 `settings.json` 和会话记录仍在 `CLAUDE_DIR`。
- **事件日志落盘、SSE 续传、前端 ES module 拆分、权限代理（P6）尚未实现。**

### 6.3 远程节点用法

```bash
# 方式一：开发机主动连 Hub（Hub 需监听非 loopback：MY_AGENTS_BIND=0.0.0.0）
my-agents node --hub ws://<hub 地址>:4321 --token <Hub 数据目录下 panel-token 的内容> --id devbox

# 方式二：Hub 通过 SSH 启动（要求免密登录，且远端 PATH 中有 my-agents）
curl -X POST localhost:4321/api/nodes -H 'Content-Type: application/json' \
  -d '{"id":"devbox","label":"云端开发机","ssh":"me@devbox"}'
```

- `GET /api/nodes` 列出本机、在线节点和已保存的 SSH 节点（含状态和最近错误）；`DELETE /api/nodes/:id`；`POST /api/nodes/:id/reconnect`。
- 面板「接入」页底部的「远程节点」区域提供同样的操作：查看节点状态和引擎版本、复制 WebSocket 接入命令、添加/删除/重连 SSH 节点；节点变化后引擎列表会自动刷新。
- `POST /api/chat` 带 `"node":"devbox"` 即在该节点上启动会话；之后的接续、停止、插话自动走会话所属节点（记录在会话元数据的 `node` 字段）。
- 飞书：`/node` 查看并切换当前话题的运行位置（本机 / 远程节点），`/node devbox ~/repos/项目` 直接切到节点上的目录；会话卡片有「切换运行位置」按钮。每个话题按「引擎 × 节点」记住上一次会话，`/new`、`/projects`、`/claude`、`/codex` 都留在当前节点。
- 节点断开时，其上运行中的会话收到 `error` 并结束；SSH 节点 30 秒后自动重连，WebSocket 节点由 daemon 指数退避重连。

### 6.4 已知限制

- 远程会话的历史回放、会话标题来自 Hub 的会话元数据；节点上的 transcript 不回传，重开远程会话时看不到之前的消息正文。
- 远程节点上的 Claude 和 Codex 经节点链路中继到 Hub 的代理（`node/relay.js`），请求进 Inspector。Claude 用 Hub 的账号路由；Codex 用 Hub 机器的 Codex 登录：节点只拿到面板进程内的中继令牌，代理在 Hub 侧换成 `~/.codex/auth.json` 的凭据，刷新只发生在 Hub 机器上。其他引擎使用节点本机 CLI 的登录。
- Claude 的工具结果补齐（transcript 同步）在远程节点上关闭。
- Codex 工具调用 ID 在实时流与历史中不同。
