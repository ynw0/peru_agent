# 低延迟 FIM 补全架构

## 1. 边界

补全 Runtime 与 Agent Runtime 完全分离。补全模型只接收受限 Prefix、Suffix 和经过预算裁剪的元数据，不接收完整仓库，也不读取 Agent 会话。

```text
Code OSS InlineCompletionsProvider
→ IndependentAiIdeCompletionBridge
→ CompletionController
→ Typed IPC
→ CompletionRuntimeIpcBridge
→ CompletionEngine
→ CompletionProvider
```

Workbench 进程不持有模型凭据，不直接调用 HTTP，也不访问文件系统或 Shell。

## 2. Provider

`OpenAiFimProvider` 支持两种显式请求格式：

- `openai-suffix`：使用 OpenAI Completions 的 `prompt + suffix`；
- `token-template`：使用模型明确配置的 FIM Prefix/Suffix/Middle Token。

两种格式不会自动互相回退。格式配置错误或模型不支持时明确失败。

Provider 必须声明并通过主动探测：

- FIM；
- SSE 流式输出；
- AbortSignal 取消；
- Prefix/Suffix Token 上限；
- 模型 ID；
- 首 Token、总响应和取消延迟。

探测结果必须与 Provider 声明完全一致。

## 3. 上下文

请求包含：

- 光标前 Prefix；
- 光标后 Suffix；
- 当前函数；
- Import；
- 最近编辑；
- LSP 类型；
- Diagnostics；
- 项目规则摘要。

Prefix、Suffix 和元数据分别受 Token 预算限制。Code OSS 侧最多提取 24,000 个 Prefix 字符和 12,000 个 Suffix 字符，并限制扫描行数，避免读取完整大文件。

`CompletionContextCache` 只复用完全相同的 `documentUri + version`。版本变化立即丢弃旧 LSP 和 Diagnostics 上下文。

## 4. 取消与并发

同一文档使用 latest-wins：新请求启动时中止旧请求。

取消链：

```text
Code OSS CancellationToken
→ AbortController
→ Typed IPC cancel message
→ Server AbortController
→ CompletionEngine
→ Fetch AbortSignal
```

客户端超时、用户取消、Client 关闭和 Server 关闭都会传播取消并释放 Pending 状态。

## 5. 缓存和质量

候选缓存使用 SHA-256 键、TTL 和 LRU 上限。缓存键包括 Provider、Prefix、Suffix、语言、元数据和输出预算。

质量过滤拒绝：

- 空结果；
- FIM 控制 Token 泄漏；
- 非法控制字符；
- 过长响应；
- 与 Prefix 或 Suffix 完全重复；
- Markdown 代码围栏。

候选接受按 `requestId` 去重；未知请求不能写入接受率。

## 6. 指标

收集：

- 请求数；
- 缓存命中；
- 取消；
- 失败；
- 接受数和接受率；
- 首 Token P50/P95；
- 总响应 P50/P95。

性能目标：

- 首个候选 P50 < 120ms；
- P95 < 350ms；
- 取消 < 20ms；
- Workbench 主线程上下文提取 < 8ms。

当前只完成基准框架和模拟 Provider 测试；真实模型、真实硬件和完整 Electron Workbench 的性能门禁仍待执行。
