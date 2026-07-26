# Workbench 事件投影与 IPC 根因经验

## 1. 流式文本必须先固定 Message ID

### 现象

只有 `assistant.delta` 文本时，UI 无法判断 delta 属于哪一条 Assistant 消息，尤其在多轮或并发会话中会串行错误。

### 根因

旧流程在模型流结束后才生成 Assistant Message ID。

### 修复

模型开始前生成 ID 并发布：

```text
assistant.started(messageId)
assistant.delta(messageId)
assistant.completed(messageId)
```

### 可复用规则

所有可增量更新的实体必须在第一个增量事件前拥有稳定 ID。

## 2. Workbench 状态必须按 Session 隔离

### 现象

后台会话事件可能覆盖当前打开会话的 Chat、Tool 和权限状态。

### 根因

单一全局 Snapshot 无法表示多个同时存在的会话。

### 修复

`WorkbenchRuntime` 使用 `Map<sessionId, WorkbenchSnapshot>`，显式激活当前会话。

### 可复用规则

任何多会话 UI 投影必须以 Session ID 分区，不能把后台事件写入全局可见状态。

## 3. 事件恢复必须保留领域时间戳

### 现象

Plan 重放后 `createdAt/updatedAt` 变成恢复时刻，审计顺序不可信。

### 根因

事件只保存业务数据，没有保存原始时间。

### 修复

Plan 事件携带 `createdAt/updatedAt`，恢复时原样使用。

### 可复用规则

需要审计或排序的领域时间必须进入事件，不能在重放时重新生成。

## 4. 流式事件不能触发完整时间线请求

### 现象

每个 `assistant.delta` 都调用 `session.events`，长回答会产生大量重复 IPC 和磁盘读取。

### 根因

把实时 Snapshot 更新和历史时间线加载混成同一路径。

### 修复

Snapshot 通过事件实时更新；时间线只在用户选择会话或显式刷新时加载。

### 可复用规则

高频增量事件只能做 O(1) 本地投影，禁止触发全量历史查询。

## 5. UI 不得持有执行能力

### 现象

如果 View 直接访问文件、Shell 或 Tool，按钮可以绕过 PermissionEngine 和审计。

### 根因

把展示层和运行时对象放在同一权限边界。

### 修复

View 只依赖桥接接口，桥接只调用 Typed IPC；未连接时明确禁用。

### 可复用规则

安全敏感 IDE UI 必须是“命令请求者”，不能成为“能力持有者”。
