import { digestValue } from "../evolution/canonical.js";

export interface SpdxPackageEntry {
  readonly SPDXID: string;
  readonly name: string;
  readonly versionInfo: string;
  readonly relationship: "RUNTIME_DEPENDENCY_OF" | "DEV_DEPENDENCY_OF";
}

export interface SpdxSbom {
  readonly spdxVersion: "SPDX-2.3";
  readonly dataLicense: "CC0-1.0";
  readonly SPDXID: "SPDXRef-DOCUMENT";
  readonly name: string;
  readonly documentNamespace: string;
  readonly creationInfo: { readonly created: string; readonly creators: readonly string[] };
  readonly packages: readonly SpdxPackageEntry[];
}

export function generateSourceSbom(packageJsonText: string, createdAt: string): SpdxSbom {
  const parsed = JSON.parse(packageJsonText) as unknown;
  if (!isRecord(parsed) || typeof parsed.name !== "string" || typeof parsed.version !== "string") throw new Error("package.json 结构无效");
  const packages: SpdxPackageEntry[] = [];
  appendDependencies(packages, parsed.dependencies, "RUNTIME_DEPENDENCY_OF");
  appendDependencies(packages, parsed.devDependencies, "DEV_DEPENDENCY_OF");
  packages.sort((left, right) => left.name.localeCompare(right.name) || left.relationship.localeCompare(right.relationship));
  const identity = digestValue({ name: parsed.name, version: parsed.version, packages });
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `${parsed.name}-${parsed.version}`,
    documentNamespace: `https://independent-ai-ide.invalid/sbom/${identity}`,
    creationInfo: { created: createdAt, creators: ["Tool: Independent AI IDE Release Pipeline"] },
    packages,
  };
}

function appendDependencies(target: SpdxPackageEntry[], value: unknown, relationship: SpdxPackageEntry["relationship"]): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new Error("依赖字段结构无效");
  for (const [name, version] of Object.entries(value)) {
    if (name.trim() === "" || typeof version !== "string" || version.trim() === "") throw new Error("依赖名称或版本无效");
    target.push({ SPDXID: `SPDXRef-Package-${sanitize(name)}-${relationship}`, name, versionInfo: version, relationship });
  }
}

function sanitize(value: string): string { return value.replace(/[^a-zA-Z0-9.-]/g, "-"); }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
