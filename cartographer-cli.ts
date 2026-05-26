#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { initCartographerDb } from "./cartographer-db-init.js";
import { createCapabilityAIPass } from "./cartographer-ai-pass.js";
import { extractFilePayload } from "./cartographer-parser.js";
import { upsertFilePayloadAtomic } from "./cartographer-store.js";

const DEFAULT_DB_PATH = process.env.CARTO_DB_PATH ?? "/Users/joewales/.cartographer/cartographer.sqlite";
const DEFAULT_ALLOWLIST = (process.env.CARTO_ALLOWLIST_PATHS ??
  "/Users/joewales/NODE_OUT_Master,/Users/joewales/MiroFish,/Users/joewales/smb-claw,/Users/joewales/polybot,/Users/joewales/property-hydra,/Users/joewales/sarn-landing")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go"]);

function parseFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function gatherFlagValues(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && args[i + 1]) {
      out.push(args[i + 1]);
      i += 1;
    }
  }
  return out;
}

function walkFiles(root: string, maxFiles: number): string[] {
  const out: string[] = [];
  const stack = [path.resolve(root)];

  const ignoreDir = (d: string) => {
    const n = d.replaceAll("\\", "/").toLowerCase();
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
        if (!ignoreDir(full)) stack.push(full);
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

function isLikelyTextChunk(code: string): boolean {
  if (!code || code.length === 0) return false;
  const sample = code.slice(0, 1000);
  if (sample.length === 0) return false;
  if (sample.includes("\u0000")) return false;

  let nonPrintable = 0;
  for (const ch of sample) {
    const cp = ch.charCodeAt(0);
    const isControl = cp < 32 && ch !== "\n" && ch !== "\r" && ch !== "\t";
    const replacementChar = cp === 65533;
    if (isControl || replacementChar) nonPrintable += 1;
  }

  return nonPrintable / sample.length < 0.05;
}

async function runBackfill(args: string[]) {
  // Targets only fallback chunks in DB — no file walk, no reindex churn.
  const dbPath = parseFlag(args, "--db") ?? DEFAULT_DB_PATH;
  const CONCURRENCY = Number(process.env.CARTO_CONCURRENCY ?? 20);
  const db = initCartographerDb({ dbPath, embeddingDim: Number(process.env.CARTO_FALLBACK_EMBED_DIM ?? 768) });
  const workerCount = Math.max(1, CONCURRENCY);
  const aiPassPool = Array.from({ length: workerCount }, () => createCapabilityAIPass());
  type SummarizeChunkKind = Parameters<ReturnType<typeof createCapabilityAIPass>["summarize"]>[0]["chunkKind"];

  type FallbackRow = { id: number; chunk_key: string; symbol_name: string | null; chunk_kind: string; code: string };
  const allFallbacks = db.prepare(`
    SELECT c.id, c.chunk_key, c.symbol_name, c.chunk_kind, c.code
    FROM chunks c
    WHERE c.capability_summary LIKE 'Fallback%'
       OR c.capability_summary LIKE 'script anonymous%'
       OR c.capability_summary = 'unknown'
       OR c.capability_summary = ''
  `).all() as FallbackRow[];

  // Skip binary/non-text chunks before summary calls.
  const fallbacks = allFallbacks.filter((c) => isLikelyTextChunk(c.code));
  process.stderr.write(`[backfill] filtered ${allFallbacks.length - fallbacks.length} binary chunks\n`);

  const total = fallbacks.length;
  process.stderr.write(`[backfill] ${total} fallback chunks to process (concurrency=${CONCURRENCY})\n`);

  if (total === 0) {
    db.close();
    console.log(JSON.stringify({ command: "backfill", upgraded: 0, finished_at: new Date().toISOString() }, null, 2));
    return;
  }

  let upgraded = 0;
  const started = new Date().toISOString();
  const updateStmt = db.prepare(`UPDATE chunks SET capability_summary = ? WHERE id = ?`);

  for (let i = 0; i < fallbacks.length; i += CONCURRENCY) {
    const batch = fallbacks.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((chunk, idx) =>
        aiPassPool[idx % workerCount].summarize({
          filePath: chunk.chunk_key,
          symbolName: chunk.symbol_name,
          chunkKind: chunk.chunk_kind as SummarizeChunkKind,
          code: chunk.code,
        }).then(summary => ({ id: chunk.id, summary }))
      )
    );
    for (const { id, summary } of results) {
      if (!summary || summary.startsWith("Fallback") || summary.includes("script anonymous")) continue;
      updateStmt.run(summary, id);
      upgraded++;
    }
    if ((i / CONCURRENCY) % 10 === 0) {
      process.stderr.write(`[backfill] ${i + batch.length}/${total} | ${upgraded} upgraded\n`);
    }
  }

  db.close();
  process.stderr.write(`[backfill] done — ${upgraded}/${total} upgraded\n`);
  console.log(JSON.stringify({ command: "backfill", upgraded, total, started_at: started, finished_at: new Date().toISOString() }, null, 2));
}

async function runIndex(args: string[]) {
  const dbPath = parseFlag(args, "--db") ?? DEFAULT_DB_PATH;
  const pathFlags = gatherFlagValues(args, "--path");
  const roots = (pathFlags.length > 0 ? pathFlags : DEFAULT_ALLOWLIST).map((p) => path.resolve(p));
  const maxFiles = Number.parseInt(parseFlag(args, "--max-files") ?? "200000", 10);
  const useAI = hasFlag(args, "--ai");
  const CONCURRENCY = Number(process.env.CARTO_CONCURRENCY ?? 20);

  const db = initCartographerDb({ dbPath, embeddingDim: Number(process.env.CARTO_FALLBACK_EMBED_DIM ?? 768) });
  const aiPass = useAI ? createCapabilityAIPass() : undefined;
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

  const files: string[] = [];
  for (const root of roots) {
    if (files.length >= maxFiles) break;
    files.push(...walkFiles(root, maxFiles - files.length));
  }

  process.stderr.write(`[index] ${files.length} files to process (concurrency=${CONCURRENCY})\n`);

  let chunksWritten = 0;
  let filesSeen = 0;
  const started = new Date().toISOString();

  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const batch = files.slice(i, i + CONCURRENCY);
    const payloads = await Promise.all(
      batch.map(file => extractFilePayload(file, { allowlistRoots: roots, aiPass }))
    );
    for (const payload of payloads) {
      filesSeen += 1;
      if (!payload) continue;
      const out = upsertFilePayloadAtomic(db, payload);
      chunksWritten += out.chunksWritten;
    }
  }

  db.close();

  console.log(
    JSON.stringify(
      {
        command: "index",
        roots,
        files_seen: filesSeen,
        chunks_written: chunksWritten,
        ai_enabled: useAI,
        started_at: started,
        finished_at: new Date().toISOString(),
      },
      null,
      2
    )
  );
}

async function runPromote(args: string[]) {
  const target = args[0];
  if (!target) {
    throw new Error("promote requires <file-or-dir>");
  }

  const isMove = hasFlag(args, "--move");
  const to = parseFlag(args, "--to") ?? "Published";
  if (to !== "Published" && to !== "Capsules") {
    throw new Error("--to must be Published or Capsules");
  }

  const root = path.resolve(parseFlag(args, "--root") ?? "/Users/joewales/NODE_OUT_Master");
  const destDir = path.join(root, to);
  fs.mkdirSync(destDir, { recursive: true });

  const absTarget = path.resolve(target);
  if (!fs.existsSync(absTarget)) {
    throw new Error(`target not found: ${absTarget}`);
  }

  const finalPath = path.join(destDir, path.basename(absTarget));
  if (isMove) {
    fs.renameSync(absTarget, finalPath);
  } else {
    fs.copyFileSync(absTarget, finalPath);
  }

  console.log(
    JSON.stringify(
      {
        command: "promote",
        operation: isMove ? "move" : "copy",
        from: absTarget,
        to: finalPath,
      },
      null,
      2
    )
  );
}

function runStats(args: string[]) {
  const dbPath = parseFlag(args, "--db") ?? DEFAULT_DB_PATH;
  const db = new Database(dbPath);

  const trust = db.prepare("SELECT trust_tier, COUNT(*) AS files FROM files GROUP BY trust_tier ORDER BY files DESC").all();
  const strictEligible = db
    .prepare(
      `SELECT COUNT(*) AS strict_eligible
       FROM chunks c
       JOIN files f ON f.id = c.file_id
       WHERE c.chunk_role='capability'
         AND f.trust_tier IN ('published','capsule')
         AND c.chunk_bytes <= 4096
         AND c.external_runtime_dependency_count = 0
         AND lower(f.path) NOT LIKE '%/venv/%'
         AND lower(f.path) NOT LIKE '%/.venv/%'
         AND lower(f.path) NOT LIKE '%/site-packages/%'
         AND lower(f.path) NOT LIKE '%/node_modules/%'`
    )
    .get() as { strict_eligible: number };

  const noise = db
    .prepare(
      `SELECT
        SUM(CASE WHEN lower(path) LIKE '%/venv/%' THEN 1 ELSE 0 END) AS venv_files,
        SUM(CASE WHEN lower(path) LIKE '%/site-packages/%' THEN 1 ELSE 0 END) AS site_packages_files,
        SUM(CASE WHEN lower(path) LIKE '%/node_modules/%' THEN 1 ELSE 0 END) AS node_modules_files
       FROM files`
    )
    .get();

  db.close();

  console.log(
    JSON.stringify(
      {
        command: "stats",
        trust_tiers: trust,
        strict_eligible: strictEligible.strict_eligible,
        contamination: noise,
      },
      null,
      2
    )
  );
}

async function main() {
  const [, , cmd, ...rest] = process.argv;

  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(`Usage:\n  cartographer-cli.ts index [--full|--incremental] [--path <root>]... [--max-files N] [--ai] [--db <path>]\n  cartographer-cli.ts backfill [--db <path>]   # upgrade fallback summaries without re-indexing\n  cartographer-cli.ts promote <file-or-dir> --to Published|Capsules [--root <repo-root>] [--move]\n  cartographer-cli.ts stats [--db <path>]`);
    return;
  }

  if (cmd === "index") {
    await runIndex(rest);
    return;
  }

  if (cmd === "backfill") {
    await runBackfill(rest);
    return;
  }

  if (cmd === "promote") {
    await runPromote(rest);
    return;
  }

  if (cmd === "stats") {
    runStats(rest);
    return;
  }

  throw new Error(`unknown command: ${cmd}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
