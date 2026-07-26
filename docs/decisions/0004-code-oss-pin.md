# ADR-0004：固定 Code OSS 1.130.0

状态：已批准

## 决策

Phase 1 固定使用 Code OSS `1.130.0`，Commit：

`1b6a188127eeaf9194f945eb6eb89a657e93c54c`

## 原因

- 固定 Tag 和完整 Commit 可以避免 Overlay 随上游变化漂移；
- 该版本是制定 Phase 1 时最新的正式 Release；
- 上游源码使用 MIT License；
- 获取脚本必须验证完整 SHA，不接受相同 Tag 指向其他提交。

## 执行边界

当前执行环境网络解析失败，因此本次只完成版本固定、严格获取脚本和 Overlay 清单；没有伪造 Code OSS 已下载或已启动。
