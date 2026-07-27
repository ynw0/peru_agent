import type { TypedIpcServer } from "../ipc/channel.js";
import type { EgressBroker } from "../egress/broker.js";
import type { WebFetchService, WebSearchService } from "../web/web-services.js";
import type { WebDownloadService } from "../web/web-download-service.js";

export class WebIpcBridge {
  private readonly disposables: { dispose(): void }[] = [];

  public constructor(
    private readonly server: TypedIpcServer,
    private readonly broker: EgressBroker,
    private readonly fetchService: WebFetchService,
    private readonly searchService: WebSearchService,
    private readonly downloadService?: WebDownloadService,
  ) {}

  public start(): void {
    this.disposables.push(
      this.server.registerHandler("egress.audit.list", async () => ({ entries: await this.broker.listAudit() })),
      this.server.registerHandler("web.fetch", async (request, signal) => {
        const prepared = await this.fetchService.prepare(request.url, request.mode, request.maxChars ?? 50_000, signal);
        try {
          return await this.fetchService.execute(prepared, signal);
        } catch (error) {
          this.fetchService.discard(prepared);
          throw error;
        }
      }),
      this.server.registerHandler("web.search", async (request, signal) => {
        const prepared = await this.searchService.prepare(request.query, request.maxResults ?? 5, request.mode, signal);
        try {
          return await this.searchService.execute(prepared, signal);
        } catch (error) {
          this.searchService.discard(prepared);
          throw error;
        }
      }),
      this.server.registerHandler("web.download", async (request, signal) => {
        if (this.downloadService === undefined) throw new Error("受控下载服务未配置");
        const prepared = await this.downloadService.prepare(
          request.workspaceId,
          request.url,
          request.mode,
          request.maxBytes ?? 16 * 1024 * 1024,
          signal,
        );
        try {
          return await this.downloadService.execute(prepared, signal);
        } catch (error) {
          this.downloadService.discard(prepared);
          throw error;
        }
      }),
    );
  }

  public dispose(): void {
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }
}
