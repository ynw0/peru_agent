# Phase 3 执行报告：自研 Agent Core

## 阶段结论

Phase 3 已完成自研 Agent Core 基线，置信度 **93/100**。

本阶段没有使用 Claude Agent SDK，没有复制 Claude Code Agent 循环，也没有修改 Code OSS Overlay。实现复用了 Phase 0~2 已有的 AgentEvent、权限模式、Tool 风险模型和 Typed IPC。

## 受影响模块

```text
src/agent/
src/model/
src/runtime/
src/storage/
src/ipc/
src/tool-runtime.ts
src/agent-protocol.ts
src/workbench/workbench-state.ts
tests/phase3.test.ts
```

## 已完成

- `AgentSession` 状态和消息历史；
- `AgentRuntime` 多会话、Run、取消和恢复；
- `AgentLoop` 模型/Tool 循环；
- `EventJournal` 内存与 JSONL 实现；
- `SessionStore` 内存与 JSON 文件实现；
- OpenAI Chat Completions SSE Provider；
- ToolCall 增量拼装和 JSON 参数校验；
- Tool Registry 与模型 JSON Schema；
- `validate → inspect → permission → execute` 工具链；
- 默认、自动审核和完全访问权限接入；
- 用户权限等待和 IPC 响应；
- 最大轮次、最大 ToolCall、Token 预算；
- 明确中止、失败和进程恢复；
- IDE 事件流与 Workbench Snapshot 投影；
- Agent Runtime Typed IPC Bridge。

## 无 fallback 规则

- 模型缺少 `finish_reason`：失败；
- 模型缺少 Token 用量：失败；
- ToolCall 参数不是合法 JSON：失败；
- Provider 不自动切换；
- 沙箱、工具和模型能力不自动替换；
- 中断的历史运行不会恢复成“仍在运行”。

## 发现并修复的根因

1. 权限 Pending 必须先于事件登记；
2. JSONL sequence 分配需要串行临界区；
3. 进程重启后 running 状态必须明确失败；
4. Tool 受影响文件必须在权限事件前发布；
5. SSE 关闭前没有空行时仍需处理最后记录。

## 验证结果

```text
npm run audit  → 通过
npm run check  → 通过
npm test       → 34 passed
npm run build  → 通过
npm run smoke  → Phase 0~3 全部通过
```

## 尚未完成

- 未对真实 LM Studio、vLLM 或云端 OpenAI 兼容服务执行联网测试；
- 未实现工作区 Tool、Diff、Git 和 LSP；
- 未实现 Windows PowerShell 与沙箱；
- 未把 Agent Chat 状态接入真实 Code OSS ViewPane；
- Code OSS 完整依赖、编译和桌面启动仍未完成。

下一阶段是 **Phase 4：工作区工具、Checkpoint 与 Diff**。
