/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone", // container build, not Vercel
  // Served behind Front Door at mcp.nuwacom.ai/uipath/* alongside the DATEV
  // server at the same host's root — this is what makes /uipath/api/mcp work.
  basePath: "/uipath",
};

module.exports = nextConfig;
