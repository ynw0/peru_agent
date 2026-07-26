// 工作区文件快照记录文件在某一时刻是否存在、内容和哈希。
export interface WorkspaceFileSnapshot {
  readonly path: string;
  readonly exists: boolean;
  readonly content: string | null;
  readonly sha256: string | null;
  readonly byteLength: number;
}

// 文本搜索结果包含相对路径、行号和该行内容。
export interface WorkspaceSearchMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

// 写入请求必须携带期望哈希，防止覆盖用户在检查后产生的新修改。
export interface WorkspaceWriteRequest {
  readonly path: string;
  readonly content: string;
  readonly expectedSha256: string | null;
}
