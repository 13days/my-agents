# 集群搭建与维护

[首页](../README.md) · [使用手册](user-guide.md) · [交给 Agent 安装](agent-install.md)

本手册以三台完整面板为推荐方案。示例主机名仅为占位，请替换为成员间真实可达的地址。已有集群不要重新执行 `cluster init`，先备份并核对现有身份。

## 1. 先选择拓扑

| 类型 | 保存面板状态 / 账号 | 可接管 IM | 执行 Agent | 投票 |
| --- | --- | --- | --- | --- |
| 完整面板 | 是 | 是 | 安装 CLI 后可以 | 是 |
| 执行节点 `node` | 不持有完整共享账号库 | 否 | 是 | 否 |
| 见证节点 `witness` | 否 | 否 | 否 | 是 |

推荐 **三台完整面板**：任意一台离线，另外两台仍构成多数派。也支持两台完整面板加一个独立见证节点；见证节点只帮助选举，不承担完整状态与凭证复制。两完整面板中有一台离线时，账号刷新等需要完整成员确认的操作可能受限，因此它不是三完整面板的等价替代。

两台完整面板没有第三票时，一台失联就无法形成严格多数派。不要为了“可用”让两边都强制接收机器人消息。

## 2. 准备所有机器

每台完整面板需要：

1. Git、Node.js ≥ 18，同一个 my-agents Git 提交，执行过 `npm install`。
2. 固定的机器 ID，例如 `panel-a`、`panel-b`、`panel-c`，不可都叫 `local`。
3. 成员互通的面板地址，例如 `http://panel-a.example.internal:4321`。成员应能相互访问，不能使用仅自己可达的 localhost。
4. 明确的数据目录、原生 CLI 目录和服务账号；已有数据先备份。
5. 要执行任务的机器安装 Claude Code / Codex，检查实际二进制与版本。共享池中的同一订阅无需在每个完整面板重新登录。

私网或 VPN 可使用受保护的内网地址；跨不可信网络需配置 TLS 和访问控制。`MY_AGENTS_BIND=0.0.0.0` 表示允许监听所有接口，不代表系统自动配置防火墙或公网安全。

新环境中，每台分别执行并记录所用 Git SHA：

```bash
git clone https://github.com/13days/my-agents.git "$HOME/src/my-agents"
cd "$HOME/src/my-agents"
npm install
export MY_AGENTS_HOME="$HOME/.my-agents"
mkdir -p "$MY_AGENTS_HOME"
chmod 700 "$MY_AGENTS_HOME"
git rev-parse HEAD
```

先固定第一台的已验证 SHA，其他机器检出同一提交，避免安装过程中 main 更新导致版本不同。已有环境保留真实源码与数据位置；不要直接套用示例路径。若暂时缺少 npm 网络，解决依赖安装后再启动，不要跳过必需依赖。

## 3. 在 A 生成最终成员表

以下仅用于新集群；此时不要先在各机器分别初始化：

```bash
cd "$HOME/src/my-agents"
export MY_AGENTS_HOME="$HOME/.my-agents"
node server.js cluster init --id panel-a --url http://panel-a.example.internal:4321
node server.js cluster add --id panel-b --url http://panel-b.example.internal:4321 > "$MY_AGENTS_HOME/join-b.private.txt"
node server.js cluster add --id panel-c --url http://panel-c.example.internal:4321 > "$MY_AGENTS_HOME/join-c.private.txt"
chmod 600 "$MY_AGENTS_HOME/panel-cluster.json" "$MY_AGENTS_HOME/"*.private.txt
```

`cluster add` 只修改本机配置，不会自动分发给已有成员；输出的加入内容含集群密钥，应私密保存。添加 B 时输出的内容尚不包含 C，**不能只给 B 使用那份旧内容就算完成**。应使用最后生成的 `panel-cluster.json` 作为统一成员表。

所有完整成员的 `clusterId`、`token`、`members` 必须相同；只有 `nodeId` 分别不同。不要把 `cluster status` 的完整输出贴到聊天或公开日志，它包含密钥。

## 4. 将最终配置安全分发给 B 和 C

通过已验证的 SSH 通道复制 A 上最终的配置，在目标机器作为私密临时文件保存。下面仅演示 B：

```bash
# 在 A 执行；将 SSH 目标替换为自己的机器
ssh user@panel-b.example.internal 'umask 077; mkdir -p "$HOME/.my-agents"; cat > "$HOME/.my-agents/cluster-join.private.json"' < "$MY_AGENTS_HOME/panel-cluster.json"
```

在 B 上修改本机身份，再交给已支持的 stdin 加入命令：

```bash
cd "$HOME/src/my-agents"
export MY_AGENTS_HOME="$HOME/.my-agents"
node -e 'const fs=require("fs"); const c=JSON.parse(fs.readFileSync(process.env.MY_AGENTS_HOME+"/cluster-join.private.json","utf8")); c.nodeId="panel-b"; process.stdout.write(JSON.stringify(c));' | node server.js cluster join --stdin
rm "$MY_AGENTS_HOME/cluster-join.private.json"
```

对 C 重复执行，使用 C 的 SSH 目标和 `nodeId="panel-c"`。A 保留 `panel-a`。stdin 接收原始 JSON；普通 `cluster join '<内容>'` 则接收 CLI 输出的编码载荷，两者不要混用。

已有完整成员也必须得到包含所有成员的最终配置。若检测到属于另一个集群，停止并调查，不要直接加 `--force` 覆盖身份或账号密钥。

## 5. 启动常驻服务

### Linux 完整面板

在每台 Linux 面板的源码目录运行：

```bash
export MY_AGENTS_HOME="$HOME/.my-agents"
node server.js service install --home "$MY_AGENTS_HOME" --bind 0.0.0.0
node server.js service status
```

生成用户服务 `my-agents-panel.service`，捕获当时的 Node 路径、源码路径与 PATH。检查 `systemctl --user is-enabled my-agents-panel.service` 和实际 `ExecStart`。需要退出 SSH 后持续运行时检查用户 linger；系统要求管理员授权时再由管理员配置 `loginctl enable-linger 用户名`。

修改已经运行的服务配置后，`install` 不保证替换旧进程；等待任务和代理请求空闲，再执行 `node server.js service restart`。可用 `journalctl --user -u my-agents-panel.service` 排障，分享前清理敏感内容。

### macOS 完整面板

先以正确的数据目录和可达监听启动面板，再在「IM 接入」开启登录自动启动。检查生成的 LaunchAgent 是否使用正确的源码、数据目录和监听设置。已有服务不要另起一个抢占同一端口的进程。登录自启不能在 Mac 关机时提供执行能力；接管依赖其余常驻成员。

### 可选：见证节点

将成员通过 `cluster add --id witness-c --url http://witness-c.example.internal:4321 --witness` 登记，并把最终成员表分发给所有成员。见证机器的配置使用自己的 `nodeId`，启动命令为：

```bash
MY_AGENTS_HOME="$HOME/.my-agents" node server.js witness --config "$HOME/.my-agents/panel-cluster.json"
```

务必显式传 `--config`。见证需要常驻进程、端口互通与私密配置，不能使用普通 `node --hub` 替代。当前 `service install` 安装的是完整面板，**不能直接拿它安装见证进程**；应单独配置服务，ExecStart 使用实际 Node 绝对路径、源码绝对路径及上述 `witness --config` 参数，设置工作目录、重启策略与私密文件权限，并核对它确实运行 witness。

## 6. 配置 IM、账号和项目

1. 确认三台面板均可互通，页面显示多数派满足、有效主节点明确。
2. 在「IM 接入」配置同一个飞书 / Lark 应用并完成配对。由有效 IM 主节点接收消息，其余待命。
3. 在「引擎与账号」确认共享账号池可用。源机器导入一个有权使用的订阅，等待完整成员同步，检查可见模型目录；不要在日志打印原始认证 JSON。
4. 在「项目与目录」为各机器设置默认目录，给同一逻辑项目填写不同真实路径。
5. 在网页新建一个无外部副作用的任务，确认实际执行机器与目录；IM 消息测试由用户发送或明确授权后进行。

集群接入密钥用于成员通信，面板令牌用于面板 / 执行节点访问，外部 Agent 的账号凭证用于模型授权，三者不同。复制 `node --hub` 命令不能自动完成集群身份、账号授权、项目克隆和常驻安装。

## 7. 验收与接管演练

| 验收项 | 通过标准 |
| --- | --- |
| 版本 | 所有机器同一个 Git SHA；运行进程确实来自该源码，而非旧 npm 安装 |
| 服务 | 实际 PID、工作目录、Node 路径和服务配置可核对；可正常重启与恢复连接 |
| 共识 | 成员表一致、在线数量满足多数派，存在有效 IM 主节点 |
| IM | 主节点连接机器人，其他成员待命；不会有两套独立集群同时接收 |
| 执行 | 每台目标机器 CLI 路径 / 版本有效，项目目录校验通过 |
| 账号 | 共享账号可见，模型目录可读取，凭证未泄露到页面日志或仓库 |
| 历史 | 老会话 / 旧卡片仍能按原机器读取；新任务改机器不改变旧绑定 |

先使用页面「接管 IM」验证有计划移交，再在无任务执行、无代理请求时，短暂停止原主节点服务，观察其余两台重新选主。恢复原服务并重新检查三台连通。不要停止两台；不要通过发送有提交、发布等副作用的任务来“试故障恢复”。

如果要验证 IM 的真实接收，用户发送一条明确可识别的测试消息即可。接管不代表正在执行的 CLI 进程迁移成功；检查断线命令实际结果后再决定续接。

## 8. 升级、扩容和恢复

- **升级**：盘点所有已配置机器与实际运行路径，保留脏工作区；验证新提交后逐台快进。检查面板任务与代理请求空闲，再逐台重载，保持多数派。源码、PID 和 Git SHA 三项都要核对。
- **CLI 更新**：每台执行机都检查并更新 Codex / Claude Code；确认服务解析到新二进制。只更新 Mac 不会更新远程机器。
- **扩容**：新成员加入前备份，统一分发最终成员表，控制重载顺序。当前命令不是无需协调的在线成员变更协议，避免在成员表不一致时强制选主。
- **恢复**：保留集群身份和稳定机器 ID，从私密备份恢复配置、账号库及必要状态，再恢复原生历史和项目文件。不要用新 `cluster init` 冒充原集群。
- **回滚**：记录升级前提交与服务配置。仅在空闲时恢复已验证版本，并核对数据格式兼容；不要以 `git reset --hard` 覆盖其他人的修改。

运行状态不正常时，先检查网络、监听、令牌、成员表与系统时间。多数派集群不是对任意网络分区、时钟异常和进程冻结的无条件可用保证。
