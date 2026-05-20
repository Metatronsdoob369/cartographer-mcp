import fs from "node:fs";
import path from "node:path";
import chokidar from "chokidar";
import pLimit from "p-limit";
import { initCartographerDb } from "./cartographer-db-init.js";
import { createCapabilityAIPass } from "./cartographer-ai-pass.js";
import { extractFilePayload } from "./cartographer-parser.js";
import { deleteFileAtomic, upsertFilePayloadAtomic } from "./cartographer-store.js";
import { type CapabilityAIPass } from "./cartographer-types.js";

type WatcherOptions = {
  dbPath: string;
  embeddingDim: number;
  allowlistRoots: string[];
  debounceMs?: number;
  concurrency?: number;
  aiPass?: CapabilityAIPass;
};

const WATCH_IGNORE = [
  "**/node_modules/**",
  "**/venv/**",
  "**/.venv/**",
  "**/site-packages/**",
  "**/.git/**",
  "**/.next/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/tests/**",
  "**/__tests__/**",
  "**/*.test.*",
  "**/*.spec.*",
  "**/.pm2/**",
  "**/__pycache__/**",
  "**/*.sock",
  "**/*.min.*",
  "**/*.map",
];

export function startCartographerWatcher(options: WatcherOptions) {
  const db = initCartographerDb({ dbPath: options.dbPath, embeddingDim: options.embeddingDim });
  const aiPass: CapabilityAIPass = options.aiPass ?? createCapabilityAIPass({ fallbackEmbeddingDim: options.embeddingDim });
  const debounceMs = options.debounceMs ?? 500;
  const limit = pLimit(options.concurrency ?? 1);
  const timers = new Map<string, NodeJS.Timeout>();

  const watcher = chokidar.watch(options.allowlistRoots.map((p) => path.resolve(p)), {
    ignored: WATCH_IGNORE,
    ignoreInitial: false,
    persistent: true,
    awaitWriteFinish: false,
  });

  const schedule = (filePath: string, eventType: "add" | "change" | "unlink") => {
    const abs = path.resolve(filePath);

    const prior = timers.get(abs);
    if (prior) {
      clearTimeout(prior);
    }

    const timeout = setTimeout(() => {
      timers.delete(abs);
      void limit(async () => {
        try {
          if (eventType === "unlink" || !fs.existsSync(abs)) {
            deleteFileAtomic(db, abs);
            return;
          }

          const payload = await extractFilePayload(abs, {
            allowlistRoots: options.allowlistRoots,
            aiPass,
          });

          if (!payload) {
            return;
          }

          upsertFilePayloadAtomic(db, payload);
        } catch (error) {
          console.error(`[cartographer-watcher] failed to process ${abs}:`, error);
        }
      });
    }, debounceMs);

    timers.set(abs, timeout);
  };

  watcher.on("add", (p) => schedule(p, "add"));
  watcher.on("change", (p) => schedule(p, "change"));
  watcher.on("unlink", (p) => schedule(p, "unlink"));
  watcher.on("error", (err) => {
    console.error("[cartographer-watcher] watcher error:", err);
  });

  const stop = async () => {
    for (const t of timers.values()) {
      clearTimeout(t);
    }
    timers.clear();
    await watcher.close();
    db.close();
  };

  return { watcher, stop };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dbPath = process.argv[2] ?? "/Users/joewales/.cartographer/cartographer.sqlite";
  const allowlistArg = process.argv[3] ?? "/Users/joewales/NODE_OUT_Master,/Users/joewales/MiroFish,/Users/joewales/smb-claw";
  const allowlistRoots = allowlistArg
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  const daemon = startCartographerWatcher({
    dbPath,
    embeddingDim: 768,
    allowlistRoots,
    debounceMs: 500,
    concurrency: 1,
  });

  console.log(`[cartographer-watcher] started for ${allowlistRoots.join(", ")}`);

  const shutdown = async () => {
    console.log("[cartographer-watcher] stopping...");
    await daemon.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
