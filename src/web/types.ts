import type { NetworkMode } from "../agent-protocol.js";

export interface WebFetchResult {
  readonly url: string;
  readonly status: number;
  readonly contentType: string;
  readonly title?: string;
  readonly text: string;
  readonly truncated: boolean;
  readonly byteLength: number;
  readonly redirects: readonly { readonly fromUrl: string; readonly toUrl: string; readonly status: number }[];
}

export interface WebSearchResultItem {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly source?: string;
}

export interface WebSearchResult {
  readonly query: string;
  readonly provider: string;
  readonly results: readonly WebSearchResultItem[];
}


export interface WebDownloadArtifact {
  readonly id: string;
  readonly workspaceId: string;
  readonly fileName: string;
  readonly relativePath: string;
  readonly sourceUrl: string;
  readonly contentType: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly createdAt: string;
}

export interface PreparedSearchRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly method: "GET" | "POST";
  readonly body?: string;
}

export interface WebSearchProvider {
  readonly name: string;
  prepare(query: string, maxResults: number): Promise<PreparedSearchRequest> | PreparedSearchRequest;
  parse(body: string, maxResults: number): readonly WebSearchResultItem[];
}

export interface NetworkModeProvider {
  getNetworkMode(): NetworkMode;
}
