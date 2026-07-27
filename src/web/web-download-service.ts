import { createHash } from "node:crypto";
import type { NetworkMode } from "../agent-protocol.js";
import { EgressBroker } from "../egress/broker.js";
import type { EgressAuthorizationLease } from "../egress/types.js";
import { chooseDownloadFileName, type DownloadArtifactStore } from "./download-store.js";
import type { WebDownloadArtifact } from "./types.js";

export interface PreparedWebDownload {
  readonly lease: EgressAuthorizationLease;
  readonly workspaceId: string;
  readonly url: string;
  readonly mode: NetworkMode;
  readonly maxBytes: number;
}

export class WebDownloadService {
  public constructor(
    private readonly broker: EgressBroker,
    private readonly store: DownloadArtifactStore,
  ) {}

  public async prepare(
    workspaceId: string,
    url: string,
    mode: NetworkMode,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<PreparedWebDownload> {
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 32 * 1024 * 1024) {
      throw new Error("maxBytes 必须是 1~33554432 的整数");
    }
    const lease = await this.broker.authorize({ url, mode, purpose: "browser.download", method: "GET" }, signal);
    return { lease, workspaceId, url: lease.normalizedUrl, mode, maxBytes };
  }

  public discard(prepared: PreparedWebDownload): void {
    this.broker.discardAuthorization(prepared.lease.id);
  }

  public async execute(prepared: PreparedWebDownload, signal: AbortSignal): Promise<WebDownloadArtifact> {
    const response = await this.broker.fetchAuthorized(prepared.lease.id, {
      url: prepared.url,
      mode: prepared.mode,
      purpose: "browser.download",
      method: "GET",
      headers: { accept: "*/*" },
      maxResponseBytes: prepared.maxBytes,
    }, signal);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`下载响应状态无效：HTTP ${response.status}`);
    }
    if (response.byteLength > prepared.maxBytes) {
      throw new Error("下载内容超过已审核大小限制");
    }
    const contentType = findHeader(response.headers, "content-type") ?? "application/octet-stream";
    const fileName = chooseDownloadFileName(response.finalUrl, findHeader(response.headers, "content-disposition"));
    const sha256 = createHash("sha256").update(response.body).digest("hex");
    return this.store.save({
      workspaceId: prepared.workspaceId,
      sourceUrl: response.finalUrl,
      suggestedFileName: fileName,
      contentType,
      bytes: response.body,
      sha256,
    });
  }
}

function findHeader(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const expected = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === expected)?.[1];
}
