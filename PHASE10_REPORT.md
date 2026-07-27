# Phase 10 执行报告：认证应用 Computer Use

## 结论

Phase 10 已完成认证应用清单、Windows 应用身份绑定、UI Automation Snapshot、动作证据、Agent Tool 权限链、Typed IPC、Workbench Computer Use View 和 Windows UI Automation Broker 原型源码。

本阶段严格维持“未认证应用只能检查”的产品决策。Workbench 没有直接点击、输入或快捷键接口，交互必须经过声明 `computer.interact` 的 Agent Tool 和 PermissionCoordinator。

当前环境为 Linux，未安装 PowerShell 7 和 .NET 8 Windows 工具链，因此没有把 C# Broker 源码契约检查冒充为 Windows 真机验证。

## 完成内容

### 认证应用清单

认证清单同时绑定：

- 可执行文件名；
- 绝对安装路径根；
- Publisher Subject；
- Signer Thumbprint；
- 精确文件 SHA-256；
- 完整版本正则；
- Window Class；
- 允许动作；
- 允许快捷键。

同名程序、路径、签名、哈希、版本或窗口 Class 任一不匹配时，只能检查。

### Computer Use Runtime

实现：

- Broker 能力握手；
- 窗口列表和认证决策；
- UI Tree Snapshot；
- 截图证据；
- Click、Type 和 Shortcut 动作准备；
- 一次性 60 秒动作授权；
- 身份 Fingerprint；
- Manifest SHA-256；
- Snapshot 和元素证据；
- 输入文本哈希和内存清理；
- 动作后 Snapshot 和重新认证；
- Computer Use 审计。

### 安全限制

拒绝：

- 未认证应用交互；
- Secure Desktop；
- UAC、Windows Security、登录、密码和凭据窗口；
- 高、System 或未知完整性窗口；
- Password 元素；
- 敏感 Name 或 Automation ID；
- 不支持安全 UI Automation Pattern 的元素；
- 未批准快捷键；
- 过期、重复或身份变化后的动作；
- 非有限坐标和负元素尺寸。

### Agent Tool 与权限

新增：

- `ComputerListWindows`；
- `ComputerInspectWindow`；
- `ComputerScreenshot`；
- `ComputerClick`；
- `ComputerType`；
- `ComputerShortcut`。

交互 Tool 声明 `computer.interact`，并在 `inspect()` 阶段生成认证应用证据。权限拒绝或执行异常会释放 Prepared Action。

### Typed IPC 和 Workbench

IPC 协议升级为 Version 6，开放：

- `computer.windows`；
- `computer.inspect`；
- `computer.screenshot`；
- `computer.audit.list`。

没有开放直接动作执行 IPC。

Code OSS 新增第五个 Activity Bar 容器 `Computer Use`，支持窗口列表、认证状态、UI Tree、截图和动作状态展示。View 明确提示桌面动作必须由 Agent Tool 经权限中心批准。

### Windows UI Automation Broker

新增 `.NET 8 / Windows x64` C# 原型：

- UTF-8 JSONL；
- 窗口枚举；
- Authenticode 身份、文件哈希和版本；
- HWND/PID/进程绑定；
- Integrity Level 和 Secure Desktop 检测；
- UI Automation Tree；
- `PrintWindow` 截图；
- Invoke、Selection、Toggle 和 Value Pattern；
- 固定安全快捷键 `SendInput`；
- 动作前证据重验；
- 动作后 Snapshot；
- 本地审计日志。

## 关键修复

1. 旧 Phase 2 Smoke 固定四个容器，加入 Computer Use 后产生累积回归；
2. Type 动作过期或校验失败时内存明文可能残留；
3. 同步动作准备使用异步 fire-and-forget 事件可能产生未处理拒绝；
4. Broker Bounds 使用 `Number()` 但未拒绝 `NaN`、Infinity 和负尺寸；
5. C# `SendInput` 返回值与 `List.Count` 比较存在 `uint/int` 类型问题；
6. Prepared Action 必须显式保存 Snapshot ID，不能只依赖窗口和元素 ID。
7. Phase 9 源码审计把 IPC Version 5 写死，合法升级到 Version 6 后产生误报；历史阶段契约已改为验证最低版本和必需方法。

## 验证

```text
npm run audit                  → 通过
npm run check                  → 通过
npm test                       → 130 passed
npm run build                  → 通过
npm run smoke                  → Phase 0～10 全部通过
npm run computer:verify-source → 通过
npm run code-oss:check-overlay → 通过
```

专项测试覆盖：

- 清单字段硬绑定；
- 同名伪装应用；
- 安全桌面和高完整性窗口；
- 未认证应用只检查；
- 动作一次性使用；
- 密码元素和敏感窗口；
- 快捷键白名单；
- Broker 能力缺失；
- Snapshot 数值边界；
- Agent Tool 权限与释放；
- Typed IPC 只读边界；
- Workbench 事件；
- Overlay 不暴露直接交互。

## 未完成门禁

以下不宣称完成：

- Windows 11 x64 上的 C# 编译；
- Authenticode 信任链和撤销状态真机测试；
- UI Automation 对真实应用的兼容性测试；
- HWND 复用、窗口切换和进程重启红队测试；
- UAC、Secure Desktop 和高完整性进程真机测试；
- 多显示器、DPI、远程桌面和不同语言环境测试；
- `PrintWindow` 截图真实性测试；
- 输入注入和快捷键压力测试；
- 第一批认证应用清单签署；
- Code OSS Electron Workbench 完整编译和桌面启动；
- 生产主进程 IPC Transport。

`PHASE10_WINDOWS_BUILD_LOG.txt` 记录当前环境缺少 `pwsh`，原生 Broker 构建没有执行成功。

## Code OSS Overlay 和完整编译

Phase 10 Overlay 已从用户提供的原始 `code-main.zip` 重新导入并应用到固定 Code OSS 1.74.0，以下门禁通过：

```text
npm run code-oss:import -- /mnt/data/code-main.zip → 通过
npm run code-oss:apply-overlay                    → 通过
npm run code-oss:verify-applied                   → 通过
```

完整 Code OSS 编译也已真实执行，但仍在构建工具加载前失败：

```text
Cannot find module './node_modules/gulp/bin/gulp.js'
```

当前源码目录没有安装锁定依赖，并且当前 Node.js 22.16.0 不是 Code OSS 1.74.0 要求的 Node.js 16.14.x。详情见 `PHASE10_CODE_OSS_BUILD_LOG.txt`。这不属于 Overlay TypeScript 编译错误，因为完整编译尚未进入 Workbench TypeScript 阶段。
