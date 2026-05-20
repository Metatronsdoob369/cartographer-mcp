export type TrustTier = "published" | "capsule" | "draft" | "unknown";

export type ChunkKind =
  | "function"
  | "class"
  | "stager"
  | "decorator"
  | "interface"
  | "type"
  | "module"
  | "script";

export type DepKind = "internal" | "external" | "builtin";

export interface ExtractedDependency {
  import_raw: string;
  dep_kind: DepKind;
  normalized_target: string | null;
}

export interface ExtractedChunk {
  chunk_key: string;
  symbol_name: string | null;
  chunk_kind: ChunkKind;
  start_line: number;
  end_line: number;
  code: string;
  content_hash: string;
  chunk_bytes: number;
  internal_workspace_import_count: number;
  external_runtime_dependency_count: number;
  capability_summary: string | null;
  embedding: Float32Array | null;
  dependencies: ExtractedDependency[];
}

export interface ExtractedFilePayload {
  path: string;
  repo_root: string;
  trust_tier: TrustTier;
  language: string;
  size_bytes: number;
  content_hash: string;
  mtime_ms: number;
  chunks: ExtractedChunk[];
}

export interface CapabilityAIPass {
  summarize(input: {
    filePath: string;
    symbolName: string | null;
    chunkKind: ChunkKind;
    code: string;
  }): Promise<string>;
  embed(summary: string): Promise<Float32Array | null>;
}
