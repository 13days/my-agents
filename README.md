# <img src="https://raw.githubusercontent.com/13days/my-agents/main/assets/my-agents.png" width="40" height="40" alt=""> my-agents

**在终端开始，在手机上追问，回到网页继续同一条 AI 编程会话。**

my-agents 是一个自托管面板。它把飞书 / Lark、企业微信和网页连到你自己的 Codex、Claude Code 或 DeepSeek Harness。文件和命令在你选的 Mac 或 Linux 服务器上执行。

[English](README.en.md) · [快速开始](#快速开始) · [接入聊天软件](#接入聊天软件) · [完整演示](#完整演示与文档)

[![手绘演示：在终端整理项目更新，从飞书找回这条会话，再回到网页继续](https://raw.githubusercontent.com/13days/my-agents/main/docs/session-handoff.gif)](https://cdn.jsdelivr.net/gh/13days/my-agents@c649f281ab28fba819469a0ad8400c5220aa55a1/docs/session-handoff.mp4)

*点击动图可播放 30 秒有声短片。演示使用示例项目 design-kit 和本地生成的飞书卡片预览。*

## 快速开始

在一台有 Git 和 curl 的 **Mac 或 Linux** 上运行下面的命令，即可体验 GitHub 当前版本的手绘主题和企微设置。首次安装会准备 Node.js 并启动面板。

```sh
curl -fsSL https://raw.githubusercontent.com/13days/my-agents/main/install.sh | sh
```

1. 在执行任务的电脑上装好至少一个引擎，例如 Codex 或 Claude Code，并登录账号或接入已有模型网关。
2. 打开 **[localhost:4321](http://localhost:4321)**，点「对话 → 新对话」，选择项目文件夹和引擎。右上角「外观 → 手绘纸张」可以切换到图中的样式。
3. 发一句「这个项目怎么运行？」。看到答复后，就可以从聊天软件接手这条对话。

<details>
<summary>使用 npm 发布版，或从自己的电脑打开远程面板</summary>

已有 Node.js 18+ 和 npm，可直接运行发布版。新功能随 npm 发版提供。

```sh
npx --yes @wuchupeng/my-agents@latest
```

面板装在服务器上时，在自己的电脑运行下面的命令，把 `user@server` 换成你的 SSH 地址，再打开本机的 4321 端口。

```sh
ssh -N -L 4321:127.0.0.1:4321 user@server
```

[安装 Codex](https://developers.openai.com/codex/cli/) · [安装 Claude Code](https://code.claude.com/docs/en/quickstart) · [安装与开机常驻](docs/agent-install.md)

</details>

## 接入聊天软件

| | 第一次连接 | 接着做之前的事 |
| --- | --- | --- |
| **飞书 / Lark** | 在「聊天软件 → 飞书」扫码创建机器人，或填入已有应用的凭据，按页面提示配对账号。 | 私聊发 `/sessions 产品更新`，点「切换」，就能追问「把第二条展开」。发 `/new` 可以另开任务。 |
| **企业微信** | 创建智能机器人，选择「API 模式 → 长连接」，在面板填入 Bot ID 和 Secret。由希望担任 Owner 的成员先私聊发 `/whoami`。 | 发 `/sessions 关键词` 找会话，`/use 1` 接手第一条，`/status` 查进度。支持文字、语音转写和引用消息，群里可 @机器人。 |

企微默认按成员和聊天提供自己的会话。要从企微接手原来的终端或网页会话，在接入页确认 Owner 身份，开启「允许已配对的 Owner 在私聊中查找并接手面板和终端会话」。同一页可指定新对话的机器、目录、引擎、模型和独立 Git 工作区。飞书完成卡支持在「详情与操作」生成只读分享卡，再转发给同事。[聊天软件接入](docs/im-channels.md) · [飞书卡片和命令](docs/feishu-interaction.md) · [分享卡动图](https://raw.githubusercontent.com/13days/my-agents/main/docs/feishu-share.gif)

![企微的新对话设置，从执行机器和目录到引擎、模型和独立工作区](https://raw.githubusercontent.com/13days/my-agents/main/docs/wecom-defaults.png)

回到网页，按 **⌘K**（Windows / Linux 用 **Ctrl+K**）即可切换项目、搜到一条历史回答，或按状态找到失败的任务。回车直接进入对应会话。回到原机器的终端，也可以用 `codex resume <会话ID>` 或 `claude --resume <会话ID>` 接着做。[原终端接续条件](docs/user-guide.md)

![在对话快速搜索中切换项目，查找会话、问答和任务](https://raw.githubusercontent.com/13days/my-agents/main/docs/conversation-finder.png)

## 一个面板，多台机器

例如，同时让 Mac 上的 Claude Code 检查前端，让 Linux 上的 Codex 跑测试。两个对话分别使用各自的机器和代码目录，进度都能在同一个面板看到。

![飞书、企微、网页或终端如何通过面板连到 Mac、Linux、三种引擎和模型代理](https://raw.githubusercontent.com/13days/my-agents/main/docs/my-agents-overview-zh.gif)

- **添加执行机器**　打开「电脑与 AI 账号 → 连接电脑」。免密 SSH 可以直接添加主机别名，远端无需预装 my-agents。需要密码或验证码时，先自行登录，再运行页面生成的接入命令。
- **选对目录**　在机器卡片里浏览文件夹。一个项目可以在 Mac 上映射到 `~/src/design-kit`，在 Linux 上映射到 `/srv/repos/design-kit`。各台电脑使用自己的代码副本。
- **让机器人持续在线**　Mac 可设置防闲置睡眠和登录自启。需要笔记本关机后仍能接单，可部署三台完整面板。两台保持在线即可选出新的消息接收节点，已启动的 CLI 进程仍属于原机器。[目录与独立工作区](docs/execution-workspaces.md) · [集群部署与接管](docs/cluster-setup.md)

## 用已有账号选择引擎和模型

**喜欢 Claude Code 的工具，也可以让它调用 GPT。** 在「电脑与 AI 账号 → AI 账号」配置下表中的任一来源。读写文件、跑命令的是执行机器上的引擎，回答问题的模型由账号或网关提供。

| 你已有的模型来源 | 能怎么用 |
| --- | --- |
| 带 Codex 权限的 ChatGPT 订阅 | 在 Codex 下登录订阅，再点「使用 Codex 订阅代理 → 填入 Claude Code 账号」。同一个订阅可以用于 Codex 和 Claude Code。 |
| 兼容 Anthropic Messages 的网关 | 在 Claude Code 下点「连接自定义代理」，填入网关配置并选可用模型。已接入的代理也能用于安装了 `dsh` 的 DeepSeek Harness。 |

可以分别设置新对话的默认模型。飞书话题用 `/model` 选模型，`/route` 选账号。网关存在固定映射时，可在完成卡的「详情与操作」核对本轮实际记录的模型。[Codex 订阅代理](docs/codex-subscription-proxy.md) · [DeepSeek Harness 接入](docs/deepseek-harness.md)

## 让助理留意飞书里的后续

在「助理」单独授权个人飞书账号并选择聊天范围。比如，同事在群里提了需求，又在私聊里补充细节，助理会结合发送人、后续回复和已有任务，建议把相关消息一起交给正在做这件事的会话。你可以确认、改选会话或忽略建议，核对记录会参与后续判断。

![助理将设计群里的两条消息汇总成一条待确认的建议](https://raw.githubusercontent.com/13days/my-agents/main/docs/assistant-review-preview.png)

页面可分别关闭消息同步和模型分析，也可以为模型分析设每日预算。[助理的读取范围、审批与预算](docs/heartflow.md)

## 完整演示与文档

[![播放 2 分 40 秒手绘版产品介绍，包含终端接续、多机执行、模型代理和助理](https://raw.githubusercontent.com/13days/my-agents/main/docs/product-tour-zh.png)](https://cdn.jsdelivr.net/gh/13days/my-agents@c649f281ab28fba819469a0ad8400c5220aa55a1/docs/my-agents-intro.mp4)

**2 分 40 秒 · 中文旁白 · 中英字幕**　从终端接手、转发结果，到多机执行、模型网关和助理审批。[下载 MP4](https://raw.githubusercontent.com/13days/my-agents/c649f281ab28fba819469a0ad8400c5220aa55a1/docs/my-agents-intro.mp4) · [下载字幕](docs/my-agents-intro.srt)

[使用手册](docs/user-guide.md) · [版本更新](https://github.com/13days/my-agents/releases) · [反馈问题](https://github.com/13days/my-agents/issues) · [MIT 许可证](LICENSE)
