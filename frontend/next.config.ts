import type { NextConfig } from "next";

/** The Cuota agent (Hono). Reached from the browser through /agent/*, so x402 headers stay same-origin. */
const AGENT = process.env.CUOTA_AGENT_URL ?? "http://localhost:8787";

// A production deploy without the agent's URL would 404 on every /agent call: fail the build instead.
if (process.env.VERCEL_ENV === "production" && !process.env.CUOTA_AGENT_URL) {
  throw new Error("CUOTA_AGENT_URL is not set. Deploy the agent (agent/Dockerfile) and set CUOTA_AGENT_URL to its public URL.");
}

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async rewrites() {
    return [{ source: "/agent/:path*", destination: `${AGENT}/:path*` }];
  },
};

export default nextConfig;
