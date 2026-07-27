# 统一 Egress、Web 与 Browser Runtime 架构

## 1. 边界

所有网页搜索、抓取、下载和浏览器资源访问都必须通过统一出口策略。Tool、Workbench View 和 Playwright Driver 不得直接拥有任意网络能力。

```text
Agent / Workbench View
→ Typed IPC
→ WebIpcBridge / BrowserIpcBridge
→ Web Service / BrowserRuntime
→ EgressBroker
→ DNS 全地址审核
→ 单次授权租约
→ 固定 IP Transport 或已认证 Browser Proxy
→ 远端服务
```

网络模式不是传输层的提示，而是每次出口请求的强制约束。

## 2. Egress Broker

`EgressBroker` 负责：

- URL 规范化；
- 仅允许 HTTP/HTTPS；
- 拒绝 URL 凭据；
- 端口白名单；
- DNS 解析与全部地址分类；
- `offline`、`lan`、`internet` 模式校验；
- 单次、短时、URL 哈希绑定的授权租约；
- 固定已审核 IP 的 HTTP 请求；
- 每次重定向重新审核；
- 跨源重定向删除认证头和 Cookie；
- 响应大小、超时和重定向次数限制；
- 查询参数脱敏审计。

地址分类覆盖：

- loopback；
- private；
- public；
- link-local；
- carrier-grade NAT；
- multicast；
- documentation；
- unspecified；
- reserved。

DNS 返回混合类别时直接拒绝，禁止通过一个域名同时解析到允许地址和受保护地址。

## 3. 三种网络模式

| 模式 | 允许地址 |
|---|---|
| `offline` | Loopback |
| `lan` | Loopback、RFC1918 私网、ULA 私网 |
| `internet` | 公网地址 |

`internet` 不隐式允许 Loopback、私网、链路本地或云元数据地址。访问本地模型应显式使用 `offline` 或产品登记的本地端点策略。

## 4. 固定 IP 传输

`NodePinnedHttpTransport` 使用 Broker 已审核的 `selectedIp`，通过自定义 DNS lookup 固定实际连接地址，避免授权后再次解析导致 DNS rebinding。

传输层必须：

- 验证 URL、Host Header 与已审核请求一致；
- 响应超限后只拒绝一次；
- 无错误参数销毁请求和响应流；
- AbortSignal 终止底层 Socket；
- 不把超时、取消或超限错误转换成成功响应。

## 5. WebFetch 与 WebSearch

`WebFetchService`：

- 通过 Egress Broker 请求；
- 只接受受支持的文本媒体类型；
- 分离 HTML 标题和正文；
- 删除脚本、样式、注释和不可见内容；
- 限制返回字符数。

`WebSearchService` 使用显式 Provider。当前提供 `SearxngJsonSearchProvider`，其 Base URL、结果结构和最大结果数均经过运行时校验。没有配置搜索 Provider 时明确失败，不切换到其他搜索源。

Web Tool 在 `inspect()` 阶段取得单次出口授权；权限拒绝、执行完成或异常时必须释放授权。

## 6. 受控下载

下载不能把远端文件直接写入任意工作区路径。流程固定为：

```text
URL 审核
→ 有界下载
→ 清理 Content-Disposition 文件名
→ 产品管理的 Artifact 根目录
→ 临时文件
→ 原子 rename
```

Artifact Store：

- 绑定 Workspace ID；
- 拒绝路径穿越、绝对路径和控制字符；
- 默认最大 32 MiB；
- 使用独占创建和 `0600` 文件权限；
- 不自动执行、不自动解压、不自动导入工作区。

## 7. Browser Runtime

`BrowserRuntime` 只接受声明 `egressEnforcement: "broker-proxy"` 的 Driver。

创建 Chromium 会话前必须验证本机代理能力：

- 本机 HTTP URL；
- 固定健康端点；
- 协议版本 1；
- `healthy: true`；
- `enforcement: "egress-broker"`；
- 返回的 `serverUrl` 与配置完全一致。

只有 URL 指向 `127.0.0.1` 或 `::1` 不足以证明代理身份。握手失败时 Chromium 不启动。

当前已实现代理验证协议和 Driver 契约，但真实 Browser Egress Proxy 服务尚未实现，因此生产 Browser Runtime 保持禁用。

## 8. Playwright Driver

`PlaywrightChromiumDriver`：

- 动态导入 `playwright-core`，缺失时明确失败；
- 强制 Headless Chromium；
- 强制使用已认证 Broker Proxy；
- 禁止 Playwright 自动下载；
- Route 拦截所有 HTTP/HTTPS 资源并请求 Broker 授权；
- 允许 `about:`、`data:` 和 `blob:`，拒绝其他 Scheme；
- 会话级 AbortController 负责关闭和取消；
- DOM Snapshot 限制文本、元素数量和大小；
- Screenshot 绑定最新 Snapshot；
- 下载必须调用受控下载服务。

## 9. DOM 证据与动作验证

元素动作不能只依赖“当前第 N 个节点”。Snapshot 创建时记录：

- 元素 ID；
- role；
- accessible name；
- disabled 状态；
- Snapshot ID 和 SHA-256。

点击或输入前，Driver 必须重新定位元素并验证 role、name 和 disabled 证据仍一致。动作后必须返回新的 Snapshot 或明确的状态证据。证据变化时拒绝操作，防止页面重排后点击错误目标。

## 10. Typed IPC 与 Workbench

IPC 协议版本为 5，提供：

- `egress.audit.list`；
- `web.fetch`、`web.search`、`web.download`；
- `browser.create`、`browser.navigate`、`browser.snapshot`；
- `browser.screenshot`、`browser.download`；
- `browser.click`、`browser.type`、`browser.close`、`browser.list`。

Workbench Browser View 只能通过 Bridge 和 Typed IPC 请求操作，禁止导入文件系统、进程、Fetch、XMLHttpRequest 或 WebSocket。

## 11. 尚未通过的生产门禁

- 本机 Browser Egress Proxy 服务；
- `playwright-core` 和固定 Chromium 安装；
- 真实公网搜索、抓取和重定向集成；
- Chromium Route 与代理双层出口测试；
- 下载恶意文件和压缩炸弹安全测试；
- Electron Workbench 桌面运行；
- 生产 IPC Transport；
- Windows Sandbox Broker 真机网络协同。
