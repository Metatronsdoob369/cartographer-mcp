import { createHash } from "node:crypto";
import { type CapabilityAIPass, type ChunkKind } from "./cartographer-types.js";

type AIPassConfig = {
  summaryEndpoint: string;
  summaryModel: string;
  summaryApiKey?: string;
  summaryTimeoutMs: number;
  summaryMaxInputChars: number;
  summaryMaxRetries: number;
  summaryBackoffMs: number;
  summaryFailureThreshold: number;
  embeddingEndpoint: string;
  embeddingModel: string;
  embeddingTimeoutMs: number;
  fallbackEmbeddingDim: number;
  circuitCooldownMs: number;
};

const SYSTEM_PROMPT =
  "You are an automated AST metadata extractor. Your sole function is to describe the mechanical capability of the provided code block in 20 words or less. Return ONLY the raw string. Do not use quotes, markdown, prefixes, or explanations. If you output conversational text, the system will crash.";

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const timeout = new Promise<never>((_, reject) => {
    const id = setTimeout(() => {
      clearTimeout(id);
      reject(new Error(`timeout after ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, timeout]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(raw: string | null): number | null {
  if (!raw) return null;

  const asInt = Number.parseInt(raw, 10);
  if (Number.isFinite(asInt) && asInt > 0) {
    return asInt * 1000;
  }

  const at = Date.parse(raw);
  if (Number.isFinite(at)) {
    const delta = at - Date.now();
    return delta > 0 ? delta : null;
  }

  return null;
}

function jitteredBackoffMs(baseMs: number, attempt: number): number {
  const exp = baseMs * Math.pow(2, attempt);
  const jitter = Math.floor(Math.random() * Math.max(100, Math.floor(baseMs / 2)));
  return Math.min(exp + jitter, 30_000);
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

type SummaryEndpointError = Error & {
  status?: number;
  retryAfterMs?: number | null;
  headers?: Record<string, string>;
};

function collectRateLimitHeaders(response: Response): Record<string, string> {
  const keys = [
    "retry-after",
    "x-ratelimit-remaining-requests",
    "x-ratelimit-remaining-tokens",
    "x-ratelimit-reset",
    "x-ratelimit-reset-requests",
    "x-ratelimit-reset-tokens",
  ];

  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = response.headers.get(k);
    if (v) out[k] = v;
  }

  for (const [k, v] of response.headers.entries()) {
    const lower = k.toLowerCase();
    if ((lower.startsWith("x-xai-") || lower.includes("ratelimit")) && !(lower in out)) {
      out[lower] = v;
    }
  }

  return out;
}

function normalizeSummary(raw: string): string {
  const cleaned = raw
    .replace(/^['"`]+|['"`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const words = cleaned.split(" ").filter(Boolean);
  return words.slice(0, 20).join(" ");
}

function fallbackSummary(chunkKind: ChunkKind, symbolName: string | null): string {
  const raw = `Fallback: ${chunkKind} ${symbolName ?? "anonymous"} parsing network failure`;
  return normalizeSummary(raw);
}

function deterministicFallbackVector(seed: string, dim: number): Float32Array {
  const out = new Float32Array(dim);
  let offset = 0;
  let counter = 0;

  while (offset < dim) {
    const digest = createHash("sha256").update(`${seed}:${counter}`).digest();
    for (let i = 0; i < digest.length && offset < dim; i += 2) {
      const hi = digest[i] ?? 0;
      const lo = digest[i + 1] ?? 0;
      const val = ((hi << 8) | lo) / 65535;
      out[offset] = val * 2 - 1;
      offset += 1;
    }
    counter += 1;
  }

  return out;
}

function parseSummaryFromResponse(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;

  const asObj = json as Record<string, unknown>;

  const choices = asObj.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as Record<string, unknown>;
    const msg = first.message as Record<string, unknown> | undefined;
    const content = msg?.content;
    if (typeof content === "string") return content;
  }

  const outputText = asObj.output_text;
  if (typeof outputText === "string") return outputText;

  return null;
}

function parseEmbeddingFromResponse(json: unknown): Float32Array | null {
  if (!json || typeof json !== "object") return null;
  const obj = json as Record<string, unknown>;

  const embedding = obj.embedding;
  if (Array.isArray(embedding)) {
    return new Float32Array(embedding.map((n) => Number(n)));
  }

  const embeddings = obj.embeddings;
  if (Array.isArray(embeddings) && embeddings.length > 0 && Array.isArray(embeddings[0])) {
    return new Float32Array((embeddings[0] as unknown[]).map((n) => Number(n)));
  }

  const data = obj.data;
  if (Array.isArray(data) && data.length > 0) {
    const first = data[0] as Record<string, unknown>;
    if (Array.isArray(first.embedding)) {
      return new Float32Array(first.embedding.map((n) => Number(n)));
    }
  }

  return null;
}

async function callSummaryEndpoint(config: AIPassConfig, input: {
  chunkKind: ChunkKind;
  code: string;
}): Promise<string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (config.summaryApiKey) {
    headers.authorization = `Bearer ${config.summaryApiKey}`;
  }

  const body = {
    model: config.summaryModel,
    temperature: 0,
    max_tokens: 80,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Analyze this ${input.chunkKind}:\n\n${input.code.slice(0, config.summaryMaxInputChars)}` },
    ],
  };

  const response = await withTimeout(
    fetch(config.summaryEndpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    config.summaryTimeoutMs
  );

  if (!response.ok) {
    const err: SummaryEndpointError = new Error(`summary endpoint returned ${response.status}`);
    err.status = response.status;
    err.retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
    err.headers = collectRateLimitHeaders(response);
    throw err;
  }

  const json = (await response.json()) as unknown;
  const summary = parseSummaryFromResponse(json);
  if (!summary) {
    throw new Error("summary response missing content");
  }

  return normalizeSummary(summary);
}

async function callEmbeddingEndpoint(config: AIPassConfig, summary: string): Promise<Float32Array> {
  const baseHeaders = {
    "content-type": "application/json",
  };

  const attemptEmbed = async (url: string, body: unknown) => {
    const res = await withTimeout(
      fetch(url, {
        method: "POST",
        headers: baseHeaders,
        body: JSON.stringify(body),
      }),
      config.embeddingTimeoutMs
    );

    if (!res.ok) {
      throw new Error(`embedding endpoint returned ${res.status}`);
    }

    const json = (await res.json()) as unknown;
    const parsed = parseEmbeddingFromResponse(json);
    if (!parsed) {
      throw new Error("embedding response missing vector");
    }
    return parsed;
  };

  try {
    return await attemptEmbed(config.embeddingEndpoint, {
      model: config.embeddingModel,
      input: summary,
    });
  } catch {
    const fallbackUrl = config.embeddingEndpoint.endsWith("/api/embed")
      ? config.embeddingEndpoint.replace(/\/api\/embed$/, "/api/embeddings")
      : `${config.embeddingEndpoint.replace(/\/$/, "")}/api/embeddings`;

    return await attemptEmbed(fallbackUrl, {
      model: config.embeddingModel,
      prompt: summary,
    });
  }
}

export function createCapabilityAIPass(userConfig?: Partial<AIPassConfig>): CapabilityAIPass {
  const config: AIPassConfig = {
    summaryEndpoint:
      userConfig?.summaryEndpoint ?? process.env.CARTO_SUMMARY_ENDPOINT ?? "http://127.0.0.1:3000/v1/chat/completions",
    summaryModel: userConfig?.summaryModel ?? process.env.CARTO_SUMMARY_MODEL ?? "grok-4-fast",
    summaryApiKey: userConfig?.summaryApiKey ?? process.env.CARTO_SUMMARY_API_KEY ?? process.env.XAI_API_KEY,
    summaryTimeoutMs: userConfig?.summaryTimeoutMs ?? Number(process.env.CARTO_SUMMARY_TIMEOUT_MS ?? 12000),
    summaryMaxInputChars: userConfig?.summaryMaxInputChars ?? Number(process.env.CARTO_SUMMARY_MAX_INPUT_CHARS ?? 2048),
    summaryMaxRetries: userConfig?.summaryMaxRetries ?? Number(process.env.CARTO_SUMMARY_MAX_RETRIES ?? 2),
    summaryBackoffMs: userConfig?.summaryBackoffMs ?? Number(process.env.CARTO_SUMMARY_BACKOFF_MS ?? 500),
    summaryFailureThreshold: userConfig?.summaryFailureThreshold ?? Number(process.env.CARTO_SUMMARY_FAILURE_THRESHOLD ?? 3),
    embeddingEndpoint:
      userConfig?.embeddingEndpoint ?? process.env.CARTO_EMBED_ENDPOINT ?? "http://127.0.0.1:11434/api/embed",
    embeddingModel: userConfig?.embeddingModel ?? process.env.CARTO_EMBED_MODEL ?? "nomic-embed-text",
    embeddingTimeoutMs: userConfig?.embeddingTimeoutMs ?? Number(process.env.CARTO_EMBED_TIMEOUT_MS ?? 8000),
    fallbackEmbeddingDim: userConfig?.fallbackEmbeddingDim ?? Number(process.env.CARTO_FALLBACK_EMBED_DIM ?? 768),
    circuitCooldownMs: userConfig?.circuitCooldownMs ?? Number(process.env.CARTO_AI_CIRCUIT_COOLDOWN_MS ?? 30000),
  };

  let summaryCircuitOpenUntil = 0;
  let embedCircuitOpenUntil = 0;
  let consecutiveSummaryFailures = 0;

  return {
    async summarize(input: {
      filePath: string;
      symbolName: string | null;
      chunkKind: ChunkKind;
      code: string;
    }) {
      const now = Date.now();
      if (now < summaryCircuitOpenUntil) {
        return fallbackSummary(input.chunkKind, input.symbolName);
      }

      for (let attempt = 0; attempt <= config.summaryMaxRetries; attempt++) {
        try {
          const summary = await callSummaryEndpoint(config, {
            chunkKind: input.chunkKind,
            code: input.code,
          });
          consecutiveSummaryFailures = 0;
          return summary || fallbackSummary(input.chunkKind, input.symbolName);
        } catch (rawErr) {
          const err = rawErr as SummaryEndpointError;
          const status = err.status;
          const isChunkError = status === 400 || status === 422;
          const isRetryable = status === undefined || (typeof status === "number" && isRetryableStatus(status));

          if (isChunkError) {
            process.stderr.write(`[ai-pass] chunk rejected (${status}), skipping: ${input.filePath}\n`);
            return fallbackSummary(input.chunkKind, input.symbolName);
          }

          const canRetry = isRetryable && attempt < config.summaryMaxRetries;
          if (canRetry) {
            const waitMs = err.retryAfterMs ?? jitteredBackoffMs(config.summaryBackoffMs, attempt);
            const headerInfo = err.headers ? ` headers=${JSON.stringify(err.headers)}` : "";
            process.stderr.write(
              `[ai-pass] transient summary error${status ? ` (${status})` : ""}; retry ${attempt + 1}/${config.summaryMaxRetries} in ${waitMs}ms${headerInfo}\n`
            );
            await sleep(waitMs);
            continue;
          }

          consecutiveSummaryFailures += 1;
          if (consecutiveSummaryFailures >= config.summaryFailureThreshold) {
            summaryCircuitOpenUntil = Date.now() + config.circuitCooldownMs;
            process.stderr.write(`[ai-pass] systemic summary failures=${consecutiveSummaryFailures}; opening circuit for ${config.circuitCooldownMs}ms\n`);
          } else {
            process.stderr.write(`[ai-pass] systemic summary error (failure ${consecutiveSummaryFailures}/${config.summaryFailureThreshold}): ${err}\n`);
          }

          return fallbackSummary(input.chunkKind, input.symbolName);
        }
      }

      return fallbackSummary(input.chunkKind, input.symbolName);
    },

    async embed(summary: string) {
      const now = Date.now();
      if (now < embedCircuitOpenUntil) {
        return deterministicFallbackVector(summary, config.fallbackEmbeddingDim);
      }

      try {
        return await callEmbeddingEndpoint(config, summary);
      } catch {
        embedCircuitOpenUntil = Date.now() + config.circuitCooldownMs;
        return deterministicFallbackVector(summary, config.fallbackEmbeddingDim);
      }
    },
  };
}
