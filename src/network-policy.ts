import type { NetworkMode } from "./agent-protocol.js";
import { assertAddressesAllowed, classifyNetworkAddress } from "./egress/address-policy.js";

// 兼容基础策略测试的最小结构；生产请求统一进入 EgressBroker。
export interface NetworkTarget {
  readonly hostname: string;
  readonly resolvedAddresses: readonly string[];
}

// 所有解析地址都必须满足模式，混合解析会整体拒绝，防止 DNS Rebinding。
export function isNetworkTargetAllowed(mode: NetworkMode, target: NetworkTarget): boolean {
  try {
    assertAddressesAllowed(mode, target.resolvedAddresses.map(classifyNetworkAddress));
    return true;
  } catch {
    return false;
  }
}
