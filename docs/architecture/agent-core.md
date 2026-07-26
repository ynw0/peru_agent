# 自研 Agent Core 架构

## 目标

Agent Core 完全自研，不依赖 Claude Agent SDK。模型层只依赖明确的 OpenAI Chat Completions 流协议，工具、权限、状态和事件均使用项目内部协议。

## 主调用链

```text
AgentRuntime.startSession
→ AgentSession.start
→ AgentLoop.run
→ ModelProvider.stream
→ ToolCallAssembler
→ ToolRegistry
→ Tool.validate
→ Tool.inspect
→ PermissionCoordinator
→ Tool.execute
→ Tool Result 写回消息历史
→ 再次调用模型
→ stop / 明确失败 / 用户取消
```

## 组件职责

### AgentRuntime

- 创建、恢复和读取会话；
- 管理并发 Run 与 AbortController；
- 接收权限响应；
- 把运行时事件推送给 Typed IPC；
- 进程恢复时把失去执行进程的会话标记为失败。

### AgentSession

- 保存消息、状态、Run ID、错误和 Token 用量；
- 所有写入通过领域方法进行；
- 对外仅返回不可变 Snapshot。

### AgentLoop

- 执行模型与 Tool 的循环；
- 强制最大轮次、ToolCall 数量和 Token 预算；
- 严格检查 `finish_reason`、ToolCall 和 Token 用量；
- 处理用户中止和明确失败；
- 不切换模型、不伪造 Tool Result、不做隐式 fallback。

### ModelProvider

- 输出统一的 `ModelStreamEvent`；
- OpenAI 兼容实现使用 `/chat/completions` SSE；
- Token 用量缺失时明确失败，因为无法执行预算限制；
- 密钥通过 CredentialResolver 获取，配置只保存引用。

### ToolRegistry

- 负责 Tool 唯一注册；
- 生成模型可见 JSON Schema；
- Tool 必须依次完成 `validate → inspect → permission → execute`；
- `inspect` 的受影响文件必须先发送给 IDE，再进入权限判断。

### PermissionCoordinator

- 将权限规则与用户询问连接；
- Pending 请求必须先登记，再发送 `permission.requested`；
- 避免 IDE 立即批准时找不到请求；
- Run 中止时拒绝全部关联 Pending。

### EventJournal 与 SessionStore

- EventJournal 使用 JSONL 追加记录；
- 并发写入通过单一队列串行化；
- SessionStore 使用临时文件加原子 rename；
- UI 可通过事件重放恢复，不依赖界面内存。

## 明确边界

本阶段尚未实现：

- Read、Write、Edit、Diff、Git、LSP 等真实工作区工具；
- Windows PowerShell 和强沙箱；
- Code OSS 中真实 Agent Chat UI；
- 对真实 LM Studio/vLLM/OpenAI 兼容端点的联网集成测试；
- Responses API；
- 子 Agent 调度。
