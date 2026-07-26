import { isIP } from "node:net";
import type { NetworkMode } from "./agent-protocol.js";

// 网络请求在发送前转换成此结构，由统一策略判断。
export interface NetworkTarget {
  readonly hostname: string;
  readonly resolvedAddresses: readonly string[];
}

function isLoopback(address: string): boolean {
  return address === "127.0.0.1" || address === "::1";
}

function isPrivateIpv4(address: string): boolean {
  if (isIP(address) !== 4) {
    return false;
  }

  const parts = address.split(".").map(Number);
  const first = parts[0];
  const second = parts[1];

  if (first === undefined || second === undefined) {
    return false;
  }

  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

// 所有解析地址都必须满足模式，防止一个域名同时解析到允许和不允许地址。
export function isNetworkTargetAllowed(mode: NetworkMode, target: NetworkTarget): boolean {
  if (target.resolvedAddresses.length === 0) {
    return false;
  }

  if (mode === "internet") {
    return true;
  }

  if (mode === "offline") {
    return target.resolvedAddresses.every(isLoopback);
  }

  return target.resolvedAddresses.every(address => isLoopback(address) || isPrivateIpv4(address));
}
