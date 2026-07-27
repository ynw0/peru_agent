import test from "node:test";
import assert from "node:assert/strict";
import { CODE_OSS_SOURCE_PIN, validateCodeOssSourcePin } from "../src/product/code-oss-source.js";
import { PRODUCT_MANIFEST } from "../src/product/product-manifest.js";
import { WORKBENCH_CONTAINERS } from "../src/workbench/contributions.js";

test("Phase 2 固定用户提供的 Code OSS 1.74.0 归档", () => {
  validateCodeOssSourcePin(CODE_OSS_SOURCE_PIN);
  assert.equal(CODE_OSS_SOURCE_PIN.sourceType, "archive");
  assert.equal(CODE_OSS_SOURCE_PIN.version, "1.74.0");
  assert.equal(CODE_OSS_SOURCE_PIN.archiveSha256.length, 64);
});

test("Phase 2 不保留旧版 Code OSS 双版本兼容", () => {
  assert.equal(CODE_OSS_SOURCE_PIN.version === "1.130.0", false);
});

test("产品品牌、协议和数据目录使用独立命名", () => {
  assert.equal(PRODUCT_MANIFEST.applicationName, "independent-ai-ide");
  assert.equal(PRODUCT_MANIFEST.protocolScheme, "independent-ai-ide");
  assert.equal(PRODUCT_MANIFEST.dataFolderName, ".independent-ai-ide");
});

test("五个 AI IDE Workbench 容器位置符合计划", () => {
  const locations = new Map(WORKBENCH_CONTAINERS.map(container => [container.id, container.defaultLocation]));
  assert.equal(WORKBENCH_CONTAINERS.length, 5);
  assert.equal(locations.get("independentAiIde.agent"), "activityBar");
  assert.equal(locations.get("independentAiIde.browser"), "activityBar");
  assert.equal(locations.get("independentAiIde.computerUse"), "activityBar");
  assert.equal(locations.get("independentAiIde.tasks"), "panel");
  assert.equal(locations.get("independentAiIde.permissions"), "panel");
});
