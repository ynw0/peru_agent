# ADR-0004：固定用户提供的 Code OSS 1.74.0 归档

状态：已批准并执行

## 决策

当前唯一 Code OSS 上游基线为用户提供的 `code-main.zip`：

- `package.json` 版本：`1.74.0`；
- 归档根目录：`code-main`；
- 归档 SHA-256：`debf828bfd82cb4c167757aaa03ef1663ea5999e110f965ec2ae38d8bb884065`；
- 许可证：MIT。

不再保留 Phase 1 中未下载成功的 `1.130.0` 假设，也不维护双版本 Overlay。

## 校验

导入前必须验证：

- 完整归档 SHA-256；
- `package.json` 名称与版本；
- `LICENSE.txt`；
- `product.json`；
- `workbench.desktop.main.ts`；
- 其他固定关键文件指纹。

## 边界

该归档的 `.nvmrc` 固定为 Node.js `16.14`，而当前执行环境为 Node.js `22.16.0`。
Phase 2 已完成源码导入和 Overlay 接入，但完整 Code OSS 构建必须在匹配上游要求、且安装完整依赖的构建环境中执行。
不允许忽略工具链差异后把未编译源码标记为可发布 IDE。
