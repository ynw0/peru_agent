# Code OSS Overlay 必须校验目标版本 API 契约

## 现象

Phase 2 首次把 Workbench Overlay 接入 Code OSS 1.74.0 时，Agent 容器使用了 `Codicon.sparkle`。
该图标存在于较新的 Code OSS 设计中，但 1.74.0 的 `codicons.ts` 中不存在。

## 根因

Phase 1 只校验了 Overlay 的目标路径、稳定 ID 和清单，没有读取固定 Code OSS 源码验证：

- 内部模块路径是否存在；
- 使用的 Codicon 是否存在；
- Registry 和 ViewPane API 是否仍符合预期。

TypeScript 源码属于内部 Workbench API，不同 Code OSS 版本之间不能只凭名称推断兼容。

## 修复

- 将 `Codicon.sparkle` 改为 1.74.0 已存在的 `Codicon.hubot`；
- 新增 `verify-workbench-contract.mjs`；
- Overlay 应用结果验证前，强制检查模块、图标、Registry 和 ViewPane API。

## 可复用规则

- 固定上游版本后，每个 Overlay 引用的内部 API 都必须对该版本做源码契约检查；
- 不能用“较新版本存在”推断“固定版本也存在”；
- 上游 API 契约检查应早于完整 Workbench 编译，以更快定位版本不匹配。
