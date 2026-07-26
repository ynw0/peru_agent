# Code OSS Workbench Overlay 架构

## 接入点

桌面 Workbench 通过以下 Import 激活独立贡献：

```ts
import 'vs/workbench/contrib/independentAiIde/browser/independentAiIde.contribution';
```

该 Import 由 `insert-before` 操作写入固定锚点，目标文件中必须且只能存在一次。

## 原生 Workbench 容器

| 容器 | Code OSS 位置 | View |
|---|---|---|
| AI Agent | Sidebar / Activity Bar | Chat |
| Browser | Sidebar / Activity Bar | Controlled Browser |
| Tasks | Panel | Agent Tasks |
| Permissions | Panel | Permission Queue |

容器和视图使用 Code OSS 1.74.0 原生：

- `IViewContainersRegistry`；
- `IViewsRegistry`；
- `ViewPaneContainer`；
- `ViewPane`；
- `SyncDescriptor`；
- `registerIcon`。

## Phase 2 UI 边界

当前 View 是可见占位视图，只验证：

- Workbench 生命周期接入；
- Activity Bar 与 Panel 注册；
- 稳定 ID；
- 中英文可本地化文本；
- 后续 Typed IPC 注入位置。

Phase 2 不在 View 中实现 Agent 循环、Browser Runtime 或权限业务，避免 UI 与 Runtime 耦合。
