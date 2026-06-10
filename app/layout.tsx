export const metadata = {
  title: "UiPath Orchestrator MCP Server",
  description: "MCP server exposing UiPath Orchestrator to nuwacom agents.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
