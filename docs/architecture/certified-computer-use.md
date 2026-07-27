# 认证应用 Computer Use 架构

## 目标

Computer Use 只允许操作经过显式认证的 Windows 应用。未认证应用可以列出窗口、读取 UI Automation Tree 和生成截图证据，但不能点击、输入或发送快捷键。

本阶段不依赖窗口标题或可执行文件名作为认证依据，也不允许 Workbench UI 直接执行桌面动作。

## 信任边界

```text
Agent Tool
→ PermissionCoordinator
→ ComputerUseRuntime
→ Windows UI Automation Broker
→ 重新验证应用身份和元素证据
→ 执行动作
→ 生成动作后 Snapshot
→ Runtime 再次认证
```

Workbench 仅通过 Typed IPC 进行窗口检查、UI Tree 检查、截图和审计查询。交互动作只能由声明 `computer.interact` 的 Agent Tool 发起。

## 应用认证清单

认证清单必须同时绑定：

- 应用 ID 和显示名称；
- 允许的可执行文件名；
- 允许的绝对安装路径根；
- Authenticode Publisher Subject；
- 签名证书 Thumbprint；
- 精确文件 SHA-256；
- 完整锚定的版本正则；
- 允许的窗口 Class；
- 允许的动作；
- 允许的快捷键。

以下任意一项不匹配，应用只能进入 `inspect-only`：

- 同名程序位于其他目录；
- Publisher 或证书 Thumbprint 不同；
- 文件哈希不同；
- 版本不符合清单；
- 窗口 Class 不符合清单；
- 高完整性或未知完整性进程。

安全桌面窗口直接进入 `blocked`。

## 进程和窗口身份

运行时身份包括：

- Process ID；
- 完整可执行路径；
- 可执行文件名；
- Publisher Subject；
- Signer Thumbprint；
- File Version；
- 文件 SHA-256；
- Window Handle；
- Window Title；
- Window Class；
- Integrity Level；
- Secure Desktop 状态。

身份被规范化后计算 SHA-256 Fingerprint。准备动作、执行动作和动作后验证都必须使用同一 Fingerprint。

## UI Tree Snapshot

Broker 使用 Windows UI Automation 的 `TreeWalker.RawViewWalker` 读取元素。每个元素包含：

- Runtime ID；
- Control Type 和 Role；
- Name；
- Automation ID；
- Class Name；
- Bounds；
- Enabled、Offscreen、Focusable；
- Password 状态；
- 支持的 UI Automation Pattern。

Snapshot 设置元素数量上限。所有坐标必须是有限数字，Width 和 Height 必须非负。

未认证应用也可获取 Snapshot，但 Snapshot 中的认证决策由 Agent Runtime 根据本地清单重新计算，不能信任 Broker 返回的占位认证状态。

## 动作证据

交互动作分成准备和执行两个阶段。准备动作会生成一次性 `PreparedComputerAction`，绑定：

- Action ID；
- Application ID；
- 应用身份 Fingerprint；
- Manifest SHA-256；
- Snapshot ID 和 SHA-256；
- 元素 ID 和 Runtime ID；
- Role、Name、Automation ID 和 Class Name；
- 元素 Bounds；
- 文本 SHA-256 或快捷键；
- 人类可读原因；
- 创建时间和过期时间。

动作授权有效期为 60 秒，只能使用一次。输入文本只保存在 Runtime 内存中；事件、权限卡片和审计仅保存文本哈希。动作被拒绝、过期、失败或完成时都会清理内存文本。

## 敏感内容保护

以下场景禁止交互：

- Secure Desktop；
- UAC、Windows Security、凭据或密码窗口；
- 高完整性、System 或未知完整性进程；
- UI Automation `IsPassword=true` 元素；
- Name 或 Automation ID 命中密码、Token、API Key 等敏感词；
- 不支持安全 UI Automation Pattern 的元素；
- 未在应用清单和 Broker 全局白名单中的快捷键。

点击优先使用 `InvokePattern`、`SelectionItemPattern` 或 `TogglePattern`。输入使用 `ValuePattern`。快捷键只使用 Broker 内部固定白名单的 `SendInput`，不支持任意键序列。

## 双侧验证

TypeScript Runtime 与 Windows Broker 都执行验证。

Broker 在动作前重新读取：

- HWND 对应 PID；
- 可执行路径、签名身份、文件哈希和版本；
- 完整性级别和桌面；
- 元素 Runtime ID、Role、Name、Automation ID、Class 和 Bounds。

动作完成后 Broker 重新检查窗口并返回新 Snapshot。Runtime 再次运行认证清单；应用不再满足原清单时，动作结果被拒绝。

## IPC 边界

Typed IPC Version 6 开放：

- `computer.windows`；
- `computer.inspect`；
- `computer.screenshot`；
- `computer.audit.list`。

事件包括：

- `computer.window.changed`；
- `computer.snapshot.changed`；
- `computer.action.prepared`；
- `computer.action.completed`。

IPC 不开放 `computer.action.execute`。这样 Workbench 不能绕过 PermissionCoordinator 直接操作桌面。

## Code OSS View

Code OSS 新增第五个 Activity Bar 容器 `Computer Use`，用于：

- 列出窗口；
- 显示认证状态和原因；
- 检查 UI Tree；
- 获取截图证据；
- 显示待执行动作和动作结果。

View 不导入文件系统、进程或网络模块，也没有点击、输入和快捷键执行按钮。交互必须由 Agent Tool 发起并在权限中心审核。

## 原生 Broker

`native/windows-ui-automation-broker` 提供 Windows x64、.NET 8 的 C# 原型源码：

- UTF-8 JSONL 协议；
- Win32 窗口枚举；
- Authenticode 身份读取；
- 文件 SHA-256 和版本读取；
- HWND/PID/可执行文件绑定；
- Integrity Level 和 Secure Desktop 检测；
- UI Automation Tree；
- `PrintWindow` 截图；
- Invoke、Selection、Toggle、Value Pattern；
- 固定快捷键 `SendInput`；
- 动作前和动作后证据验证；
- 本地 JSONL 审计。

当前 Linux 环境无法编译或运行该 Broker。Windows 11 x64 真机完成构建、签名验证、窗口切换、UAC、安全桌面和输入注入红队测试前，产品不得启用 Computer Use 交互。
