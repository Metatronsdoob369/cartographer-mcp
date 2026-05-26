import { createHash } from "node:crypto";
import { builtinModules as nodeBuiltins } from "node:module";
import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript";
import {
  classifyPythonDecorator,
  getChunkRole,
  isChunkIndexable,
  shouldExcludeFile,
} from "./cartographer-chunk-policy.js";
import {
  type CapabilityAIPass,
  type ChunkKind,
  type DepKind,
  type ExtractedChunk,
  type ExtractedDependency,
  type ExtractedFilePayload,
  type TrustTier,
} from "./cartographer-types.js";

const NODE_BUILTINS = new Set([...nodeBuiltins, ...nodeBuiltins.map((v) => `node:${v}`)]);

type ParserOptions = {
  allowlistRoots: string[];
  aiPass?: CapabilityAIPass;
};

type ImportBinding = {
  localName: string;
  depKind: DepKind;
  importRaw: string;
  normalizedTarget: string;
};

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return "typescript";
  if (ext === ".py") return "python";
  if (ext === ".go") return "go";
  return "unknown";
}

function pathBlockedByRuntimeDenylist(filePath: string): boolean {
  const n = path.resolve(filePath).replaceAll("\\", "/").toLowerCase();
  return (
    n.includes("/venv/") ||
    n.includes("/.venv/") ||
    n.includes("/site-packages/") ||
    n.includes("/node_modules/") ||
    n.includes("/__pycache__/") ||
    n.includes("/dist/") ||
    n.includes("/build/") ||
    n.includes("/coverage/")
  );
}

function resolveTrustTier(filePath: string): TrustTier {
  const norm = filePath.replaceAll("\\", "/").toLowerCase();
  if (norm.includes("/published/")) return "published";
  if (norm.includes("/capsule") || norm.includes("/capsules/")) return "capsule";
  if (norm.includes("/draft") || norm.includes("/drafts/")) return "draft";
  return "unknown";
}

function resolveRepoRoot(filePath: string, allowlistRoots: string[]): string {
  const abs = path.resolve(filePath);
  const match = allowlistRoots
    .map((p) => path.resolve(p))
    .sort((a, b) => b.length - a.length)
    .find((root) => abs === root || abs.startsWith(`${root}${path.sep}`));
  return match ?? path.dirname(abs);
}

function classifyImport(specifier: string): DepKind {
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    return "internal";
  }
  if (NODE_BUILTINS.has(specifier)) {
    return "builtin";
  }
  return "external";
}

function buildChunkKey(filePath: string, byteStart: number, byteEnd: number): string {
  const keySource = `${path.resolve(filePath)}:${byteStart}:${byteEnd}`;
  return sha256(keySource);
}

function createChunkRecord(params: {
  filePath: string;
  kind: ChunkKind;
  symbolName: string | null;
  startLine: number;
  endLine: number;
  code: string;
  byteStart: number;
  byteEnd: number;
  dependencies: ExtractedDependency[];
  internalDependencyCount: number;
  externalDependencyCount: number;
}): Omit<ExtractedChunk, "capability_summary" | "embedding"> {
  return {
    chunk_key: buildChunkKey(params.filePath, params.byteStart, params.byteEnd),
    symbol_name: params.symbolName,
    chunk_kind: params.kind,
    start_line: params.startLine,
    end_line: params.endLine,
    code: params.code,
    content_hash: sha256(params.code),
    chunk_bytes: Buffer.byteLength(params.code, "utf8"),
    internal_workspace_import_count: params.internalDependencyCount,
    external_runtime_dependency_count: params.externalDependencyCount,
    dependencies: params.dependencies,
  };
}

function countDependenciesForChunk(code: string, bindings: ImportBinding[]) {
  const used: ImportBinding[] = [];
  for (const binding of bindings) {
    const escaped = binding.localName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\b${escaped}\\b`);
    if (pattern.test(code)) {
      used.push(binding);
    }
  }

  const deps: ExtractedDependency[] = used.map((u) => ({
    import_raw: u.importRaw,
    dep_kind: u.depKind,
    normalized_target: u.normalizedTarget,
  }));

  const internalCount = used.filter((u) => u.depKind === "internal").length;
  const externalCount = used.filter((u) => u.depKind === "external" || u.depKind === "builtin").length;

  return { deps, internalCount, externalCount };
}

function mapTsNodeKind(node: ts.Node): ChunkKind | null {
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isFunctionDeclaration(node)) return "function";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isTypeAliasDeclaration(node)) return "type";
  if (ts.isVariableStatement(node)) return "function";
  return null;
}

function getNodeSymbolName(node: ts.Node): string | null {
  if ((ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && node.name) {
    return node.name.text;
  }

  if (ts.isVariableStatement(node)) {
    const decl = node.declarationList.declarations[0];
    if (decl && ts.isIdentifier(decl.name)) {
      return decl.name.text;
    }
  }

  return null;
}

function detectStager(symbolName: string | null): boolean {
  return !!symbolName && /stager|stage0|stage1/i.test(symbolName);
}

function extractBindingsFromTs(sourceFile: ts.SourceFile): ImportBinding[] {
  const bindings: ImportBinding[] = [];

  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const moduleName = stmt.moduleSpecifier.text;
    const depKind = classifyImport(moduleName);
    const clause = stmt.importClause;
    if (!clause) continue;

    if (clause.name) {
      bindings.push({
        localName: clause.name.text,
        depKind,
        importRaw: moduleName,
        normalizedTarget: moduleName,
      });
    }

    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      bindings.push({
        localName: clause.namedBindings.name.text,
        depKind,
        importRaw: moduleName,
        normalizedTarget: moduleName,
      });
    }

    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        bindings.push({
          localName: element.name.text,
          depKind,
          importRaw: moduleName,
          normalizedTarget: moduleName,
        });
      }
    }
  }

  return bindings;
}

async function enrichWithAIPass(
  filePath: string,
  aiPass: CapabilityAIPass | undefined,
  chunk: Omit<ExtractedChunk, "capability_summary" | "embedding">
): Promise<ExtractedChunk> {
  const role = getChunkRole(chunk.chunk_kind);
  if (role === "context") {
    return { ...chunk, capability_summary: null, embedding: null };
  }

  const fallback = `${chunk.chunk_kind} ${chunk.symbol_name ?? "anonymous"} capability`;
  if (!aiPass) {
    return { ...chunk, capability_summary: fallback, embedding: null };
  }

  const capabilitySummary = await aiPass.summarize({
    filePath,
    symbolName: chunk.symbol_name,
    chunkKind: chunk.chunk_kind,
    code: chunk.code,
  });
  const embedding = await aiPass.embed(capabilitySummary);
  return { ...chunk, capability_summary: capabilitySummary, embedding };
}

async function parseTypeScriptLike(
  filePath: string,
  source: string,
  aiPass: CapabilityAIPass | undefined
): Promise<ExtractedChunk[]> {
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const bindings = extractBindingsFromTs(sourceFile);
  const out: ExtractedChunk[] = [];

  for (const stmt of sourceFile.statements) {
    const mappedKind = mapTsNodeKind(stmt);
    if (!mappedKind) continue;

    if (ts.isVariableStatement(stmt)) {
      const decl = stmt.declarationList.declarations[0];
      if (!decl?.initializer || !(ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
        continue;
      }
    }

    const symbolName = getNodeSymbolName(stmt);
    const kind: ChunkKind = detectStager(symbolName) ? "stager" : mappedKind;
    const byteStart = stmt.getStart(sourceFile);
    const byteEnd = stmt.getEnd();
    const code = source.slice(byteStart, byteEnd);

    const start = sourceFile.getLineAndCharacterOfPosition(byteStart).line + 1;
    const end = sourceFile.getLineAndCharacterOfPosition(byteEnd).line + 1;

    const { deps, internalCount, externalCount } = countDependenciesForChunk(code, bindings);

    const base = createChunkRecord({
      filePath,
      kind,
      symbolName,
      startLine: start,
      endLine: end,
      code,
      byteStart,
      byteEnd,
      dependencies: deps,
      internalDependencyCount: internalCount,
      externalDependencyCount: externalCount,
    });

    const candidate = {
      filePath,
      language: "typescript" as const,
      kind,
      symbolName: symbolName ?? undefined,
      startLine: start,
      endLine: end,
      code,
    };

    if (!isChunkIndexable(candidate)) {
      continue;
    }

    out.push(await enrichWithAIPass(filePath, aiPass, base));
  }

  return out;
}

async function parsePython(
  filePath: string,
  source: string,
  aiPass: CapabilityAIPass | undefined
): Promise<ExtractedChunk[]> {
  const lines = source.split(/\r?\n/);
  const chunks: ExtractedChunk[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const classMatch = line.match(/^class\s+([A-Za-z_][A-Za-z0-9_]*)\s*[(:]/);
    const fnMatch = line.match(/^def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);

    if (!classMatch && !fnMatch) continue;

    const symbolName = (classMatch?.[1] ?? fnMatch?.[1] ?? null) as string | null;
    const baseIndent = (line.match(/^\s*/) ?? [""])[0].length;

    let endLine = i + 1;
    for (let j = i + 1; j < lines.length; j++) {
      const current = lines[j];
      const indent = (current.match(/^\s*/) ?? [""])[0].length;
      if (current.trim().length > 0 && indent <= baseIndent) {
        break;
      }
      endLine = j + 1;
    }

    const code = lines.slice(i, endLine).join("\n");
    const kind: ChunkKind = classMatch
      ? "class"
      : classifyPythonDecorator(code) === "decorator"
        ? "decorator"
        : detectStager(symbolName)
          ? "stager"
          : "function";

    const base = createChunkRecord({
      filePath,
      kind,
      symbolName,
      startLine: i + 1,
      endLine,
      code,
      byteStart: source.indexOf(code),
      byteEnd: source.indexOf(code) + code.length,
      dependencies: [],
      internalDependencyCount: 0,
      externalDependencyCount: 0,
    });

    const candidate = {
      filePath,
      language: "python" as const,
      kind,
      symbolName: symbolName ?? undefined,
      startLine: i + 1,
      endLine,
      code,
    };

    if (!isChunkIndexable(candidate)) continue;
    chunks.push(await enrichWithAIPass(filePath, aiPass, base));
    i = endLine - 1;
  }

  return chunks;
}

async function parseFallbackScript(
  filePath: string,
  source: string,
  aiPass: CapabilityAIPass | undefined
): Promise<ExtractedChunk[]> {
  const lines = source.split(/\r?\n/);
  const base = createChunkRecord({
    filePath,
    kind: "script",
    symbolName: null,
    startLine: 1,
    endLine: lines.length,
    code: source,
    byteStart: 0,
    byteEnd: source.length,
    dependencies: [],
    internalDependencyCount: 0,
    externalDependencyCount: 0,
  });

  return [await enrichWithAIPass(filePath, aiPass, base)];
}

export async function extractFilePayload(filePath: string, options: ParserOptions): Promise<ExtractedFilePayload | null> {
  if (shouldExcludeFile(filePath) || pathBlockedByRuntimeDenylist(filePath)) {
    return null;
  }

  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return null;
  }

  const raw = fs.readFileSync(abs);
  // Skip binary files — check first 512 bytes for non-printable chars
  const sample = raw.slice(0, 512);
  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i];
    if (b !== undefined && b < 32 && b !== 9 && b !== 10 && b !== 13) nonPrintable++;
  }
  if (nonPrintable / sample.length > 0.05) return null;

  const source = raw.toString("utf8");
  if (!source.trim()) return null;  // skip empty files

  const stats = fs.statSync(abs);
  const language = detectLanguage(abs);
  let chunks: ExtractedChunk[] = [];

  if (language === "typescript") {
    chunks = await parseTypeScriptLike(abs, source, options.aiPass);
  } else if (language === "python") {
    chunks = await parsePython(abs, source, options.aiPass);
  } else {
    chunks = await parseFallbackScript(abs, source, options.aiPass);
  }

  return {
    path: abs,
    repo_root: resolveRepoRoot(abs, options.allowlistRoots),
    trust_tier: resolveTrustTier(abs),
    language,
    size_bytes: stats.size,
    content_hash: sha256(source),
    mtime_ms: Math.floor(stats.mtimeMs),
    chunks,
  };
}
