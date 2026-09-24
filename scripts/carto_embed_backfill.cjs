// Embed-only backfill: capability chunks missing from chunk_vec -> nomic-embed-text via Ollama.
// Resumable (skips rows already in chunk_vec). Only INSERTs into chunk_vec; never touches chunks/summaries.
const path = require("path");
const REPO_ROOT = path.resolve(__dirname, "..");

let Database, sqliteVec;
try {
  Database = require("better-sqlite3");
  sqliteVec = require("sqlite-vec");
} catch {
  Database = require(path.join(REPO_ROOT, "node_modules", "better-sqlite3"));
  sqliteVec = require(path.join(REPO_ROOT, "node_modules", "sqlite-vec"));
}

const DB = process.env.CARTO_DB || `${process.env.HOME}/.cartographer/cartographer.sqlite`;
const OLLAMA = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const MODEL = process.env.CARTO_EMBED_MODEL || "nomic-embed-text";
const BATCH = Number(process.env.BATCH || 64);
const LIMIT = Number(process.env.LIMIT || 0); // 0 = all
const DIM = 768;

const db = new Database(DB);
db.pragma("busy_timeout = 30000");
sqliteVec.load(db);

const todo = db.prepare(`
  SELECT c.id, c.symbol_name, c.chunk_kind, f.path, substr(c.code, 1, 1200) AS code
  FROM chunks c JOIN files f ON f.id = c.file_id
  WHERE c.chunk_role = 'capability'
    AND c.id NOT IN (SELECT rowid FROM chunk_vec)
    AND lower(f.path) NOT LIKE '%/node_modules/%'
    AND lower(f.path) NOT LIKE '%/dist/%'
    AND lower(f.path) NOT LIKE '%/build/%'
  ORDER BY c.impressiveness_rank DESC, c.id
  ${LIMIT ? "LIMIT " + LIMIT : ""}
`).all().filter((r) => !/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|bin|mp[34]|wav|so|dylib|o|a|pyc)$/i.test(r.path)
  && !/[\u0000-\u0008\u000e-\u001f]/.test(r.code) && !r.code.includes("\ufffd"));

const ins = db.prepare("INSERT OR IGNORE INTO chunk_vec(rowid, embedding) VALUES (?, ?)");
const writeBatch = db.transaction((rows, vecs) => {
  rows.forEach((r, i) => ins.run(BigInt(r.id), Buffer.from(new Float32Array(vecs[i]).buffer)));
});

const rel = (p) => p.replace(/^\/Users\/[^/]+\//, "~/");
const text = (r) => `${r.chunk_kind} ${r.symbol_name || ""} in ${rel(r.path)}\n${r.code}`;

async function embed(inputs, attempt = 1) {
  try {
    const res = await fetch(`${OLLAMA}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, input: inputs, truncate: true }),
      signal: AbortSignal.timeout(600000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
    const j = await res.json();
    if (!Array.isArray(j.embeddings) || j.embeddings.length !== inputs.length) throw new Error("bad embeddings shape");
    if (j.embeddings[0].length !== DIM) throw new Error(`dim ${j.embeddings[0].length} != ${DIM}`);
    return j.embeddings;
  } catch (e) {
    if (attempt >= 5) throw e;
    const wait = 2000 * 2 ** attempt;
    console.log(`[retry ${attempt}] ${e.message} — waiting ${wait / 1000}s`);
    await new Promise((r) => setTimeout(r, wait));
    return embed(inputs, attempt + 1);
  }
}

(async () => {
  const total = todo.length;
  console.log(`[start] ${new Date().toISOString()} todo=${total} batch=${BATCH} model=${MODEL}`);
  const t0 = Date.now();
  let done = 0, failed = 0;
  for (let i = 0; i < total; i += BATCH) {
    const rows = todo.slice(i, i + BATCH);
    try {
      const vecs = await embed(rows.map(text));
      writeBatch(rows, vecs);
      done += rows.length;
    } catch (e) {
      failed += rows.length;
    }
    if ((i / BATCH) % 10 === 0 || i + BATCH >= total) {
      const s = (Date.now() - t0) / 1000, rate = done / s;
      const eta = rate > 0 ? ((total - done - failed) / rate / 3600).toFixed(2) : "?";
      console.log(`[progress] ${done}/${total} failed=${failed} ${rate.toFixed(2)}/s eta=${eta}h`);
    }
  }
  const n = db.prepare("SELECT count(*) AS n FROM chunk_vec").get().n;
  console.log(`[done] ${new Date().toISOString()} embedded=${done} failed=${failed} chunk_vec_rows=${n} elapsed=${((Date.now() - t0) / 3600000).toFixed(2)}h`);
  db.close();
})().catch((e) => { console.log(`[fatal] ${e.stack}`); process.exit(1); });
