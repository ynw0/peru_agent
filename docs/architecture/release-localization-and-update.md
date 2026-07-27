# 发布、本地化与原子更新架构

## 1. 目标

Phase 12 将“源码可验证”提升为“发布物可验证”。发布链由四个互不替代的信任层组成：

1. TypeScript/测试/安全审计证明源码状态；
2. SPDX SBOM 描述直接依赖；
3. Ed25519 Release Manifest 绑定版本、平台、文件 SHA-256 和 SBOM；
4. Windows Authenticode 绑定实际 PE 文件的发布者证书。

Manifest 签名不能替代 Authenticode，Authenticode 也不能替代文件级 Manifest。

## 2. 发布包结构

```text
bundle/
├── app/...                 # Manifest 中逐文件声明
├── sbom.spdx.json          # 独立 SHA-256 绑定
└── release-manifest.json   # 安装后由 Updater 保存的签名清单
```

Payload 不得声明 `release-manifest.json` 或 `sbom.spdx.json` 为普通文件，避免覆盖发布元数据。

## 3. 签名清单

Release Manifest 固定包含：

- 产品 ID；
- 稳定 SemVer；
- Channel、Platform、Architecture；
- 40 位源 Commit；
- Code OSS 1.74.0；
- SBOM SHA-256；
- 每个文件的路径、SHA-256、大小和可执行属性；
- Ed25519 Key ID、Digest 和签名。

路径必须为 `/` 分隔的相对路径，禁止绝对路径、反斜杠、空段、`.`、`..` 和重复项。

## 4. 原子更新

```text
签名验证
→ 当前版本单调性检查
→ Bundle 根目录与真实路径检查
→ 每文件哈希/大小检查
→ SBOM 检查
→ staging/<version-id>
→ rename 到 versions/<version>
→ 原子写 release-state.json
```

新版本必须严格高于当前版本。相同版本或降级不能走普通更新，只能使用显式 `rollback()` 切换到已验证版本。

激活状态只保存版本指针。更新失败时当前版本不变；回滚不重新解压或联网，只切换到已安装且已验证的版本。

## 5. Windows 发布

`packaging/windows/build-release.ps1` 要求：

- Windows；
- Node.js 16.14.x；
- Yarn Classic 1.x；
- Code OSS 锁定依赖和 Gulp；
- Windows SDK SignTool；
- 证书 Thumbprint、Publisher 和 RFC3161 Timestamp URL。

脚本先构建 Payload，再签名并验证 `.exe`、`.dll`、`.node`，之后生成 Archive 和 Setup，最后签名 Setup。任一失败会删除输出目录，不发布未验证文件。

## 6. 本地化

支持且只支持：

- `zh-CN`
- `en-US`

两个 Catalog 必须拥有完全相同的 Key。插值参数必须精确匹配，缺失、多余或未知 Locale 均明确失败，不进行静默语言回退。

## 7. UI 与 IPC 边界

Release Center 只能：

- 查看当前版本、Channel 和阻塞门禁；
- 验证签名 Manifest；
- 切换语言；
- 查看发布审计。

Workbench IPC 不接收安装路径、签名私钥、证书私钥或直接安装命令。真正安装只能由受信任后台发布服务调用 `AtomicReleaseManager`。

## 8. 生产发布门禁

生产发布必须同时通过：源码审计、strict、单元测试、Smoke、Code OSS 完整编译、两个 Windows Broker 红队、SBOM、恶意软件扫描和 Authenticode。

当前环境没有 Code OSS 锁定依赖、Windows、PowerShell 7、签名证书和恶意软件扫描服务，因此 Readiness 必须保持 blocked。
