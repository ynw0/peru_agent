# AI IDE

这是独立 AI IDE 的全新工程基线。

当前仓库只包含 Phase 0 的协议、规则、测试基线和架构文档，不包含 Claude Code 源码，也尚未导入 Code OSS。

## 当前已实现

- Agent 公共协议；
- 权限模式和能力定义；
- Tool 风险等级与自动晋级规则；
- Computer Use 认证应用规则；
- 网络三模式策略；
- 子 Agent 深度与写入范围检查；
- 补全模型能力检查；
- OpenAI 兼容 Provider 配置验证；
- TypeScript strict 编译和单元测试。

## 命令

```powershell
npm install
npm run check
npm test
npm run build
npm run smoke
```

## 重要文件

- `FINAL_PLAN.md`：最终实施计划；
- `PROJECT_RULES.md`：项目强制规则；
- `EXECUTION_STATUS.md`：当前执行结果；
- `docs/architecture/claude-code-functional-map.md`：参考源码功能映射。

## Phase 1：产品骨架与 Typed IPC

Phase 1 已固定 Code OSS `1.130.0` / Commit `1b6a188127eeaf9194f945eb6eb89a657e93c54c`，并建立：

- 独立产品身份清单；
- Agent、Task、Permission、Browser Workbench 容器定义；
- 版本化 Typed IPC 请求、响应和事件协议；
- 请求超时、中止、错误码和运行时消息校验；
- 事件重放式 Workbench Snapshot；
- Code OSS 严格获取脚本和 Overlay 白名单清单。

获取固定 Code OSS：

```bash
npm run code-oss:fetch
```

该命令会校验完整 Commit SHA。网络、Git、Tag 或 SHA 任一不满足都会失败，不会切换到其他版本。
