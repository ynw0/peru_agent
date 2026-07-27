# 执行状态

## 当前阶段

- Phase 0～12：源码实现阶段完成；
- 当前工作：关闭全局发布门禁，而不是继续增加未验证功能。

## Phase 12 已完成

- 中英文严格 Catalog 和安全插值；
- Ed25519 Release Manifest 和 Trust Store；
- Payload 文件级 SHA-256、大小和保留路径检查；
- SPDX 2.3 SBOM；
- A/B 版本目录、原子状态指针和显式回滚；
- 普通更新只允许版本严格上升；
- Bundle 根、Payload 和 SBOM 的 `lstat + realpath` 复核；
- Release Gate、Readiness 和审计；
- Typed IPC Version 8；
- Code OSS Release Center；
- Windows 构建、安装、卸载的 Authenticode 门禁脚本；
- 固定 Code OSS 1.74.0 Overlay 重新导入、应用和 API 契约验证。

## 当前验证结果

```text
npm run audit                   → 通过
npm run check                   → 通过
npm test                        → 162 passed
npm run build                   → 通过
npm run smoke                   → Phase 0～12 全部通过
npm run release:verify-source   → 通过
npm run code-oss:check-overlay  → 通过
npm run code-oss:verify-applied → 通过
```

## 未通过或未执行的生产门禁

- Code OSS 1.74.0 锁定依赖未安装；
- 当前 Node.js 22.16.0，不符合要求的 16.14.x；
- Yarn Classic 1.x 未安装；
- Electron Workbench 完整编译和桌面启动未完成；
- Windows Release 构建未执行；
- Windows Sandbox Broker 和 UI Automation Broker 红队未完成；
- Authenticode 生产证书签名未执行；
- 恶意软件扫描未执行；
- 安装、升级、卸载和回滚 Windows E2E 未执行；
- 第三方安全审计未执行。

因此生产发布状态必须保持 `blocked`。
