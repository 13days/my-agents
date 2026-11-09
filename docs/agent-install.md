# 给 Agent 的 my-agents 安装协议

本文件可以全文复制给编码 Agent。它是一份执行任务的说明，不需要用户先手动逐项安装。项目主页：https://github.com/13days/my-agents 。配套说明：[使用手册](user-guide.md)、[集群搭建](cluster-setup.md)。

---

你是负责部署 my-agents 的安装 Agent。请完成下列可执行工作，并交付经过检查的环境。my-agents 是外部 Claude Code / Codex 的使用面板与代理，不负责自行提供模型或重新实现 Agent。

## 一、输入与默认选择

向用户收集或从现有环境探测：

```yaml
mode: auto                  # single / cluster / execution-node / auto
repository: https://github.com/13days/my-agents.git
ref: main                   # 首台解析成确定 Git SHA，所有机器使用该 SHA
machines:
  - id: panel-a             # 集群成员稳定 ID，不使用 local
    ssh: local              # 或 user@host；不要填写密码 / token
    panel_url: auto         # 集群必须是其他成员可达的 http(s) URL
    source_dir: auto        # 优先复用已有正确来源，不能覆盖其他项目
    data_dir: auto          # 优先沿用正在运行的服务实际数据目录
    role: full              # full / execution / witness
projects: []                # 项目名和各机器路径；先探测，缺失时再询问
im: optional               # Feishu / Lark，凭证从私密输入或已有配置取得
```

没有库存时，先探测本机。单机模式可直接安装；用户要求集群但未提供远程主机时，只询问缺少的 SSH 目标和成员间可达地址，同时继续准备本机。推荐三台完整面板；两台完整面板不能在任意一台离线后保持严格多数派。见证节点仅用于明确需要该拓扑的情况。

不得编造机器、SSH 权限、可达地址、登录状态或机器人凭证。需要本人浏览器登录或管理员权限时，只暂停依赖它的步骤，继续其他已授权准备工作。

## 二、先探测，保留已有数据

每台机器记录以下信息，输出只包含脱敏摘要：

1. 操作系统、用户、主目录、Git / Node / npm 版本，`command -v node` 与 npm 全局前缀。
2. 4321 / 4322 端口、现有 my-agents 进程、PID、实际命令行和工作目录；Linux 用户服务、macOS LaunchAgent 的真实配置。
3. 已有 Git remote、分支、SHA、未提交修改和运行源码来源。旧目录可能是符号链接，不按文件夹名字判断仓库。
4. 实际 `MY_AGENTS_HOME`、`CLAUDE_DIR`、`CODEX_HOME` 和数据是否存在。
5. Claude Code / Codex 的二进制路径、版本、授权是否可用。不要输出认证文件、access token 或 refresh token。
6. 是否已有集群身份、成员与 IM 配置；是否正在执行面板任务或外部代理请求。

面板数据目录规则：显式 `MY_AGENTS_HOME` 优先；否则已存在的 `~/.my-agents`；否则兼容 Claude 数据目录（通常 `~/.claude`）。集群 CLI 默认写 `~/.my-agents`，因此在所有集群 CLI 和服务操作中都必须显式使用探测到的同一个 `MY_AGENTS_HOME`。

在私密目录备份现有面板数据、服务配置、集群配置和账号库；记录原生历史、项目及 worktree 位置，不改变它们。目录权限 0700，私密文件 0600。不把备份、密钥、会话历史或抓包提交到 Git。数据量大时先选择一致性备份方式并报告范围，不能声称只备份配置就覆盖了全部会话数据。

保留其他人的未提交改动；只允许安全快进或新建独立源码目录。禁止强制 reset、批量删除工作区、覆盖原生 CLI 授权、覆盖另一个集群身份或盲目运行 `cluster init`。

## 三、安装源码与外部 CLI

当前 npm 包尚未发布。新环境从源码安装：

```bash
git clone https://github.com/13days/my-agents.git <选定的源码目录>
cd <选定的源码目录>
npm install
npm test
```

首台解析请求的 ref，记录确定 Git SHA。其余机器检出同一 SHA，执行依赖安装和适当检查。仓库没有前端构建步骤，但 `ws` 是必需依赖，不能省略 `npm install`。飞书 / Lark 使用可选官方 SDK，启用 IM 时确保未跳过该依赖。现有锁文件可能与元数据不一致，采用 `npm install` 并检查结果，不把 `npm ci` 当作无条件可行的替代。

统一使用 `node /源码绝对路径/server.js` 调用 CLI，避免依赖尚未配置的全局 `my-agents` 命令。无须为了部署先发布 npm 包。

在每台要执行任务的机器，检查现有安装来源，按可写 npm 前缀更新或安装：

```bash
npm install --global @openai/codex@latest @anthropic-ai/claude-code@latest
codex --version
claude --version
```

先检测 npm 前缀权限和现有包管理方式；必要时使用用户可写前缀，并备份修改的 shell / npm 配置，保证后台服务 PATH 一致。不要用 sudo 覆盖不属于本任务的安装，也不要删除旧二进制来掩盖 PATH 问题。

CLI 首次订阅登录可要求用户走正常浏览器授权。若已有可用共享账号池，复用它，不要求各机器重复登录同一账号。需要导入认证 JSON 时使用私密文件 / 本机接口，绝不在聊天、日志或命令行中打印完整内容。

## 四、按模式部署

### 单机

保留现有数据目录；新环境可选择 `~/.my-agents`。显式设置 `MY_AGENTS_HOME`，先只在回环地址启动。自动安装过程使用 `MY_AGENTS_NO_PROXY_SETUP=1`，避免未经说明修改终端代理包装。

确认网页、引擎和项目可用后配置常驻服务。若用户需要远程连接，再使用明确的监听地址，并配置网络访问边界。

### 三台完整面板集群

1. 为 A/B/C 确认稳定 ID、可达 URL、数据目录和源码路径。完整成员均运行面板，不能以普通执行节点代替。
2. 新集群在 A 上生成一次身份；已有集群保留原身份。
3. A 添加 B、C 后才取得最终成员表。命令输出含秘密，定向到 0600 文件，不显示到聊天：

```bash
# 所有命令在已确定的源码目录执行；MY_AGENTS_HOME 已显式设置
node server.js cluster init --id panel-a --url http://panel-a.example.internal:4321
node server.js cluster add --id panel-b --url http://panel-b.example.internal:4321 > "$MY_AGENTS_HOME/join-b.private.txt"
node server.js cluster add --id panel-c --url http://panel-c.example.internal:4321 > "$MY_AGENTS_HOME/join-c.private.txt"
```

示例域名须替换，不能原样部署。创建前设置私密 umask；不要在已经运行的生产集群上覆盖身份。`cluster add` 只更新当前配置，不会自动分发。

4. 使用验证过的 SSH 私密通道，将 A 最终 `panel-cluster.json` 分发给所有成员。每台配置保持相同 `clusterId`、`token`、完整 `members`，仅改本机 `nodeId`。不要把添加 B 时尚未包含 C 的载荷留在 B 上。
5. 可以把原始 JSON 经 `node server.js cluster join --stdin` 写入。stdin 输入为 JSON，普通 `join '<载荷>'` 才是编码内容。遇到另一个集群身份时停止调查，不使用 `--force` 自动覆盖。
6. 同一真实数据目录用于集群 CLI 与服务，面板监听其他成员可达的接口。逐台启动并检查连通与多数派；配置完成前不宣称高可用。
7. 配置同一机器人并验证唯一有效 IM 主节点。所有成员的 Git SHA、程序来源和配置均核对，不能以 npm 版本号相同代替。

`cluster status` 会输出含密钥的完整配置，不将结果回显到用户。需要状态摘要时使用脱敏字段或面板受保护的状态 API。

### 执行节点

安装源码与 CLI，准备项目与依赖。通过面板生成的接入信息建立 SSH 或 WebSocket 通道。源码方式可运行：

```bash
# 令牌通过私密环境设置，不直接写进聊天或脚本仓库
MY_AGENTS_TOKEN=<从安全输入取得> node /源码绝对路径/server.js node --hub ws://面板可达地址:4321 --id worker-a
```

也可从面板通过 SSH 启动 `node /源码绝对路径/server.js node --stdio`。接入令牌与模型账号不同；加入执行通道不代表加入集群选举，也不自动克隆项目或配置节点常驻。

### 见证节点（仅明确选择时）

以 `cluster add --witness` 注册，并分发最终成员表。它不执行 Agent、不接收 IM，也不保存完整共享账号状态。显式运行：

```bash
node /源码绝对路径/server.js witness --config /实际数据目录/panel-cluster.json
```

不要用 `service install` 给见证安装完整面板。需要常驻时生成独立系统服务，使用实际解析出的 Node 绝对路径、上述 witness 参数、明确数据与工作目录、重启策略和私密权限。核对进程确实为 witness。两完整面板加见证的账号刷新可用性不同于三完整面板，向用户说明。

## 五、常驻、账号和项目准备

Linux 完整面板使用自带服务命令：

```bash
node server.js service install --home "$MY_AGENTS_HOME" --bind <127.0.0.1或需要的可达监听地址>
node server.js service status
```

它安装 `my-agents-panel.service` 用户服务，记录实际源码和 Node 路径，并捕获 PATH。已运行服务的 install 不保证重启；更改配置后先检查任务与代理请求空闲，再有序 restart。检查退出 SSH 后的服务生存条件；需要 linger 且无权限时列出需要管理员做的唯一操作。

macOS 使用面板提供的登录自动启动能力，检查生成的 LaunchAgent 的源码、Node、数据目录和监听参数。不要另起重复进程抢占端口。自动启动不等于关机可用。

将逻辑项目映射到各机器真实目录；先检查目录存在、权限、Git 状态和依赖，再保存映射。不将 Mac 绝对路径自动发给 Linux。已有会话的机器、目录、引擎必须保持绑定；`/new` 的新选择只影响新会话。

账号池配置完成后查看脱敏账号状态和实时模型目录。默认 Codex 模型应取账号可用目录，不硬编码模型名。手动覆盖存在时检查它是否受支持。按需要保留多个订阅、明确路由模式；不要为“共享”而把所有机器的原生 auth 文件互相覆盖。

飞书 / Lark 使用企业自建应用、机器人、长连接消息事件与卡片事件。App Secret 通过私密配置输入；配对码交用户私聊机器人完成。安装 Agent 不擅自给真实群或用户发送测试消息。

## 六、验收，不能只说“已安装”

逐机交付以下经过实际检查的结果：

- Git SHA、源码绝对路径、实际运行进程来源 / PID、服务类型、加载新代码的时间。
- Node 与 CLI 实际路径和版本；后台服务 PATH 能解析到已验证安装。
- 网页面板访问地址、监听与端口，所有目标节点连接状态。
- 集群成员表一致、在线多数派满足、有效 IM 主节点明确，机器人连接状态可解释。
- 项目逐机目录映射正确，旧会话仍绑定原机器，新建任务改机器不改变旧绑定。
- 账号池的脱敏可用状态，模型目录可读取；不展示原始凭证。
- 原有数据位置、备份位置与恢复方式；没有丢弃会话、抓包、原生历史或工作区。
- 执行适当自动测试，使用无外部副作用的检查验证执行链路；发送真实 IM 测试消息需用户明确授权。

计划内接管先用手动移交，在空闲且可恢复服务的条件下逐台验证；保持多数派，不中断其他人的工作。运行任务和外部代理请求都要检查，不强制重启忙碌机器。没有重新加载的机器明确列出原因。

不要声称“完整恢复正在运行的任务”。集群使用有限对话检查点，不自动复制整个原生历史、仓库和 worktree，不迁移 CLI 进程。断线命令可能已经执行，不能自动重放有副作用的操作。

## 七、失败与回滚

遇到失败给出具体机器、步骤、脱敏原因和下一步。保留已成功安装的环境与用户数据；停止依赖失败项的步骤，继续独立工作。需要恢复时使用备份与记录的原提交 / 服务配置，在空闲后进行，不覆盖更新的数据与其他人的修改。

最终回复使用简短部署表：机器、角色、Git SHA、服务、连通、CLI、待办；附可打开的面板入口、私密备份位置和必要的人工授权步骤。所有剩余项都写明，未验证的状态标为未验证。
