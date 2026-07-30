import { readFile } from "node:fs/promises";
import { validateCertifiedApplicationManifest } from "./certification.js";
import type { CertifiedApplicationManifest } from "./types.js";

export async function loadCertifiedApplicationManifests(filePath: string): Promise<readonly CertifiedApplicationManifest[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error: unknown) {
    throw new Error(`Computer Use 认证清单无法读取：${error instanceof Error ? error.message : "读取失败"}`);
  }
  let value: unknown;
  try { value = JSON.parse(raw); } catch (error: unknown) {
    throw new Error(`Computer Use 认证清单 JSON 无效：${error instanceof Error ? error.message : "解析失败"}`);
  }
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.applications)) {
    throw new Error("Computer Use 认证清单必须包含 version=1 和 applications 数组");
  }
  const manifests: CertifiedApplicationManifest[] = [];
  for (const [index, item] of value.applications.entries()) {
    if (!isRecord(item)) throw new Error(`认证清单 applications[${index}] 必须是对象`);
    const manifest = parseManifest(item, index);
    validateCertifiedApplicationManifest(manifest);
    manifests.push(manifest);
  }
  return manifests;
}

function parseManifest(value: Record<string, unknown>, index: number): CertifiedApplicationManifest {
  const array = (name: string): readonly string[] => {
    const item = value[name];
    if (!Array.isArray(item) || item.some(entry => typeof entry !== "string")) {
      throw new Error(`认证清单 applications[${index}].${name} 必须是字符串数组`);
    }
    return item;
  };
  const string = (name: string): string => {
    const item = value[name];
    if (typeof item !== "string") throw new Error(`认证清单 applications[${index}].${name} 必须是字符串`);
    return item;
  };
  const actions = array("allowedActions");
  return {
    id: string("id"),
    displayName: string("displayName"),
    executableNames: array("executableNames"),
    allowedPathRoots: array("allowedPathRoots"),
    publisherSubjects: array("publisherSubjects"),
    signerThumbprints: array("signerThumbprints"),
    allowedFileSha256: array("allowedFileSha256"),
    versionPattern: string("versionPattern"),
    allowedWindowClasses: array("allowedWindowClasses"),
    allowedActions: actions as CertifiedApplicationManifest["allowedActions"],
    allowedShortcuts: array("allowedShortcuts"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
