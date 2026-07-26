# Independent AI IDE

完全自研 Agent Runtime、基于 Code OSS 的独立 AI IDE。Claude Code 源码仅作为只读架构参考，不参与产品构建。

## 当前完成状态

- Phase 0：安全规则、协议和 TypeScript strict 基线；
- Phase 1：独立产品身份、Typed IPC 和 Workbench 容器；
- Phase 2：Code OSS 1.74.0 真实源码 Overlay 接入；
- Phase 3：自研 Agent Core、OpenAI 兼容流协议和 Tool 循环。

Agent Core 已支持：

- 会话、消息和事件持久化；
- 模型流式文本；
- ToolCall 增量拼装；
- Tool Registry、权限询问和 Tool Result 回灌；
- 最大轮次、ToolCall 和 Token 预算；
- 用户取消；
- 中断会话恢复；
- Typed IPC 创建、启动、中止和读取会话。

## 尚未完成

- Code OSS 完整依赖安装、编译和桌面启动；
- Read、Write、Edit、Diff、Git 和 LSP 工具；
- Windows Sandbox Broker 与 PowerShell AST Broker；
- 真实 Browser Runtime、Computer Use 和 Completion Runtime；
- 对真实 LM Studio、vLLM 或云端模型服务的联网集成测试。

## 核心项目门禁

```powershell
npm run audit
npm run check
npm test
npm run build
npm run smoke
```

## Code OSS 基线

固定为用户提供的 Code OSS `1.74.0` 归档。归档哈希、版本、许可证、关键文件或 Overlay 锚点任一不匹配都会失败。

## 重要文档

- `FINAL_PLAN.md`：总体计划；
- `PROJECT_RULES.md`：强制开发和安全规则；
- `PHASE3_REPORT.md`：Agent Core 执行报告；
- `docs/architecture/agent-core.md`：Agent Core 架构；
- `docs/lessons/2026-07-26-agent-runtime-ordering-and-recovery.md`：本阶段根因经验。
