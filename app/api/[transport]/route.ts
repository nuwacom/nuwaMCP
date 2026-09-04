// app/api/[transport]/route.ts
// The MCP server endpoint for Vercel, built with mcp-handler.
// This single route replaces the standalone Express server. It serves the
// Streamable HTTP (and SSE) MCP transport at /api/mcp and /api/sse.
//
// nuwacom connects to:  https://<your-deployment>.vercel.app/api/mcp
//
// Auth: if MCP_AUTH_TOKEN is set, every request must present
//   Authorization: Bearer <MCP_AUTH_TOKEN>
// (Strongly recommended — this endpoint can start/stop your UiPath automations.)

import { createMcpHandler } from "mcp-handler";
import { tools } from "@/lib/tools";
import { orchestrator } from "@/lib/orchestrator";

export const dynamic = "force-dynamic";

const handler = createMcpHandler(
  (server) => {
    for (const tool of tools) {
      server.tool(
        tool.name,
        tool.description,
        tool.inputSchema,
        async (args: any) => {
          try {
            const result = await tool.handler(args ?? {});
            return {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            };
          } catch (err: any) {
            return {
              isError: true,
              content: [{ type: "text", text: `Error in ${tool.name}: ${err?.message ?? String(err)}` }],
            };
          }
        }
      );
    }
  },
  {
    // server capabilities/instructions
    capabilities: {
      tools: Object.fromEntries(tools.map((t) => [t.name, { description: t.description }])),
    },
    instructions:
      "Tools to operate UiPath Orchestrator: discover folders/processes/queues, " +
      "start and stop jobs, check job status, and add queue items. When the user names a " +
      "process or queue, pass that name directly — it is resolved to the right id automatically. " +
      "If a folder Id is required and unknown, call list_folders first.",
  },
  {
    // mcp-handler options
    basePath: "/api",
    maxDuration: 60,
    verboseLogs: true,
  }
);

// ---- bearer-token gate ----
function authorized(req: Request): boolean {
  const token = (process.env.MCP_AUTH_TOKEN || "").trim();
  if (!token) return true; // auth disabled (testing only)
  const header = req.headers.get("authorization") || "";
  const presented = header.replace(/^Bearer\s+/i, "").trim();
  return presented.length > 0 && presented === token;
}

function unauthorized(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: missing or invalid bearer token." },
      id: null,
    }),
    { status: 401, headers: { "Content-Type": "application/json" } }
  );
}

async function guarded(req: Request): Promise<Response> {
  if (!authorized(req)) return unauthorized();
  return handler(req);
}

export { guarded as GET, guarded as POST, guarded as DELETE };

// (orchestrator imported to surface config errors at module load if misconfigured)
void orchestrator;
