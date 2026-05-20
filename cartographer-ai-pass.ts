import { createHash } from "node:crypto";
import { type CapabilityAIPass, type ChunkKind } from "./cartographer-types.js";

type AIPassConfig = {
  summaryEndpoint: string;
  summaryModel: string;
  summaryApiKey?: string;
  summaryTimeoutMs: number;
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
      { role: "user", content: `Analyze this ${input.chunkKind}:\n\n${input.code}` },
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
    throw new Error(`summary endpoint returned ${response.status}`);
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
    embeddingEndpoint:
      userConfig?.embeddingEndpoint ?? process.env.CARTO_EMBED_ENDPOINT ?? "http://127.0.0.1:11434/api/embed",
    embeddingModel: userConfig?.embeddingModel ?? process.env.CARTO_EMBED_MODEL ?? "nomic-embed-text",
    embeddingTimeoutMs: userConfig?.embeddingTimeoutMs ?? Number(process.env.CARTO_EMBED_TIMEOUT_MS ?? 8000),
    fallbackEmbeddingDim: userConfig?.fallbackEmbeddingDim ?? Number(process.env.CARTO_FALLBACK_EMBED_DIM ?? 768),
    circuitCooldownMs: userConfig?.circuitCooldownMs ?? Number(process.env.CARTO_AI_CIRCUIT_COOLDOWN_MS ?? 30000),
  };

  let summaryCircuitOpenUntil = 0;
  let embedCircuitOpenUntil = 0;

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

      try {
        const summary = await callSummaryEndpoint(config, {
          chunkKind: input.chunkKind,
          code: input.code,
        });
        return summary || fallbackSummary(input.chunkKind, input.symbolName);
      } catch {
        summaryCircuitOpenUntil = Date.now() + config.circuitCooldownMs;
        return fallbackSummary(input.chunkKind, input.symbolName);
      }
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
