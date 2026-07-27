import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { EgressResolver } from "./types.js";

export class NodeDnsResolver implements EgressResolver {
  public async resolve(hostname: string, signal: AbortSignal): Promise<readonly { address: string; family: 4 | 6 }[]> {
    if (signal.aborted) {
      throw new Error("DNS 解析已取消");
    }
    const literalFamily = isIP(hostname);
    if (literalFamily === 4 || literalFamily === 6) {
      return [{ address: hostname, family: literalFamily }];
    }
    const lookupPromise = lookup(hostname, { all: true, verbatim: true });
    const records = await abortable(lookupPromise, signal);
    const unique = new Map<string, { address: string; family: 4 | 6 }>();
    for (const record of records) {
      if (record.family !== 4 && record.family !== 6) {
        continue;
      }
      unique.set(`${record.family}:${record.address}`, { address: record.address, family: record.family });
    }
    return [...unique.values()];
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("DNS 解析已取消"));
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new Error("DNS 解析已取消"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
