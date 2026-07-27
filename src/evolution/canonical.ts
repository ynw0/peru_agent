import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function digestValue(value: unknown): string {
  return sha256Text(canonicalJson(value));
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => normalize(item));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalize(item)]),
    );
  }
  return value;
}
