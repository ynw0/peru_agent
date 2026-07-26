# Independent AI IDE

完全自研 Agent Runtime、基于 Code OSS 的独立 AI IDE。
Claude Code 源码仅作为只读架构参考，不参与产品构建。

## 当前状态

已完成：

- Agent、权限、网络、补全、子 Agent、Computer Use 和自进化基础协议；
- Typed IPC 请求、响应、事件、超时、中止和运行时校验；
- Code OSS `1.74.0` 固定归档校验；
- 独立产品身份 Overlay；
- Agent、Tasks、Permissions、Browser 原生 Workbench 容器和占位视图；
- Overlay TypeScript 检查、上游 API 契约检查和应用结果验证。

未完成：

- Code OSS 完整依赖安装、编译和桌面启动；
- 自研 Agent Core；
- Windows Sandbox Broker；
- PowerShell AST Broker；
- 真实 Browser Runtime 和 Completion Runtime。

## 核心项目门禁

```powershell
npm run audit
npm run check
npm test
npm run build
npm run smoke
```

## 导入并应用固定 Code OSS

```powershell
npm run code-oss:import -- C:\path\to\code-main.zip
npm run code-oss:apply-overlay
npm run code-oss:verify-applied
```

归档哈希、版本、许可证、关键文件或 Overlay 锚点任一不匹配都会失败。
不会切换版本、镜像或未声明源码。

## Code OSS 完整构建

上传的 Code OSS 1.74.0 使用 `.nvmrc` 中的 Node.js `16.14`，并需要按其锁文件安装完整依赖。
在依赖完成前，不能把 Overlay 源码验证等同于桌面 IDE 编译成功。

## 重要文档

- `FINAL_PLAN.md`：总体计划；
- `PROJECT_RULES.md`：强制开发和安全规则；
- `PHASE2_REPORT.md`：真实 Code OSS 接入报告；
- `docs/architecture/code-oss-workbench-overlay.md`：Workbench 接入架构；
- `docs/lessons/2026-07-26-code-oss-versioned-api-contract.md`：版本 API 经验。
