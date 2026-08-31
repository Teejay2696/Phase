/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@creit.tech/stellar-wallets-kit"],
  // Rust build trees are committed in this repo; exclude from serverless traces (250 MB limit on Vercel).
  outputFileTracingExcludes: {
    "*": ["./contracts/**/*", "./scripts/**/*"],
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  async headers() {
    return [
      // Security headers — applied to every route
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options",             value: "SAMEORIGIN" },
          { key: "X-Content-Type-Options",       value: "nosniff" },
          { key: "Strict-Transport-Security",    value: "max-age=63072000; includeSubDomains; preload" },
          { key: "Cross-Origin-Opener-Policy",   value: "same-origin-allow-popups" },
          { key: "Referrer-Policy",              value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy",           value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      {
        source: "/.well-known/stellar.toml",
        headers: [
          { key: "Access-Control-Allow-Origin",  value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET, OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "Content-Type" },
        ],
      },
      {
        source: "/phaser-liq-token.png",
        headers: [
          { key: "Access-Control-Allow-Origin",  value: "*" },
          { key: "Cross-Origin-Resource-Policy", value: "cross-origin" },
          { key: "Cache-Control",                value: "public, max-age=86400, immutable" },
        ],
      },
    ]
  },
}

export default nextConfig;
