import { isIP } from "node:net";
import type { NetworkMode } from "../agent-protocol.js";
import type { NetworkAddressClass, ResolvedNetworkAddress } from "./types.js";

function parseIpv4(address: string): readonly number[] | undefined {
  if (isIP(address) !== 4) {
    return undefined;
  }
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : undefined;
}

function classifyIpv4(address: string): NetworkAddressClass {
  const parts = parseIpv4(address);
  if (parts === undefined) {
    return "reserved";
  }
  const [a = 0, b = 0, c = 0] = parts;
  if (a === 127) return "loopback";
  if (a === 0) return "unspecified";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private";
  if (a === 169 && b === 254) return "link-local";
  if (a === 100 && b >= 64 && b <= 127) return "carrier-nat";
  if (a >= 224 && a <= 239) return "multicast";
  if ((a === 192 && b === 0 && c === 2)
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)) return "documentation";
  if (a >= 240) return "reserved";
  return "public";
}

function classifyIpv6(address: string): NetworkAddressClass {
  const normalized = address.toLowerCase().split("%")[0] ?? "";
  if (normalized === "::1") return "loopback";
  if (normalized === "::") return "unspecified";
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return "private";
  if (/^fe[89ab]/.test(normalized)) return "link-local";
  if (normalized.startsWith("ff")) return "multicast";
  if (normalized.startsWith("2001:db8")) return "documentation";
  return "public";
}

export function classifyNetworkAddress(address: string): ResolvedNetworkAddress {
  const family = isIP(address);
  if (family !== 4 && family !== 6) {
    throw new Error(`不是有效 IP 地址：${address}`);
  }
  return {
    address,
    family,
    classification: family === 4 ? classifyIpv4(address) : classifyIpv6(address),
  };
}

export function isAddressAllowedForMode(mode: NetworkMode, address: ResolvedNetworkAddress): boolean {
  if (mode === "offline") {
    return address.classification === "loopback";
  }
  if (mode === "lan") {
    return address.classification === "loopback" || address.classification === "private";
  }
  return address.classification === "public";
}

export function assertAddressesAllowed(
  mode: NetworkMode,
  addresses: readonly ResolvedNetworkAddress[],
): void {
  if (addresses.length === 0) {
    throw new Error("DNS 解析没有返回地址");
  }
  const denied = addresses.filter(address => !isAddressAllowedForMode(mode, address));
  if (denied.length !== 0) {
    throw new Error(
      `网络模式 ${mode} 拒绝地址：${denied.map(item => `${item.address}(${item.classification})`).join(", ")}`,
    );
  }
}
