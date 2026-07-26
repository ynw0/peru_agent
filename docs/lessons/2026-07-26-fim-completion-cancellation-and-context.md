# FIM 补全取消与上下文经验

## 根因 1：取消本地 Promise 不会停止模型请求

原 Typed IPC 只删除客户端 Pending，请求已经进入 Server 后仍可能继续消耗 GPU。修复为显式 `cancel` 消息，并为每个 Server 请求创建 `AbortController`。

## 根因 2：编辑补全必须使用 latest-wins

连续输入会产生大量过期请求。按文档保存唯一 Active Request，新请求启动时中止旧请求，避免旧候选覆盖新版本。

## 根因 3：上下文缓存必须绑定精确文档版本

仅按文件 URI 缓存 LSP 和 Diagnostics 会把旧类型信息送给新版本。缓存键必须包含版本；不一致时立即失效。

## 根因 4：声明支持 FIM 不等于实际可用

Provider 声明与主动探测结果必须一致。缺少流式、取消、FIM 或有效上下文上限时禁止启用，不进行普通补全或 Chat Provider fallback。

## 根因 5：元数据也会耗尽上下文窗口

只裁剪 Prefix/Suffix，而不限制 Import、Diagnostics 和项目规则，会突破模型上下文。元数据必须使用独立总预算。

## 根因 6：Workbench 不能读取完整大文件

在主线程调用完整 `getValue()` 会造成卡顿。应按行数和字符数从光标两侧增量提取固定窗口。

## 根因 7：接受事件必须幂等

同一个候选的命令可能重复触发。接受率必须按已交付的 `requestId` 去重，并拒绝未知请求。
