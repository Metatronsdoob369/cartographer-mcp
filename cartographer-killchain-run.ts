import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const OPTION_B = [
  "/Users/joewales/NODE_OUT_Master",
  "/Users/joewales/MiroFish",
  "/Users/joewales/smb-claw",
  "/Users/joewales/polybot",
  "/Users/joewales/property-hydra",
  "/Users/joewales/sarn-landing",
];

function text(res: any) {
  return res?.content?.find?.((c: any) => c?.type === "text")?.text ?? "";
}

async function main() {
  const client = new Client({ name: "cartographer-killchain", version: "0.1.2" });
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "/Users/joewales/cartographer-mcp.ts"],
    cwd: "/Users/joewales",
    env: {
      ...process.env,
      CARTO_DB_PATH: "/Users/joewales/.cartographer/cartographer.sqlite",
      CARTO_ALLOWLIST_PATHS: OPTION_B.join(","),
      CARTO_SUMMARY_TIMEOUT_MS: "200",
      CARTO_EMBED_TIMEOUT_MS: "200",
      CARTO_AI_CIRCUIT_COOLDOWN_MS: "3600000",
      CARTO_TRUST_PUBLISHED_PREFIXES: "/Users/joewales/NODE_OUT_Master,/Users/joewales/property-hydra",
      CARTO_TRUST_CAPSULE_PREFIXES: "/Users/joewales/smb-claw,/Users/joewales/polybot",
    } as Record<string, string>,
  });

  await client.connect(transport);

  const out: Record<string, unknown> = {};

  out.set_policy_profile = await client.callTool(
    { name: "set_policy_profile", arguments: { name: "payload-strict" } },
    undefined,
    { timeout: 120000 }
  );

  out.search_capability = await client.callTool(
    {
      name: "search_capability",
      arguments: {
        intent: "metamorphic re-encryption loop with in-memory config pull",
        profile: "payload-strict",
        limit: 5,
        k: 30,
      },
    },
    undefined,
    { timeout: 120000 }
  );

  const parsed = JSON.parse(text(out.search_capability) || "{}");
  const top = parsed?.results?.[0];

  out.map_dependencies = top?.chunk_key
    ? await client.callTool(
        { name: "map_dependencies", arguments: { chunk_key: top.chunk_key } },
        undefined,
        { timeout: 120000 }
      )
    : { note: "no top result under payload-strict" };

  out.evaluate_redundancy = await client.callTool(
    {
      name: "evaluate_redundancy",
      arguments: {
        source_code:
          "export function reencryptLoop(buf,key){for(let i=0;i<buf.length;i++){buf[i]^=key[i%key.length]}return buf}",
        chunk_kind: "function",
        symbol_name: "reencryptLoop",
        profile: "payload-strict",
        threshold: 0.15,
        k: 5,
      },
    },
    undefined,
    { timeout: 120000 }
  );

  out.reindex = await client.callTool(
    {
      name: "reindex",
      arguments: {
        mode: "full",
        paths: OPTION_B,
        max_files: 250,
      },
    },
    undefined,
    { timeout: 3600000, maxTotalTimeout: 3600000 }
  );

  out.post_reindex_payload_strict_search = await client.callTool(
    {
      name: "search_capability",
      arguments: {
        intent: "in-memory execution loop that pulls configuration data",
        profile: "payload-strict",
        limit: 5,
        k: 30,
      },
    },
    undefined,
    { timeout: 120000 }
  );

  console.log(JSON.stringify(out, null, 2));
  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
