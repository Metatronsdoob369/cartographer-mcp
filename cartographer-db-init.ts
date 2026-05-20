import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";

type InitOptions = {
  dbPath: string;
  embeddingDim: number; // e.g. 768 for nomic-embed-text
};

export function initCartographerDb(opts: InitOptions): Database.Database {
  const abs = path.resolve(opts.dbPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });

  const db = new Database(abs);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("temp_store = MEMORY");

  // Load sqlite-vec extension
  loadSqliteVec(db);

  const tx = db.transaction(() => {
    const ensureColumn = (table: string, column: string, ddl: string) => {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
      }
    };

    db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        repo_root TEXT NOT NULL,
        trust_tier TEXT NOT NULL CHECK (trust_tier IN ('published','capsule','draft','unknown')),
        language TEXT,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT NOT NULL,
        mtime_ms INTEGER NOT NULL,
        indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        chunk_key TEXT NOT NULL UNIQUE,
        symbol_name TEXT,
        chunk_kind TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        code TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        chunk_bytes INTEGER NOT NULL,
        capability_summary TEXT,
        capability_per_byte REAL NOT NULL,
        internal_workspace_import_count INTEGER NOT NULL DEFAULT 0,
        external_runtime_dependency_count INTEGER NOT NULL DEFAULT 0,
        chunk_role TEXT NOT NULL DEFAULT 'capability' CHECK (chunk_role IN ('capability','context')),
        ai_pass_required INTEGER NOT NULL DEFAULT 1 CHECK (ai_pass_required IN (0,1)),
        execution_tags TEXT NOT NULL DEFAULT '[]',
        tests_passed INTEGER NOT NULL DEFAULT 0,
        last_test_pass_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_file_id ON chunks(file_id);
      CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(content_hash);
      CREATE INDEX IF NOT EXISTS idx_chunks_trust_gate ON chunks(
        external_runtime_dependency_count, chunk_bytes, tests_passed
      );

      CREATE TABLE IF NOT EXISTS deps (
        id INTEGER PRIMARY KEY,
        chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
        import_raw TEXT NOT NULL,
        dep_kind TEXT NOT NULL CHECK (dep_kind IN ('internal','external','builtin')),
        normalized_target TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_deps_chunk_id ON deps(chunk_id);

      CREATE TABLE IF NOT EXISTS tests (
        id INTEGER PRIMARY KEY,
        chunk_id INTEGER REFERENCES chunks(id) ON DELETE SET NULL,
        source TEXT NOT NULL,
        suite_name TEXT,
        test_name TEXT,
        status TEXT NOT NULL CHECK (status IN ('passed','failed','skipped')),
        run_id TEXT NOT NULL,
        observed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tests_chunk_id ON tests(chunk_id);
      CREATE INDEX IF NOT EXISTS idx_tests_run_id ON tests(run_id);

      CREATE TABLE IF NOT EXISTS policies (
        name TEXT PRIMARY KEY,
        trust_allowlist TEXT NOT NULL,
        max_chunk_bytes INTEGER,
        require_external_deps_zero INTEGER NOT NULL DEFAULT 0,
        require_tests_for_tags TEXT NOT NULL DEFAULT '[]',
        include_drafts INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS index_runs (
        id INTEGER PRIMARY KEY,
        mode TEXT NOT NULL CHECK (mode IN ('full','incremental')),
        status TEXT NOT NULL CHECK (status IN ('started','completed','failed')),
        started_at TEXT NOT NULL,
        finished_at TEXT,
        files_seen INTEGER NOT NULL DEFAULT 0,
        chunks_written INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS watch_events (
        id INTEGER PRIMARY KEY,
        event_type TEXT NOT NULL,
        path TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        handled INTEGER NOT NULL DEFAULT 0
      );
    `);

    // Backward-compatible schema migration for pre-role DBs.
    ensureColumn("chunks", "chunk_role", "chunk_role TEXT NOT NULL DEFAULT 'capability' CHECK (chunk_role IN ('capability','context'))");
    ensureColumn("chunks", "ai_pass_required", "ai_pass_required INTEGER NOT NULL DEFAULT 1 CHECK (ai_pass_required IN (0,1))");
    db.exec("CREATE INDEX IF NOT EXISTS idx_chunks_role_ai ON chunks(chunk_role, ai_pass_required)");

    // Shape-only nodes are context, not capability chunks for AI pass.
    db.exec(`
      UPDATE chunks
      SET chunk_role = 'context', ai_pass_required = 0
      WHERE lower(chunk_kind) IN ('interface', 'typed_dict', 'dataclass');
    `);

    // FTS over summaries for deterministic lexical fallback/debug.
    // Writes must bind rowid = chunks.id for deterministic cleanup.
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        chunk_key UNINDEXED,
        capability_summary,
        symbol_name,
        tokenize = 'unicode61'
      );
    `);

    // sqlite-vec embedding table.
    // Writes must bind rowid = chunks.id.
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vec USING vec0(
        embedding FLOAT[${opts.embeddingDim}]
      );
    `);

    // Enforce deterministic cleanup across virtual tables.
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_chunks_ad AFTER DELETE ON chunks
      BEGIN
        DELETE FROM chunk_vec WHERE rowid = old.id;
        DELETE FROM chunks_fts WHERE rowid = old.id;
      END;
    `);

    // Seed default profiles.
    const upsertPolicy = db.prepare(`
      INSERT INTO policies (
        name, trust_allowlist, max_chunk_bytes,
        require_external_deps_zero, require_tests_for_tags, include_drafts, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(name) DO UPDATE SET
        trust_allowlist=excluded.trust_allowlist,
        max_chunk_bytes=excluded.max_chunk_bytes,
        require_external_deps_zero=excluded.require_external_deps_zero,
        require_tests_for_tags=excluded.require_tests_for_tags,
        include_drafts=excluded.include_drafts,
        updated_at=datetime('now')
    `);

    upsertPolicy.run("payload-strict", JSON.stringify(["published", "capsule"]), 4096, 1, JSON.stringify(["network", "execution"]), 0);
    upsertPolicy.run("scaffolding", JSON.stringify(["published", "capsule", "draft", "unknown"]), 32768, 0, JSON.stringify([]), 1);
    upsertPolicy.run("research", JSON.stringify(["published", "capsule", "draft", "unknown"]), null, 0, JSON.stringify([]), 1);
  });

  tx();
  return db;
}

export function prepareChunkWriteStatements(db: Database.Database): {
  insertVec: Database.Statement;
  insertFts: Database.Statement;
} {
  const insertVec = db.prepare("INSERT INTO chunk_vec(rowid, embedding) VALUES (?, ?)");
  const insertFts = db.prepare(
    "INSERT INTO chunks_fts(rowid, chunk_key, capability_summary, symbol_name) VALUES (?, ?, ?, ?)"
  );
  return { insertVec, insertFts };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dbPath = process.argv[2] ?? "/Users/joewales/.cartographer/cartographer.sqlite";
  const embeddingDimArg = process.argv[3] ?? "768";
  const embeddingDim = Number.parseInt(embeddingDimArg, 10);

  if (!Number.isFinite(embeddingDim) || embeddingDim <= 0) {
    throw new Error(`Invalid embedding dimension: ${embeddingDimArg}`);
  }

  const db = initCartographerDb({ dbPath, embeddingDim });
  db.close();
  console.log(`Cartographer DB initialized at ${path.resolve(dbPath)} with embedding dim ${embeddingDim}`);
}
