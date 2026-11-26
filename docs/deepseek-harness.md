# DeepSeek Harness

## 从 my-agents 发起任务

1. 在执行机器安装官方 DeepSeek Harness，确保后台服务用户可以运行 `dsh --version` 和 `dsh headless --help`。本项目以 `0.2.2-rc.5` 验证，该版本要求 Node.js 24.9.0 或更高。如使用自定义启动器，可为服务设置 `DSH_CLI` 指向其绝对路径。 [官方安装说明](https://github.com/deepseek-ai/deepseek-harness)
2. 在网页新建对话时选择 **DeepSeek Harness**、机器和项目。消息交给该机的无头引擎执行。已连接的 Claude Code 代理提供账号选择、模型目录和故障转移。没有代理时沿用 headless profile 的原生默认配置。
3. 支持文字、工具执行记录、排队、停止、重启后续聊。面板保存与原生会话 ID 的绑定，后续消息通过 `--session-id` 续接。工具权限由执行机的 Harness 配置决定。

## 将已有代理接入独立 Harness 网页

在 my-agents 打开「电脑与 AI 账号 → AI 账号 → DeepSeek Harness → 连接独立运行的 DeepSeek Harness」。在同一台机器上的 Harness 打开「设置 → 模型 → 自定义模型 API」，按下表填写。

| 字段 | 填写内容 |
| --- | --- |
| Provider ID | `my-agents` |
| 显示名称 | `my-agents` |
| API 地址 | 面板显示的本地代理地址 |
| API 协议 | Anthropic Messages |
| API 密钥 | 点「复制代理密钥」取得 |
| 模型目录 | 获取可用模型，或添加面板显示的模型 ID |

创建提供商后，在 Harness 的新对话中选中它的模型。已保存的 Claude Code 代理账号继续在 my-agents 管理。 [Harness 自定义提供商说明](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/user/guide/providers.zh.md)
