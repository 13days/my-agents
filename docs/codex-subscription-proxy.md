# Codex 订阅代理：供 Claude Code 使用

此代理让 Claude Code 调用共享 Codex 订阅池中的模型。文件、终端和 MCP 工具仍由 Claude Code 在其执行机器上运行。代理不启动第二个 Agent，也不会把 Codex 订阅当成 Claude 订阅。

## 获取配置

在「机器与引擎 → 引擎与账号 → Codex」账号池中点击「Claude Code 使用订阅代理」，复制 JSON 配置。模型从订阅账号的实际模型目录获取，不硬编码默认模型。配置包含独立代理密钥，不包含订阅 access token 或 refresh token。

建议把配置保存到独立目录，例如 `~/.claude-codex-proxy/settings.json`，再运行：

```bash
CLAUDE_CONFIG_DIR="$HOME/.claude-codex-proxy" claude
```

不要覆盖正在使用的默认登录目录。配置中的 `ANTHROPIC_API_KEY` 为空，用 `ANTHROPIC_AUTH_TOKEN` 携带代理密钥；Opus、Sonnet、Haiku 三个档位都映射到同一个实际 OpenAI 模型。`ENABLE_TOOL_SEARCH=false` 关闭暂未适配的延迟工具搜索。

## 地址与密钥

- Base URL：面板地址加 `/codex-subscription`，例如 `http://127.0.0.1:4321/codex-subscription`。
- `POST /v1/messages`：Anthropic Messages 入站，支持流式和非流式响应。
- `GET /v1/models`：当前订阅模型目录。
- `POST /v1/messages/count_tokens`：本地保守估算，非上游精确计数。
- 所有请求，包括本机请求，都必须携带 `Authorization: Bearer <代理密钥>` 或 `x-api-key`。

密钥保存于面板数据目录的 `codex-bridge-token`（仅属主可读写），与面板管理密钥、订阅凭证分离。它允许使用该机器的订阅代理，应只分享给需要使用的人。三台面板各自拥有代理密钥，订阅池由现有集群共享。连接其他面板时，从该面板重新复制配置。

本机监听模式只能供本机调用；远程使用须确保面板监听地址和网络可达。跨不可信网络使用已有的 HTTPS 入口或 SSH 隧道，不直接暴露明文 HTTP。

## 路由与故障处理

沿用现有 Codex 池的路由、会话粘性、凭证刷新、冷却和出网节点。登录刷新由集群主节点协调；主节点无法连接认证服务时，可委托已认证的完整节点出网，轮换结果先持久化再回传。网络错误和限流不会触发不必要的授权轮换。此入口只选择订阅账号，绝不回退到 API/代理账号。若全局手动固定的是 API 账号，请先选择订阅账号或改为自动路由。账号被撤销、额度耗尽或模型不可用会返回错误，不伪造成功。

Claude 会话标识会被散列并加上独立前缀，避免与原生 Codex 会话混淆。客户端须发送完整历史，工具调用与结果的 ID 必须对应。

## 支持范围

支持文本、图片输入、普通客户端函数工具、工具结果回传、并行工具历史、UTF-8 流式输出、取消和用量回传。工具参数完整且为合法 JSON 后才发送给 Claude Code 执行。断流、非法工具参数、未知工具及上游失败不会输出成功终态。

目前不支持服务器托管工具、工具搜索、document 内容块、结构化输出格式和停止序列；这些请求返回明确错误。历史中的供应商私有思考块不转发，代理不会生成或伪造思考内容。Anthropic 的 `max_tokens` 和 thinking 预算不等同于订阅后端的参数，目前不映射；输出上限由上游模型决定。

这是协议兼容入口，不代表两个厂商的全部功能等价，也不保证任何订阅都拥有所有模型。请以账号实际权限与实测结果为准。
