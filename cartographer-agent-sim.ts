import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function textResult(res: any): string {
  const text = res?.content?.find?.((c: any) => c?.type === "text")?.text;
  return typeof text === "string" ? text : "{}";
}

async function main() {
  const client = new Client({ name: "cartographer-sim", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "/Users/joewales/cartographer-mcp.ts"],
    cwd: "/Users/joewales",
    env: {
      ...process.env,
      CARTO_DB_PATH: "/Users/joewales/.cartographer/cartographer.sqlite",
      CARTO_ALLOWLIST_PATHS:
        "/Users/joewales/NODE_OUT_Master,/Users/joewales/MiroFish,/Users/joewales/smb-claw,/Users/joewales/polybot,/Users/joewales/property-hydra,/Users/joewales/sarn-landing",
    } as Record<string, string>,
    stderr: "pipe",
  });

  if (transport.stderr) {
    transport.stderr.on("data", (buf) => {
      const s = String(buf).trim();
      if (s) console.error("[mcp-stderr]", s);
    });
  }

  await client.connect(transport);

  const tools = await client.listTools();

  const setProfile = await client.callTool({
    name: "set_policy_profile",
    arguments: { name: "payload-strict" },
  });

  const search = await client.callTool({
    name: "search_capability",
    arguments: {
      intent: "in-memory execution loop that pulls configuration data",
      profile: "payload-strict",
      limit: 5,
      k: 30,
    },
  });

  const searchJson = JSON.parse(textResult(search));
  const first = searchJson?.results?.[0] ?? null;

  let depsJson: any = null;
  if (first?.chunk_key) {
    const deps = await client.callTool({
      name: "map_dependencies",
      arguments: { chunk_key: first.chunk_key },
    });
    depsJson = JSON.parse(textResult(deps));
  }

  const redundancy = await client.callTool({
    name: "evaluate_redundancy",
    arguments: {
      chunk_kind: "function",
      symbol_name: "loadConfigLoop",
      source_code:
        "export async function loadConfigLoop(fetcher){ while(true){ const cfg = await fetcher(); if(cfg?.enabled) return cfg; } }",
      profile: "payload-strict",
      threshold: 0.15,
      k: 5,
    },
  });

  const redundancyJson = JSON.parse(textResult(redundancy));

  console.log(
    JSON.stringify(
      {
        tools: tools.tools.map((t) => t.name),
        set_profile: JSON.parse(textResult(setProfile)),
        search_summary: {
          result_count: searchJson?.result_count ?? 0,
          tie_break_applied: searchJson?.tie_break_applied ?? false,
          top_result: first,
        },
        top_dependencies: depsJson,
        redundancy: {
          abort_rewrite: redundancyJson?.abort_rewrite ?? false,
          recommendation: redundancyJson?.recommendation ?? null,
          best_match: redundancyJson?.best_match ?? null,
        },
      },
      null,
      2
    )
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
