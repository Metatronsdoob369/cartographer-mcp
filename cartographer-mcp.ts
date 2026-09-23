#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { createCapabilityAIPass } from "./cartographer-ai-pass.js";
import { extractFilePayload } from "./cartographer-parser.js";
import { upsertFilePayloadAtomic } from "./cartographer-store.js";

type Policy = {
  name: string;
  trustAllowlist: string[];
  maxChunkBytes: number | null;
  requireExternalDepsZero: boolean;
  requireTestsForTags: string[];
  includeDrafts: boolean;
};

type SearchRow = {
  chunk_key: string;
  symbol_name: string | null;
  file_path: string;
  trust_tier: string;
  chunk_kind: string;
  start_line: number;
  end_line: number;
  capability_summary: string | null;
  chunk_bytes: number;
  capability_per_byte: number;
  external_runtime_dependency_count: number;
  tests_passed: number;
  last_test_pass_at: string | null;
  distance: number;
};

const DEFAULT_DB_PATH = process.env.CARTO_DB_PATH ?? "/Users/joewales/.cartographer/cartographer.sqlite";
const DEFAULT_ALLOWLIST = (process.env.CARTO_ALLOWLIST_PATHS ??
  "/Users/joewales/NODE_OUT_Master,/Users/joewales/MiroFish,/Users/joewales/smb-claw,/Users/joewales/polybot,/Users/joewales/property-hydra,/Users/joewales/sarn-landing")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".md", ".txt", ".json", ".jsonl"]);

const db = new Database(DEFAULT_DB_PATH);
loadSqliteVec(db);
db.pragma("foreign_keys = ON");

const aiPass = createCapabilityAIPass({ fallbackEmbeddingDim: Number(process.env.CARTO_FALLBACK_EMBED_DIM ?? 768) });
let activeProfile = "payload-strict";

function purgeBlockedIndexedRows() {
  db.exec(`
    DELETE FROM files
    WHERE lower(path) LIKE '%/venv/%'
       OR lower(path) LIKE '%/.venv/%'
       OR lower(path) LIKE '%/site-packages/%'
       OR lower(path) LIKE '%/node_modules/%'
       OR lower(path) LIKE '%/dist/%'
       OR lower(path) LIKE '%/build/%'
       OR lower(path) LIKE '%/coverage/%'
       OR lower(path) LIKE '%/__tests__/%'
       OR lower(path) LIKE '%/tests/%'
  `);
}

function toEmbeddingBlob(embedding: Float32Array): Buffer {
  const copy = new Float32Array(embedding);
  return Buffer.from(copy.buffer);
}

function parsePolicy(name: string): Policy | null {
  const row = db
    .prepare(
      `SELECT name, trust_allowlist, max_chunk_bytes, require_external_deps_zero, require_tests_for_tags, include_drafts
       FROM policies WHERE name = ?`
    )
    .get(name) as
    | {
        name: string;
        trust_allowlist: string;
        max_chunk_bytes: number | null;
        require_external_deps_zero: number;
        require_tests_for_tags: string;
        include_drafts: number;
      }
    | undefined;

  if (!row) return null;

  return {
    name: row.name,
    trustAllowlist: safeJsonArray(row.trust_allowlist),
    maxChunkBytes: row.max_chunk_bytes,
    requireExternalDepsZero: row.require_external_deps_zero === 1,
    requireTestsForTags: safeJsonArray(row.require_tests_for_tags),
    includeDrafts: row.include_drafts === 1,
  };
}

function safeJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

function getEffectivePolicy(profile?: string): Policy {
  const name = profile ?? activeProfile;
  const policy = parsePolicy(name);
  if (!policy) {
    throw new Error(`policy not found: ${name}`);
  }
  return policy;
}

function trustClause(policy: Policy) {
  const trusts = policy.includeDrafts
    ? Array.from(new Set([...policy.trustAllowlist, "draft"]))
    : policy.trustAllowlist;
  if (trusts.length === 0) {
    return {
      sql: "AND 1 = 0",
      params: [] as unknown[],
    };
  }
  const placeholders = trusts.map(() => "?").join(",");
  return {
    sql: `AND f.trust_tier IN (${placeholders})`,
    params: trusts,
  };
}

function testsGateClause(policy: Policy) {
  if (policy.requireTestsForTags.length === 0) {
    return { sql: "", params: [] as unknown[] };
  }

  const placeholders = policy.requireTestsForTags.map(() => "?").join(",");
  return {
    sql: `
      AND (
        c.tests_passed = 1
        OR NOT EXISTS (
          SELECT 1
          FROM json_each(c.execution_tags) et
          WHERE et.value IN (${placeholders})
        )
      )
    `,
    params: policy.requireTestsForTags,
  };
}

function buildSearchQuery(policy: Policy, k: number, limit: number) {
  const trust = trustClause(policy);
  const testsGate = testsGateClause(policy);
  const maxExternalDeps = policy.requireExternalDepsZero ? 0 : Number.MAX_SAFE_INTEGER;
  const strictLanguageGate =
    policy.name === "payload-strict"
      ? "AND (lower(f.path) LIKE '%.ts' OR lower(f.path) LIKE '%.tsx' OR lower(f.path) LIKE '%.py')"
      : "";

  const sql = `
    WITH eligible AS (
      SELECT c.id
      FROM chunks c
      JOIN files f ON f.id = c.file_id
      WHERE c.chunk_role = 'capability'
        AND (? IS NULL OR c.chunk_bytes <= ?)
        AND c.external_runtime_dependency_count <= ?
        AND lower(f.path) NOT LIKE '%/venv/%'
        AND lower(f.path) NOT LIKE '%/.venv/%'
        AND lower(f.path) NOT LIKE '%/site-packages/%'
        AND lower(f.path) NOT LIKE '%/node_modules/%'
        AND lower(f.path) NOT LIKE '%/dist/%'
        AND lower(f.path) NOT LIKE '%/build/%'
        ${strictLanguageGate}
        ${trust.sql}
        ${testsGate.sql}
    ),
    knn AS (
      SELECT rowid, distance
      FROM chunk_vec
      WHERE rowid IN (SELECT id FROM eligible)
        AND embedding MATCH ?
        AND k = ?
    )
    SELECT
      c.chunk_key,
      c.symbol_name,
      f.path AS file_path,
      f.trust_tier,
      c.chunk_kind,
      c.start_line,
      c.end_line,
      c.capability_summary,
      c.chunk_bytes,
      c.capability_per_byte,
      c.external_runtime_dependency_count,
      c.tests_passed,
      c.last_test_pass_at,
      knn.distance
    FROM knn
    JOIN chunks c ON c.id = knn.rowid
    JOIN files f ON f.id = c.file_id
    ORDER BY
      knn.distance ASC,
      c.capability_per_byte DESC,
      c.last_test_pass_at DESC
    LIMIT ?
  `;

  const params: unknown[] = [
    policy.maxChunkBytes,
    policy.maxChunkBytes,
    maxExternalDeps,
    ...trust.params,
    ...testsGate.params,
    k,
    limit,
  ];

  return { sql, params };
}

function tieBreakApplied(rows: SearchRow[]): boolean {
  if (rows.length < 2) return false;
  const a = rows[0].distance;
  const b = rows[1].distance;
  const denom = Math.max(Math.abs(a), 1e-9);
  const rel = Math.abs(b - a) / denom;
  return rel <= 0.05;
}

function normalizeResultRows(rows: SearchRow[]) {
  return rows.map((r) => ({
    chunk_key: r.chunk_key,
    symbol_name: r.symbol_name,
    file_path: r.file_path,
    trust_tier: r.trust_tier,
    chunk_kind: r.chunk_kind,
    start_line: r.start_line,
    end_line: r.end_line,
    capability_summary: r.capability_summary,
    chunk_bytes: r.chunk_bytes,
    capability_per_byte: r.capability_per_byte,
    external_runtime_dependency_count: r.external_runtime_dependency_count,
    tests_passed: Boolean(r.tests_passed),
    last_test_pass_at: r.last_test_pass_at,
    distance: r.distance,
  }));
}

async function embedIntent(intent: string): Promise<Buffer> {
  const vec = await aiPass.embed(intent);
  if (!vec) {
    throw new Error("embedding generation failed");
  }
  return toEmbeddingBlob(vec);
}

function walkFiles(root: string, maxFiles: number): string[] {
  const out: string[] = [];
  const stack = [path.resolve(root)];

  const ignoreDir = (d: string) => {
    const n = d.replaceAll("\\", "/");
    return (
      n.includes("/node_modules/") ||
      n.includes("/venv/") ||
      n.includes("/.venv/") ||
      n.includes("/site-packages/") ||
      n.includes("/.git/") ||
      n.includes("/dist/") ||
      n.includes("/build/") ||
      n.includes("/.next/") ||
      n.includes("/__pycache__/") ||
      n.includes("/coverage/") ||
      n.includes("/tests/") ||
      n.includes("/__tests__/")
    );
  };

  while (stack.length > 0) {
    if (out.length >= maxFiles) break;
    const current = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) {
        if (!ignoreDir(full)) {
          stack.push(full);
        }
        continue;
      }
      if (!e.isFile()) continue;

      const lower = e.name.toLowerCase();
      if (lower.includes(".test.") || lower.includes(".spec.")) continue;
      if (lower.endsWith(".d.ts") || lower.includes(".min.")) continue;

      const ext = path.extname(e.name).toLowerCase();
      if (!SOURCE_EXTENSIONS.has(ext)) continue;

      out.push(full);
      if (out.length >= maxFiles) break;
    }
  }

  return out;
}

const server = new McpServer({ name: "cartographer-mcp", version: "0.1.0" });

server.registerTool(
  "search_capability",
  {
    description:
      "Find reusable capability chunks by semantic intent under deterministic policy gates (trust, density, import strictness, telemetry).",
    inputSchema: z.object({
      intent: z.string().min(1),
      profile: z.string().optional(),
      limit: z.number().int().min(1).max(20).default(5),
      k: z.number().int().min(1).max(200).default(30),
    }),
  },
  async ({ intent, profile, limit, k }) => {
    try {
      const policy = getEffectivePolicy(profile);
      const queryEmbedding = await embedIntent(intent);
      const built = buildSearchQuery(policy, k, limit);
      const gateParams = built.params.slice(0, -2);
      const tailParams = built.params.slice(-2);
      const rows = db.prepare(built.sql).all(...gateParams, queryEmbedding, ...tailParams) as SearchRow[];

      const results = normalizeResultRows(rows);
      const output = {
        intent,
        profile: policy.name,
        gates: {
          trust_allowlist: policy.includeDrafts
            ? Array.from(new Set([...policy.trustAllowlist, "draft"]))
            : policy.trustAllowlist,
          max_chunk_bytes: policy.maxChunkBytes,
          max_external_runtime_dependency_count: policy.requireExternalDepsZero ? 0 : null,
          require_tests_for_tags: policy.requireTestsForTags,
        },
        tie_break_applied: tieBreakApplied(rows),
        result_count: results.length,
        results,
      };

      return {
        structuredContent: output,
        content: [{ type: "text", text: JSON.stringify(output) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `search_capability failed: ${(error as Error).message}` }],
      };
    }
  }
);

server.registerTool(
  "map_dependencies",
  {
    description: "Return dependency edges for a chunk key so agents can assess import chain and portability.",
    inputSchema: z.object({
      chunk_key: z.string().min(1),
    }),
  },
  async ({ chunk_key }) => {
    try {
      const rows = db
        .prepare(
          `SELECT d.import_raw, d.dep_kind, d.normalized_target
           FROM deps d
           JOIN chunks c ON c.id = d.chunk_id
           WHERE c.chunk_key = ?
           ORDER BY d.dep_kind, d.normalized_target`
        )
        .all(chunk_key) as Array<{ import_raw: string; dep_kind: string; normalized_target: string | null }>;

      const output = {
        chunk_key,
        dependency_count: rows.length,
        dependencies: rows,
      };

      return {
        structuredContent: output,
        content: [{ type: "text", text: JSON.stringify(output) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `map_dependencies failed: ${(error as Error).message}` }],
      };
    }
  }
);

server.registerTool(
  "evaluate_redundancy",
  {
    description:
      "Compare draft source code to indexed capability chunks and report high-similarity reuse candidates.",
    inputSchema: z.object({
      source_code: z.string().min(1),
      chunk_kind: z.enum(["function", "class", "stager", "decorator", "module", "script", "interface", "type"]).default("function"),
      symbol_name: z.string().optional(),
      profile: z.string().optional(),
      threshold: z.number().min(0).max(2).default(0.15),
      k: z.number().int().min(1).max(50).default(5),
    }),
  },
  async ({ source_code, chunk_kind, symbol_name, profile, threshold, k }) => {
    try {
      const policy = getEffectivePolicy(profile);
      const summary = await aiPass.summarize({
        filePath: "inline://draft",
        symbolName: symbol_name ?? null,
        chunkKind: chunk_kind,
        code: source_code,
      });
      const embedding = await aiPass.embed(summary);
      if (!embedding) {
        throw new Error("embedding generation failed");
      }

      const built = buildSearchQuery(policy, k, k);
      const gateParams = built.params.slice(0, -2);
      const tailParams = built.params.slice(-2);
      const rows = db.prepare(built.sql).all(...gateParams, toEmbeddingBlob(embedding), ...tailParams) as SearchRow[];
      const results = normalizeResultRows(rows);
      const best = results[0] ?? null;
      const abortRewrite = !!best && best.distance < threshold;

      const output = {
        profile: policy.name,
        summary,
        threshold,
        abort_rewrite: abortRewrite,
        recommendation: abortRewrite
          ? `Abort rewrite. Reuse existing chunk at ${best.file_path}:${best.start_line}`
          : "No high-identity match found under current policy.",
        best_match: best,
        candidates: results,
      };

      return {
        structuredContent: output,
        content: [{ type: "text", text: JSON.stringify(output) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `evaluate_redundancy failed: ${(error as Error).message}` }],
      };
    }
  }
);

server.registerTool(
  "set_policy_profile",
  {
    description: "Set active policy profile for the current MCP server process/session.",
    inputSchema: z.object({
      name: z.string().min(1),
    }),
  },
  async ({ name }) => {
    try {
      const policy = getEffectivePolicy(name);
      activeProfile = policy.name;
      const output = {
        active_profile: activeProfile,
        policy,
      };

      return {
        structuredContent: output,
        content: [{ type: "text", text: JSON.stringify(output) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `set_policy_profile failed: ${(error as Error).message}` }],
      };
    }
  }
);

server.registerTool(
  "reindex",
  {
    description:
      "Run full/incremental reindex for selected paths. Uses parser + atomic file upsert; intended for controlled refresh jobs.",
    inputSchema: z.object({
      mode: z.enum(["full", "incremental"]).default("incremental"),
      paths: z.array(z.string()).optional(),
      max_files: z.number().int().min(1).max(200000).default(20000),
    }),
  },
  async ({ mode, paths, max_files }) => {
    try {
      purgeBlockedIndexedRows();
      const roots = (paths && paths.length > 0 ? paths : DEFAULT_ALLOWLIST).map((p) => path.resolve(p));
      const files: string[] = [];
      for (const root of roots) {
        if (files.length >= max_files) break;
        const remaining = max_files - files.length;
        files.push(...walkFiles(root, remaining));
      }

      let seen = 0;
      let written = 0;
      const started = new Date().toISOString();

      for (const filePath of files) {
        seen += 1;
        const payload = await extractFilePayload(filePath, { allowlistRoots: roots, aiPass });
        if (!payload) continue;
        const out = upsertFilePayloadAtomic(db, payload);
        written += out.chunksWritten;
      }

      const output = {
        mode,
        roots,
        files_seen: seen,
        chunks_written: written,
        started_at: started,
        finished_at: new Date().toISOString(),
      };

      return {
        structuredContent: output,
        content: [{ type: "text", text: JSON.stringify(output) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `reindex failed: ${(error as Error).message}` }],
      };
    }
  }
);

server.registerTool(
  "rank_capability",
  {
    description: "Rank a capability chunk's impressiveness and assign fragment tags (e.g., 'not_opened_in_a_while') for the fragmentation tracking system.",
    inputSchema: z.object({
      chunk_key: z.string().min(1),
      impressiveness_rank: z.number().int().min(0).max(10),
      tags: z.array(z.string()).optional(),
    }),
  },
  async ({ chunk_key, impressiveness_rank, tags }) => {
    try {
      const fragmentTags = tags ? JSON.stringify(tags) : '[]';
      const result = db.prepare(
        `UPDATE chunks
         SET impressiveness_rank = ?,
             fragment_tags = ?,
             last_touched_at = datetime('now')
         WHERE chunk_key = ?`
      ).run(impressiveness_rank, fragmentTags, chunk_key);

      if (result.changes === 0) {
        throw new Error("chunk_key not found");
      }

      const output = {
        chunk_key,
        impressiveness_rank,
        fragment_tags: tags ?? [],
        updated: true,
      };

      return {
        structuredContent: output,
        content: [{ type: "text", text: JSON.stringify(output) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `rank_capability failed: ${(error as Error).message}` }],
      };
    }
  }
);

server.registerTool(
  "get_fragments",
  {
    description: "Retrieve highly-ranked, fragmented scaffolds that haven't been touched recently, ordered by impressiveness.",
    inputSchema: z.object({
      min_rank: z.number().int().min(0).default(1),
      limit: z.number().int().min(1).max(50).default(10),
    }),
  },
  async ({ min_rank, limit }) => {
    try {
      const rows = db.prepare(
        `SELECT c.chunk_key, c.symbol_name, f.path AS file_path, c.chunk_kind, c.impressiveness_rank, c.fragment_tags, c.last_touched_at
         FROM chunks c
         JOIN files f ON f.id = c.file_id
         WHERE c.impressiveness_rank >= ?
         ORDER BY c.impressiveness_rank DESC, c.last_touched_at ASC
         LIMIT ?`
      ).all(min_rank, limit) as Array<{
        chunk_key: string;
        symbol_name: string | null;
        file_path: string;
        chunk_kind: string;
        impressiveness_rank: number;
        fragment_tags: string;
        last_touched_at: string | null;
      }>;

      const results = rows.map(r => ({
        ...r,
        fragment_tags: safeJsonArray(r.fragment_tags),
      }));

      const output = {
        result_count: results.length,
        results,
      };

      return {
        structuredContent: output,
        content: [{ type: "text", text: JSON.stringify(output) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `get_fragments failed: ${(error as Error).message}` }],
      };
    }
  }
);

const FIND_STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "does", "exist", "existing", "already",
  "have", "has", "any", "are", "how", "what", "where", "there", "use", "using", "our", "all",
]);

function findTerms(query: string): string[] {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 3 && !FIND_STOPWORDS.has(t));
  return Array.from(new Set(terms)).slice(0, 8);
}

server.registerTool(
  "find_existing",
  {
    description:
      "Lexical 'does this already exist?' search — no embeddings or Ollama needed. Matches query terms against symbol names and summaries (FTS5) and file paths, and reports index coverage/freshness per root so a miss is never mistaken for absence. Use BEFORE proposing any new build.",
    inputSchema: z.object({
      query: z.string().min(1),
      roots: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(50).default(15),
    }),
  },
  async ({ query, roots, limit }) => {
    try {
      const terms = findTerms(query);
      if (terms.length === 0) {
        throw new Error("query has no searchable terms (need words of 3+ chars)");
      }

      const rootPrefixes = (roots ?? []).map((r) => path.resolve(r));
      const rootSql = rootPrefixes.length > 0 ? `AND (${rootPrefixes.map(() => "f.path LIKE ?").join(" OR ")})` : "";
      const rootParams = rootPrefixes.map((r) => `${r}/%`);

      const symbolHits = db
        .prepare(
          `SELECT c.chunk_key, c.symbol_name, f.path AS file_path, c.chunk_kind, c.start_line, c.end_line,
                  c.capability_summary, bm25(chunks_fts) AS score
           FROM chunks_fts
           JOIN chunks c ON c.id = chunks_fts.rowid
           JOIN files f ON f.id = c.file_id
           WHERE chunks_fts MATCH ?
           ${rootSql}
           ORDER BY score
           LIMIT ?`
        )
        .all(terms.map((t) => `"${t}"*`).join(" OR "), ...rootParams, limit);

      const pathScore = terms.map(() => "(CASE WHEN lower(f.path) LIKE ? THEN 1 ELSE 0 END)").join(" + ");
      const pathHits = db
        .prepare(
          `SELECT f.path AS file_path, f.repo_root, f.indexed_at, (${pathScore}) AS terms_matched
           FROM files f
           WHERE (${pathScore}) > 0
           ${rootSql}
           ORDER BY terms_matched DESC, length(f.path) ASC
           LIMIT ?`
        )
        .all(...terms.map((t) => `%${t}%`), ...terms.map((t) => `%${t}%`), ...rootParams, limit);

      const coverage =
        rootPrefixes.length > 0
          ? rootPrefixes.map((r) => {
              const row = db
                .prepare("SELECT count(*) AS files, max(indexed_at) AS last_indexed FROM files WHERE path LIKE ?")
                .get(`${r}/%`) as { files: number; last_indexed: string | null };
              return { root: r, files: row.files, last_indexed: row.last_indexed, indexed: row.files > 0 };
            })
          : db
              .prepare(
                "SELECT repo_root AS root, count(*) AS files, max(indexed_at) AS last_indexed FROM files GROUP BY repo_root ORDER BY files DESC"
              )
              .all();

      const unindexed = rootPrefixes.filter((_, i) => !(coverage[i] as { indexed: boolean }).indexed);

      const output = {
        query,
        terms,
        symbol_hits: symbolHits,
        path_hits: pathHits,
        coverage,
        unindexed_roots: unindexed,
        note:
          "A miss is NOT proof of absence. The index only covers the roots listed in coverage, as of last_indexed. Confirm with ripgrep on the live tree (including plugin/extension dirs) before reporting that something does not exist.",
      };

      return {
        structuredContent: output,
        content: [{ type: "text", text: JSON.stringify(output) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `find_existing failed: ${(error as Error).message}` }],
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("[cartographer-mcp] fatal", error);
  process.exit(1);
});

process.on("SIGINT", () => {
  try {
    db.close();
  } finally {
    process.exit(0);
  }
});

process.on("SIGTERM", () => {
  try {
    db.close();
  } finally {
    process.exit(0);
  }
});
