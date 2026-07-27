# Phase 9 执行报告：统一 Egress、Web 与 Browser Runtime

## 结论

Phase 9 已完成统一 Egress Broker、网络地址策略、固定 IP HTTP Transport、出口审计、WebFetch、SearXNG WebSearch、受控下载、Browser Runtime、Playwright Driver 契约、DOM 证据、Typed IPC 和 Code OSS Browser View 接入。

本阶段没有把“代理协议已定义”冒充为“真实 Browser Proxy 已运行”，也没有在缺少 `playwright-core` 和 Chromium 时伪造浏览器测试成功。

## 完成内容

### Egress Broker

- HTTP/HTTPS URL 规范化；
- 凭据和非白名单端口拒绝；
- DNS 全地址解析和分类；
- offline、lan、internet 强制模式；
- 混合 DNS、Loopback、私网、链路本地和元数据地址保护；
- 单次、过期、URL 哈希绑定的授权租约；
- 固定审核 IP 的 Node HTTP Transport；
- 每次重定向重新授权；
- 跨源认证头和 Cookie 清理；
- 响应大小、超时、重定向次数和取消；
- 查询参数脱敏的出口审计。

### Web 服务和工具

- WebFetch HTML、JSON、XML 和文本抓取；
- HTML 标题和正文分离；
- 脚本、样式、注释和隐藏头部清理；
- SearXNG JSON Search Provider；
- WebFetch、WebSearch Tool；
- 权限拒绝和异常路径释放出口授权。

### 受控下载

- Web 和 Browser Download Service；
- 最大 32 MiB；
- Content-Disposition 文件名清理；
- Workspace ID 隔离；
- 产品 Artifact 根目录；
- 临时文件、独占创建、`0600` 和原子 rename；
- 不自动执行或解压。

### Browser Runtime

- 只接受 `broker-proxy` Driver；
- 创建浏览器前执行本机代理能力握手；
- 会话数量、视口和生命周期限制；
- navigate、snapshot、screenshot、click、type、download、close、list；
- Playwright Route 资源授权契约；
- DOM Snapshot 大小和元素上限；
- 元素 role/name/disabled 证据；
- 动作前复核和动作后证据；
- 会话级取消控制器。

### Typed IPC 和 Workbench

IPC 协议升级为 Version 5，新增 Egress Audit、Web、Download 和 Browser 方法。Code OSS Browser View 可创建会话、导航、刷新 DOM、点击、输入、受控下载和关闭，所有操作只经过 Bridge 与 Typed IPC。

## 关键修复

1. IPv6 URL 方括号导致地址和本机代理误判；
2. HTML `<title>` 污染正文和截断预算；
3. 元素索引无法作为稳定动作证据；
4. IPC 创建请求的 Signal 被错误复用于浏览器会话；
5. 响应超限后带 Error 销毁流导致二次未处理错误；
6. Loopback URL 无法证明代理身份；
7. 下载文件名可携带路径穿越；
8. 重定向和 DNS 目标没有天然继承初始授权。

## 验证

```text
npm run audit                  → 通过
npm run check                  → 通过
npm test                       → 118 passed
npm run build                  → 通过
npm run smoke                  → Phase 0～9 全部通过
npm run code-oss:check-overlay → 通过
npm run code-oss:verify-applied→ 通过
```

真实 Node HTTP 本机集成测试覆盖：

- 固定 IP 连接；
- 响应大小限制；
- AbortSignal 取消；
- Browser Proxy 健康握手。

## 未完成门禁

以下不宣称完成：

- 真实 Browser Egress Proxy 服务；
- `playwright-core` 和固定 Chromium 安装；
- Chromium 真实启动；
- 真实公网 WebSearch/WebFetch；
- 浏览器多页面、下载和复杂站点 E2E；
- 真实代理固定 IP 和重定向压力测试；
- 恶意下载、压缩炸弹和内容扫描；
- Code OSS Electron Workbench 完整编译和桌面启动；
- 生产主进程 IPC Transport。

`PHASE9_BROWSER_RUNTIME_LOG.txt` 记录了当前环境缺少 `playwright-core`，且 Browser Proxy 服务尚未实现。

## Code OSS 完整编译

已在应用 Phase 9 Overlay 的固定 Code OSS 1.74.0 源码中真实执行 `npm run compile`。仍因归档没有锁定依赖而失败：

```text
Cannot find module './node_modules/gulp/bin/gulp.js'
```

详情见 `PHASE9_CODE_OSS_BUILD_LOG.txt`。Overlay 源码应用和固定版本 API 契约验证均已通过，但这不等于 Electron 桌面 IDE 已构建。
