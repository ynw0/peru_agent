import { CODE_OSS_SOURCE_PIN, validateCodeOssSourcePin } from "./product/code-oss-source.js";
import { PRODUCT_MANIFEST, validateProductManifest } from "./product/product-manifest.js";
import { validateWorkbenchContainers, WORKBENCH_CONTAINERS } from "./workbench/contributions.js";

// Phase 2 Smoke Test 验证固定上游、独立品牌和当前完整 Workbench 入口集合。
validateCodeOssSourcePin(CODE_OSS_SOURCE_PIN);
validateProductManifest(PRODUCT_MANIFEST);
validateWorkbenchContainers(WORKBENCH_CONTAINERS);

if (CODE_OSS_SOURCE_PIN.version !== "1.74.0") {
  throw new Error("Phase 2 Code OSS 固定版本不是 1.74.0");
}
if (WORKBENCH_CONTAINERS.length !== 5) {
  throw new Error("Phase 2 Workbench 容器数量不正确");
}

console.log("Phase 2 Smoke Test 通过：固定源码归档、独立品牌和 Workbench 容器基线有效");
