// app/healthz/route.ts
// Lightweight health/info endpoint. Handy for uptime checks and confirming config.
// GET /healthz

import { tools } from "@/lib/tools";
import { orchestrator } from "@/lib/orchestrator";

export const dynamic = "force-dynamic";

export async function GET() {
  let configOk = true;
  let configError: string | null = null;
  let cfg: any = null;
  try {
    cfg = orchestrator.config;
  } catch (e: any) {
    configOk = false;
    configError = e?.message ?? String(e);
  }

  return new Response(
    JSON.stringify({
      ok: true,
      server: "uipath-orchestrator",
      version: "1.0.0",
      transport: "streamable-http (mcp-handler)",
      endpoint: "/api/mcp",
      authEnabled: Boolean((process.env.MCP_AUTH_TOKEN || "").trim()),
      configOk,
      configError,
      deployment: cfg?.deployment ?? null,
      tools: tools.map((t) => t.name),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
