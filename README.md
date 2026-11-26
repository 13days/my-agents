# <img src="https://raw.githubusercontent.com/13days/my-agents/main/assets/my-agents.png" width="42" height="42" alt=""> my-agents

在飞书里把任务交给 Codex 或 Claude Code。它在你选的机器和项目目录里工作，把结果回到原话题。回到电脑，打开浏览器就能接着同一个会话聊。

[English](README.en.md) · [使用手册](docs/user-guide.md)

![在飞书发任务、跟进进度并生成分享卡](https://raw.githubusercontent.com/13days/my-agents/main/docs/feishu-share.gif)

*虚构任务演示，飞书部分按实际生成的卡片数据预览。*

## 从飞书里用一次

比如你要准备周会。在和机器人的私聊里发：

> /new 帮我看一下这个项目本周合入的改动，整理三条给团队看的更新。

选好项目和引擎，提交任务。回复卡会显示它读了什么、运行了哪些工具，以及最后写好的三条更新。想改口吻，直接在话题里说「改成发给设计同学的版本」。想发到周会群，点 **生成分享卡**，预览正文，再用飞书转发。卡片底部的「my-agents」链接会带收件人回到这里。

已经在终端里做了一半？发 `/sessions 关键词`，选中原来的会话再继续。

## 启动第一台

已安装 Node.js 18+ 和 npm 的机器，可以用一条命令启动：

```sh
npx --yes @wuchupeng/my-agents@latest
```

新 Mac 或 Linux 开发机上只有 Git 和 curl？使用源码安装命令，它会在需要时自动下载并校验 Node.js 24 LTS（Intel / ARM 64 位）。

```sh
curl -fsSL https://raw.githubusercontent.com/13days/my-agents/main/install.sh | sh
```

打开 **[localhost:4321](http://localhost:4321)**。使用源码安装命令时，代码放在 `~/.local/share/my-agents/source`，面板在当前终端运行。下次可以重用同一条命令。

1. **先跑通本机。** 在要执行任务的机器上安装并登录 [Codex](https://developers.openai.com/codex/cli/) 或 [Claude Code](https://code.claude.com/docs/en/quickstart)。在「对话 → ＋ 新对话」选项目，试试「这个项目怎么启动？」。
2. **接上飞书。** 打开「聊天软件」，点「扫码创建机器人」。如果已有机器人，也可以填入应用凭证。跟随页面完成配对和卡片按钮授权。
3. **发第一条任务。** 私聊机器人，发送上面的 `/new` 示例。执行进度和结果都会回到飞书。 [飞书卡片与命令](docs/feishu-interaction.md)

![在浏览器里继续同一个项目对话](https://raw.githubusercontent.com/13days/my-agents/main/docs/conversation-preview.png)

<details>
<summary>已经有开发环境，想从源码运行</summary>

```sh
git clone https://github.com/13days/my-agents.git
cd my-agents
npm install
MY_AGENTS_NO_PROXY_SETUP=1 npm start
```

安装脚本和这条启动命令都保留现有终端代理配置。要让服务在登录后常驻，可在 macOS 面板里启用登录自启，Linux 使用用户服务。 [安装与常驻](docs/agent-install.md)

</details>

## 把任务放到开发机

在「设备与模型 → 机器 → 添加机器」填入平时使用的免密 SSH 地址，例如 `devbox`。面板会检查环境、准备运行时、安装执行程序并建立连接。设备显示「已连接」后，在「项目与目录」填写项目在那台机器上的真实路径。下一次新建对话就能选它。

SSH 连不进去，但开发机能访问面板时，展开「其他接入方式」，复制接入命令到开发机运行即可。

只想用一台电脑，直接在本机工作即可。如果希望笔记本关机后仍有人接收飞书消息，需要让其他常驻面板接管机器人。 [集群部署指南](docs/cluster-setup.md)

## 让助理替你留意消息

在「助理」里连接个人飞书账号，选择读取范围，开启同步。助理会汇总相关私聊和群聊，结合发送人、后续回复和已有任务，建议哪些消息适合一起交给哪个会话。你可以调整归属、忽略或确认执行。确认记录能给下次判断作参考。

消息同步和模型分析分别有开关，模型分析可以设置每日预算。 [助理设置与审批](docs/heartflow.md)

## 项目

[报告问题](https://github.com/13days/my-agents/issues) · [MIT 许可证](LICENSE)
