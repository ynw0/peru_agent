# Agent Runtime 事件顺序、并发日志与恢复经验

## 现象一：权限事件可能早于 Pending 登记

### 根因

权限协调器先发送 `permission.requested`，再把 Promise 放进 Pending Map。IDE 收到事件后立即批准，会因为请求尚不存在而失败。

### 修复

先创建 Promise 并登记 Pending，再发送事件。发送事件失败时必须移除 Pending 和 Abort 监听器。

### 可复用规则

任何“事件触发外部响应”的状态，都必须先提交内部状态，再发布事件。

## 现象二：多个会话并发写 JSONL 可能重复 sequence

### 根因

多个异步 `append()` 同时读取相同的 `nextSequence`，并发初始化也可能重复读取日志。

### 修复

EventJournal 使用单一 Promise 队列串行化初始化、sequence 分配和文件追加。

### 可复用规则

持久化顺序号不能只依赖 JavaScript 单线程假设；一旦存在 `await`，必须显式串行化临界区。

## 现象三：进程重启后会话仍显示 running

### 根因

持久化状态记录了 `running`，但对应子进程、网络流和 AbortController 已经不存在。

### 修复

恢复时检测 `running/awaitingPermission`，明确标记为 `INTERRUPTED_RUN_RECOVERED` 失败，并写入事件日志。

### 可复用规则

不能仅凭持久化状态宣称外部执行仍然存在；恢复过程必须验证运行资源，无法验证时明确结束旧运行。

## 现象四：权限 UI 看不到影响文件

### 根因

Tool 直接进入权限判断，`inspect()` 的文件信息没有作为事件发送给 IDE。

### 修复

新增 `tool.inspected` 事件，并保证它发生在 `permission.requested` 之前。

### 可复用规则

所有写入、删除、进程和网络操作在权限决定前必须公开影响范围。
