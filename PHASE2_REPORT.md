# Phase 2 执行报告：真实 Code OSS 源码接入

执行置信度：92/100

## 目标

使用用户上传的完整 Code OSS 源码，关闭 Phase 1 中“上游未获取、Overlay 未实际应用”的缺口。

## 已完成

- 验证 `code-main.zip` 为 Code OSS `1.74.0` 完整源码归档；
- 验证 MIT License 和固定关键文件 SHA-256；
- 删除未实际获取的 `1.130.0` 假设，不维护双版本兼容；
- 建立归档导入、原子替换和源码树校验脚本；
- 完整替换独立产品名称、协议、数据目录和 Windows 标识；
- 删除未批准的 Microsoft Issue URL 和 Webview CDN 字段；
- 暂不下载未审计的远程 Built-in Extension，固定为空列表；
- 在真实 `workbench.desktop.main.ts` 中导入独立 Contribution；
- 使用 Code OSS 原生 Registry 注册 Agent、Tasks、Permissions、Browser；
- 创建四个原生占位 ViewPane；
- 建立 Overlay TypeScript 结构检查；
- 建立 Code OSS 1.74.0 内部模块、Codicon、Registry 与 ViewPane 契约检查；
- 验证 Overlay 应用结果。

## Bug 根因

首次接入使用了新版本中的 `Codicon.sparkle`，Code OSS 1.74.0 不存在该图标。

修复：

- 改用 1.74.0 中存在的 `Codicon.hubot`；
- 新增上游版本 API 契约检查；
- 将经验写入 `PROJECT_RULES.md` 和 `docs/lessons`。

## 验证结果

```text
npm run verify                    → 22 passed
npm run code-oss:check-overlay    → 通过
npm run code-oss:verify-contract  → 通过
npm run code-oss:verify-applied   → 通过
```

## Code OSS 完整编译

已在 Overlay 应用后的真实源码目录执行原项目命令：

```text
npm run compile
```

结果失败：

```text
Cannot find module ./node_modules/gulp/bin/gulp.js
```

原因：上传归档不包含 `node_modules`，当前环境也没有该版本的 Yarn 依赖缓存。上游 `.nvmrc` 要求 Node.js `16.14`，当前执行环境是 Node.js `22.16.0`。

没有伪造编译或启动成功，也没有改用其他 Code OSS 版本、镜像依赖或非官方构建命令。

## 下一阶段入口

1. 在隔离构建环境准备 Node.js 16.14 和完整锁定依赖；
2. 执行 Code OSS `npm run compile`；
3. 执行桌面 Workbench 启动 Smoke Test；
4. 同时进入计划中的 Phase 2 Agent Core 开发，保持 Runtime 与 Workbench 通过 Typed IPC 解耦。
