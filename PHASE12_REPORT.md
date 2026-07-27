# Phase 12 执行报告：发布、本地化与安全强化

## 结论

Phase 12 的源码实现和当前环境可执行门禁已完成。产品具备严格中英文资源、Ed25519 Release Manifest、SPDX SBOM、文件级校验、A/B 原子更新、显式回滚、Release Center、Windows 构建/安装安全脚本和生产发布门禁。

当前没有生成 Windows 安装包，也没有宣称达到生产发布条件。Code OSS 完整编译、Windows Broker 红队、恶意软件扫描和 Authenticode 真签名仍被明确阻塞。

## 主要实现

- `src/localization/*`：`zh-CN`、`en-US` 严格 Catalog 和插值；
- `src/release/*`：Manifest、Ed25519、Trust Store、SPDX、Gate、Runtime 和原子更新；
- Typed IPC Version 8：Release 状态、语言、Manifest 验证和审计；
- 第七个 Code OSS Workbench 容器：Release Center；
- `packaging/windows/*`：构建、安装和卸载 Authenticode 门禁；
- `tools/release/*`：源码检查、SBOM 和 Readiness 生成；
- Windows 更新只接受版本严格上升，降级只允许显式回滚；
- Bundle 根、Payload 和 SBOM 进行普通文件、符号链接和真实路径复核。

## 当前验证

```text
npm run audit                   → 通过
npm run check                   → 通过
npm test                        → 162 passed
npm run build                   → 通过
npm run smoke                   → Phase 0～12 通过
npm run release:verify-source   → 通过
npm run code-oss:check-overlay  → 通过
npm run code-oss:verify-applied → 通过
```

## 真实失败门禁

### Code OSS 完整编译

实际执行 `npm run compile`，失败在加载 Gulp 前：

```text
node_modules/gulp/bin/gulp.js 不存在
Node.js = 22.16.0
Yarn = 未安装
```

Code OSS 1.74.0 需要 Node.js 16.14.x、Yarn Classic 1.x 和按 `yarn.lock` 安装的完整依赖。

### Windows Release

当前主机是 Linux，且没有 `pwsh`，实际执行 `npm run release:build-windows` 返回 127。未执行 Windows 构建、SignTool、Authenticode 和安装 E2E。

## 发布状态

生产 Readiness 必须保持 blocked，直到所有门禁证据均通过。当前只生成 SBOM 和 Readiness，不生成伪造的签名 Manifest 或安装包。
