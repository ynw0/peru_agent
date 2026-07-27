import type { NetworkMode } from "../agent-protocol.js";

export type EgressPurpose =
  | "web.fetch"
  | "web.search"
  | "browser.navigation"
  | "browser.resource"
  | "browser.download";

export type NetworkAddressClass =
  | "loopback"
  | "private"
  | "public"
  | "link-local"
  | "carrier-nat"
  | "multicast"
  | "documentation"
  | "unspecified"
  | "reserved";

export interface ResolvedNetworkAddress {
  readonly address: string;
  readonly family: 4 | 6;
  readonly classification: NetworkAddressClass;
}

export interface EgressAuthorizationRequest {
  readonly url: string;
  readonly mode: NetworkMode;
  readonly purpose: EgressPurpose;
  readonly method?: "GET" | "HEAD" | "POST";
}

export interface EgressAuthorizationLease {
  readonly id: string;
  readonly normalizedUrl: string;
  readonly urlSha256: string;
  readonly hostname: string;
  readonly port: number;
  readonly addresses: readonly ResolvedNetworkAddress[];
  readonly selectedAddress: ResolvedNetworkAddress;
  readonly mode: NetworkMode;
  readonly purpose: EgressPurpose;
  readonly method: "GET" | "HEAD" | "POST";
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface EgressFetchRequest extends EgressAuthorizationRequest {
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly maxResponseBytes?: number;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
}

export interface EgressRedirectHop {
  readonly fromUrl: string;
  readonly toUrl: string;
  readonly status: number;
}

export interface EgressFetchResponse {
  readonly requestId: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly byteLength: number;
  readonly redirects: readonly EgressRedirectHop[];
}

export interface EgressAuditEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly purpose: EgressPurpose;
  readonly mode: NetworkMode;
  readonly method: string;
  readonly redactedUrl: string;
  readonly hostname: string;
  readonly port: number;
  readonly addresses: readonly string[];
  readonly selectedAddress?: string;
  readonly decision: "allowed" | "denied" | "completed" | "failed";
  readonly reason: string;
  readonly status?: number;
  readonly byteLength?: number;
}

export interface EgressAuditStore {
  append(entry: EgressAuditEntry): Promise<void> | void;
  list(): Promise<readonly EgressAuditEntry[]> | readonly EgressAuditEntry[];
}

export interface EgressResolver {
  resolve(hostname: string, signal: AbortSignal): Promise<readonly { readonly address: string; readonly family: 4 | 6 }[]>;
}

export interface PinnedHttpRequest {
  readonly requestId: string;
  readonly url: string;
  readonly hostname: string;
  readonly port: number;
  readonly selectedAddress: string;
  readonly family: 4 | 6;
  readonly method: "GET" | "HEAD" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly maxResponseBytes: number;
  readonly timeoutMs: number;
}

export interface PinnedHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface PinnedHttpTransport {
  request(request: PinnedHttpRequest, signal: AbortSignal): Promise<PinnedHttpResponse>;
}
