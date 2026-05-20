import path from "node:path";

export type SupportedLanguage = "typescript" | "javascript" | "python" | "go";

export type ChunkKind =
  | "function"
  | "class"
  | "module"
  | "script"
  | "stager"
  | "decorator"
  | "interface"
  | "type"
  | "typed_dict"
  | "dataclass";

export type ChunkRole = "capability" | "context";

export type ChunkCandidate = {
  filePath: string;
  language: SupportedLanguage;
  kind: ChunkKind;
  symbolName?: string;
  startLine: number;
  endLine: number;
  code: string;
};

const FILE_EXCLUDE_PATTERNS: RegExp[] = [
  /\.d\.ts$/i,
  /\.test\.[cm]?[jt]sx?$/i,
  /\.spec\.[cm]?[jt]sx?$/i,
  /__tests__\//i,
  /\/tests?\//i,
  /\/coverage\//i,
  /\/node_modules\//i,
  /\/venv\//i,
  /\/\.venv\//i,
  /\/site-packages\//i,
  /\/__pycache__\//i,
  /\/dist\//i,
  /\/build\//i,
  /\/\.git\//i,
  /\.min\./i,
];

export function shouldExcludeFile(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/");
  return FILE_EXCLUDE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function getChunkRole(kind: ChunkKind): ChunkRole {
  if (kind === "interface" || kind === "type" || kind === "typed_dict" || kind === "dataclass") {
    return "context";
  }
  return "capability";
}

export function shouldRunAIPass(candidate: ChunkCandidate): boolean {
  return getChunkRole(candidate.kind) === "capability";
}

export function shouldSplitAstNodeForLineCount(): boolean {
  // Never split a single AST node by line count; preserve runnable logical units.
  return false;
}

export function isChunkIndexable(candidate: ChunkCandidate): boolean {
  if (shouldExcludeFile(candidate.filePath)) {
    return false;
  }

  // No minimum-line floor for named symbols.
  const hasNamedSymbol = typeof candidate.symbolName === "string" && candidate.symbolName.length > 0;
  if (hasNamedSymbol) {
    return true;
  }

  // Unnamed module/script chunks still need non-empty code.
  return candidate.code.trim().length > 0;
}

export function classifyPythonDecorator(code: string): ChunkKind {
  const trimmed = code.trim();

  // Decorator factory heuristic: nested wrapper returning callable and decorator-style shape.
  const hasNestedDef = /\n\s+def\s+\w+\s*\(/.test(trimmed);
  const hasReturnWrapper = /\n\s+return\s+\w+\s*$/m.test(trimmed);
  const looksLikeDecoratorFlow = /def\s+\w+\s*\([^)]*\):[\s\S]*@\w+|def\s+\w+\s*\([^)]*\):[\s\S]*def\s+\w+\s*\([^)]*\):/.test(trimmed);

  if (hasNestedDef && hasReturnWrapper && looksLikeDecoratorFlow) {
    return "decorator";
  }

  return "function";
}

export function chunkKeyFromCandidate(candidate: ChunkCandidate, contentHash: string): string {
  const rel = candidate.filePath.replace(path.sep, "/");
  return `${rel}:${candidate.startLine}-${candidate.endLine}:${contentHash}`;
}
