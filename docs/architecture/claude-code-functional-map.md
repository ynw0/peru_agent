# Claude Code 参考源码功能映射

本文件只记录职责映射，不复制源码。

| Claude Code 参考模块 | 本项目目标模块 | 复用方式 |
|---|---|---|
| `QueryEngine.ts` | `agent-core/AgentSession` | 参考会话容器职责，重新定义接口 |
| `query.ts` | `agent-core/AgentLoop` | 参考 Tool Call 循环，重新实现事件模型 |
| `Tool.ts` | `tool-runtime/Tool` | 参考 Schema、权限、进度职责，重新实现 |
| `tools.ts` | `tool-runtime/ToolRegistry` | 参考统一注册和权限过滤思想 |
| `BashTool.tsx` | `PowerShellTool`、`ProcessTool` | Windows 优先重写，不复制 Bash UI |
| `Task.ts` | `task-runtime` | 参考后台任务状态机 |
| `context.ts` | `context-engine` | 参考项目上下文聚合职责 |
| `AgentTool` | `subagent-runtime` | 参考子 Agent 任务隔离思想 |
| `WebSearch/WebBrowser` | `browser-runtime` | 使用独立网络策略和 Playwright |

## 明确不复用

- Anthropic SDK 或 Claude Agent SDK 协议；
- Claude 专有 Prompt、模型选择、登录和订阅；
- Ink UI；
- Analytics、内部 Feature Flag 和私有服务；
- Claude Code 会话及配置格式。
