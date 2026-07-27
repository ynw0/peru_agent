# Egress、DNS、重定向与浏览器证据经验

## 根因 1：授权 URL 不等于授权最终连接地址

如果授权阶段校验域名，但传输阶段重新 DNS 解析，攻击者可能通过 DNS rebinding 把请求导向 Loopback、私网或元数据地址。修复为解析全部地址、拒绝混合类别，并将一次性租约绑定到已审核 IP，传输时使用固定 lookup。

## 根因 2：每个重定向都是新的网络决策

只审核初始 URL 会允许远端返回跳转到受保护地址。每个 `Location` 必须重新规范化、解析和审核；跨源重定向必须删除 Authorization、Cookie 等凭据。

## 根因 3：IPv6 URL 主机名可能带方括号

Node URL 对 IPv6 字面量可能返回 `[::1]`。直接交给地址分类或本机代理校验会误判。所有 IP 分类和 Socket 参数前必须转为无方括号的规范主机名。

## 根因 4：响应超限后带 Error 销毁流会产生二次未处理错误

Promise 已经拒绝后，再使用 `request.destroy(error)` 可能触发额外 `error` 事件，形成未处理异常。修复为状态机只结算一次，然后无错误参数销毁 request/response。

## 根因 5：HTML 标题不能混入正文预算

先对整份 HTML 去标签会把 `<title>` 计入正文和截断预算，导致抓取正文偏移。标题应单独提取，`head/script/style/noscript` 应在正文转换前删除。

## 根因 6：元素序号不是稳定的浏览器动作证据

页面重排后“第 N 个按钮”可能变成其他控件。动作必须绑定 Snapshot ID、元素 ID、role、accessible name 和 disabled 状态，并在执行前重新验证。

## 根因 7：一次 IPC 请求的取消信号不是浏览器会话生命周期

创建请求完成后，其 AbortSignal 可能已经失效，不能继续用于后续 Route。Browser Driver 必须创建独立的会话级 AbortController，关闭会话时统一终止页面、资源授权和动作。

## 根因 8：本机地址不能证明代理身份

攻击者或其他进程也可监听 Loopback 端口。启动 Chromium 前必须通过固定健康端点完成协议和执行模式握手；URL 正确但握手不匹配时禁止启动。

## 根因 9：远端下载文件名是不可信输入

`Content-Disposition` 可能包含 `../`、盘符、控制字符或保留名称。文件名必须清理，下载只能落到产品管理的 Artifact 根目录，使用临时文件和原子替换，禁止自动执行或解压。

## 根因 10：代理契约不是代理实现

Driver 声明使用 Broker Proxy、Route 也请求授权，并不代表真实代理服务已存在。只有代理服务本身实现固定 IP、DNS 审核、审计和协议握手后，才能启用生产 Browser Runtime。
