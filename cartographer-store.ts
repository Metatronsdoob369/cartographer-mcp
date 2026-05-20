import Database from "better-sqlite3";
import { getChunkRole } from "./cartographer-chunk-policy.js";
import { type ExtractedFilePayload } from "./cartographer-types.js";

function toEmbeddingBlob(embedding: Float32Array): Buffer {
  const copy = new Float32Array(embedding);
  return Buffer.from(copy.buffer);
}

function supportsNullableCapabilitySummary(db: Database.Database): boolean {
  const rows = db.prepare("PRAGMA table_info(chunks)").all() as Array<{ name: string; notnull: number }>;
  const col = rows.find((r) => r.name === "capability_summary");
  return !col || col.notnull === 0;
}

export function deleteFileAtomic(db: Database.Database, filePath: string): void {
  const tx = db.transaction((targetPath: string) => {
    db.prepare("DELETE FROM files WHERE path = ?").run(targetPath);
  });
  tx(filePath);
}

export function upsertFilePayloadAtomic(db: Database.Database, payload: ExtractedFilePayload): { chunksWritten: number } {
  const summaryNullable = supportsNullableCapabilitySummary(db);
  const vecCols = db.prepare("PRAGMA table_info(chunk_vec)").all() as Array<{ name: string }>;
  const hasChunkIdCol = vecCols.some((c) => c.name === "chunk_id");

  const deleteFileStmt = db.prepare("DELETE FROM files WHERE path = ?");
  const insertFileStmt = db.prepare(`
    INSERT INTO files (path, repo_root, trust_tier, language, size_bytes, content_hash, mtime_ms, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const insertChunkStmt = db.prepare(`
    INSERT INTO chunks (
      file_id, chunk_key, symbol_name, chunk_kind,
      start_line, end_line, code, content_hash, chunk_bytes,
      capability_summary, capability_per_byte,
      internal_workspace_import_count, external_runtime_dependency_count,
      chunk_role, ai_pass_required,
      execution_tags, tests_passed, last_test_pass_at,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, datetime('now'), datetime('now'))
  `);

  const insertDepStmt = db.prepare(`
    INSERT INTO deps (chunk_id, import_raw, dep_kind, normalized_target, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `);

  const insertVecStmt = hasChunkIdCol
    ? db.prepare("INSERT INTO chunk_vec(chunk_id, embedding) VALUES (?, ?)")
    : db.prepare("INSERT INTO chunk_vec(rowid, embedding) VALUES (?, ?)");
  const insertFtsStmt = db.prepare(
    "INSERT INTO chunks_fts(rowid, chunk_key, capability_summary, symbol_name) VALUES (?, ?, ?, ?)"
  );

  const tx = db.transaction((data: ExtractedFilePayload) => {
    deleteFileStmt.run(data.path);

    const fileInsert = insertFileStmt.run(
      data.path,
      data.repo_root,
      data.trust_tier,
      data.language,
      data.size_bytes,
      data.content_hash,
      data.mtime_ms
    );
    const fileId = Number(fileInsert.lastInsertRowid);

    for (const chunk of data.chunks) {
      const capabilityPerByte = chunk.chunk_bytes > 0 ? 1 / chunk.chunk_bytes : 0;
      const role = getChunkRole(chunk.chunk_kind);
      const aiPassRequired = role === "capability" ? 1 : 0;
      const storedSummary = summaryNullable ? chunk.capability_summary : (chunk.capability_summary ?? "");

      const chunkInsert = insertChunkStmt.run(
        fileId,
        chunk.chunk_key,
        chunk.symbol_name,
        chunk.chunk_kind,
        chunk.start_line,
        chunk.end_line,
        chunk.code,
        chunk.content_hash,
        chunk.chunk_bytes,
        storedSummary,
        capabilityPerByte,
        chunk.internal_workspace_import_count,
        chunk.external_runtime_dependency_count,
        role,
        aiPassRequired,
        JSON.stringify([])
      );

      const chunkId = Number(chunkInsert.lastInsertRowid);

      for (const dep of chunk.dependencies) {
        insertDepStmt.run(chunkId, dep.import_raw, dep.dep_kind, dep.normalized_target);
      }

      if (chunk.embedding) {
        insertVecStmt.run(BigInt(chunkId), toEmbeddingBlob(chunk.embedding));
      }

      if (chunk.capability_summary) {
        insertFtsStmt.run(chunkId, chunk.chunk_key, chunk.capability_summary, chunk.symbol_name);
      }
    }

    return { chunksWritten: data.chunks.length };
  });

  return tx(payload);
}
