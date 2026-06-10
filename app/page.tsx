export default function Home() {
  return (
    <main
      style={{
        fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
        maxWidth: 640,
        margin: "80px auto",
        padding: "0 24px",
        lineHeight: 1.6,
        color: "#11151c",
      }}
    >
      <h1 style={{ marginBottom: 4 }}>UiPath Orchestrator MCP Server</h1>
      <p style={{ color: "#64748b", marginTop: 0 }}>
        Model Context Protocol server for nuwacom agents.
      </p>
      <p>
        MCP endpoint: <code style={{ background: "#f4f6f8", padding: "2px 6px", borderRadius: 4 }}>/api/mcp</code>
        <br />
        Health check: <code style={{ background: "#f4f6f8", padding: "2px 6px", borderRadius: 4 }}>/healthz</code>
      </p>
      <p style={{ color: "#64748b", fontSize: 14 }}>
        Register the <code>/api/mcp</code> URL as a custom MCP server in nuwacom. This page is
        intentionally minimal; there is no UI.
      </p>
    </main>
  );
}
