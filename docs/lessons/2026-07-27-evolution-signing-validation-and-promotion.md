# 自进化候选的验证、签名与晋级经验

## 1. 验证旧签名不等于验证当前候选

问题：候选在验证和签名后可能被修改。如果晋级只调用 `verifyArtifact()`，旧签名仍然是合法签名，但它签的是旧内容。

规则：晋级时必须重新计算当前 Candidate Digest，并同时等于：

- Validation Report Candidate Digest；
- Signed Artifact Candidate Digest。

三者任一不一致都必须拒绝。

## 2. 白名单必须能脱离 Registry 独立验签

问题：若 Whitelist 只保存 Package Digest 和签名，缺少签名原文中的其他字段，就无法独立重建签名 Payload。

规则：Whitelist 必须保存 Candidate Digest、Validation Digest、Package Digest、Signer Key ID 和 Signed At。

## 3. 静态分析不能替代沙箱

问题：正则和 AST 静态规则无法证明候选没有运行时副作用。

规则：Static Analyzer 只做默认拒绝的前置过滤。动态验证必须由隔离 Evaluator 执行，并返回绑定 Candidate Digest 的结构化证明。

## 4. 自动晋级必须与动态加载分离

问题：验证完成后立即在主进程动态加载候选，会让 Validator 或签名缺陷直接成为代码执行漏洞。

规则：晋级只写入 Signed Whitelist。真正加载必须由独立生产 Loader 再次验签、核对版本和 Capability，并在受控运行时启动。

## 5. 高权限候选不能因“测试通过”自动获得权限

问题：测试覆盖率、Reviewer 或模型判断都不能证明写文件、进程、网络或 Computer Use 永久安全。

规则：高权限 Tool/Skill 永远需要显式人工批准；批准必须记录审批人和原因，并在晋级时重新验证内容。

## 6. 历史协议测试应验证最低版本

问题：把 IPC 版本写死为旧值会阻止正常协议升级，并掩盖真正需要保证的兼容方法。

规则：历史阶段测试应验证 `version >= minimumVersion`，同时验证该阶段必需方法和响应结构仍存在。

## 7. 注册 View 不等于 View 可用

问题：Computer Use 容器已注册，但 ViewKind 没有渲染分支，导致空白界面，而类型检查未发现。

规则：每个已注册 ViewKind 必须有渲染分支契约测试，并验证 View 不持有直接执行能力。

## 8. 源码审计规则应匹配行为，不应匹配注释

问题：注释中说明“不得注册 ToolRegistry”也会被简单字符串规则误报。

规则：源码安全审计应匹配 import、实例化、调用等真实行为模式，并为注释/文档误报增加回归测试。

## 9. 候选签名不等于白名单状态签名

问题：Candidate Artifact 签名只证明候选包未变化，攻击者仍可能把 Whitelist 的 `disabled` 改成 `active`。

规则：Whitelist 状态、Promotion Mode、Capability 和时间字段必须使用独立决策签名；读取时同时验证 Artifact 签名和 Decision 签名。

## 10. 候选状态和白名单必须原子提交

问题：先保存 `promoted` Candidate、再保存 Whitelist，第二步失败会留下不可解释的安全状态；停用过程反向失败会让 Active Whitelist 继续生效。

规则：晋级、停用和回滚必须在单次 Registry Transaction 中同时写入 Candidate 和 Whitelist。故障测试必须证明提交失败时不会产生部分状态。
