# ADR-0006：使用受控 Overlay 接入 Code OSS Workbench

状态：已批准并执行

## 决策

不直接在固定上游副本中手工开发。独立产品改动全部保存在 `overlays/code-oss`，通过白名单清单应用。

当前允许的操作只有：

- 合并独立 `product.json` 身份；
- 复制 `independentAiIde` Workbench Contribution；
- 在 `workbench.desktop.main.ts` 的唯一锚点前插入一次 Contribution Import。

## 原因

- 上游源码保持可重新导入；
- 修改范围可以审计；
- 锚点漂移会直接失败；
- 避免复制和长期维护完整 `workbench.desktop.main.ts`；
- 后续替换上游版本时可以清楚定位内部 API 差异。

## 验证

Overlay 必须依次通过：

1. 清单目标和模式白名单；
2. TypeScript Overlay 独立结构检查；
3. 固定 Code OSS 内部模块与 Codicon 契约检查；
4. 应用后产品字段、导入次数、容器 ID 检查；
5. 完整 Code OSS 编译和启动门禁。

当前前四项已通过，第五项因上游依赖未安装而未通过。
