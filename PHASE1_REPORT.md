# Phase 1 执行报告：独立产品骨架与 Typed IPC

状态：核心骨架完成；Code OSS 源码获取受执行环境 DNS 阻断
计划置信度：92/100

## 影响文件

- `src/ipc/*`
- `src/product/*`
- `src/workbench/*`
- `src/agent-protocol.ts`
- `src/phase1-smoke.ts`
- `tools/code-oss/*`
- `overlays/code-oss/*`
- `tests/phase1.test.ts`
- `docs/architecture/typed-ipc.md`
- `docs/decisions/0004-code-oss-pin.md`
- `docs/decisions/0005-typed-ipc.md`
- `docs/lessons/2026-07-26-typed-ipc-boundary-validation.md`
- `README.md`、`PROJECT_RULES.md`、`package.json`

## 已完成

1. 固定 Code OSS `1.130.0` 和完整 Commit SHA；
2. 建立独立产品身份，禁用遥测和 Microsoft 扩展市场配置；
3. 定义 Agent、Task、Permission、Browser 四个 Workbench 容器；
4. 实现版本化 Typed IPC 请求、响应和事件协议；
5. 实现请求超时、AbortSignal 取消、稳定错误码和 Pending 清理；
6. 为每个 Phase 1 IPC 方法实现运行时参数与结果校验；
7. 实现事件重放式 Workbench Snapshot；
8. 创建 Code OSS 严格获取、SHA 校验、Overlay 白名单与应用脚本；
9. 创建独立产品 Overlay 和 Workbench Contribution 适配层骨架；
10. 新增 9 项 Phase 1 测试，总测试数达到 18 项。

## Code OSS 获取结果

已执行：

```text
npm run code-oss:fetch
```

结果：失败。执行环境无法解析 `github.com`，Git 返回退出码 128。

该失败没有触发其他版本、镜像、缓存或普通目录替代；项目中没有伪造 Code OSS 已获取。获取脚本保留严格 Tag 和完整 Commit 校验，网络恢复后可直接重新执行。

## 质量门禁

```text
npm run audit   → 通过
npm run check   → 通过
npm test        → 18 passed
npm run build   → 通过
npm run smoke   → Phase 0 与 Phase 1 均通过
```

## 尚未完成

- Code OSS 1.130.0 源码实际下载；
- Overlay 实际应用到 Code OSS；
- Code OSS Workbench 编译；
- 独立桌面 IDE 启动。

这些工作依赖固定上游源码，不能在源码缺失时伪装完成。
