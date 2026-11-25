import type { NextConfig } from "next";

const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com" + (process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""),
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https://i.ytimg.com",
      "font-src 'self' data:",
      "connect-src 'self' https://*.magicblock.app wss://*.magicblock.app https://api.devnet.solana.com wss://api.devnet.solana.com",
      "frame-src https://www.youtube-nocookie.com https://www.loom.com https://challenges.cloudflare.com",
      "media-src 'self' https:",
      "worker-src 'self' blob:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  },
];

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@landed/sdk", "@landed/verifier"],
  poweredByHeader: false,
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
  webpack: (cfg) => {
    cfg.resolve.fallback = { ...(cfg.resolve.fallback ?? {}), fs: false, path: false, os: false, crypto: false };
    return cfg;
  },
};
export default config;
