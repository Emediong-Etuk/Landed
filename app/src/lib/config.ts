export const cfg = {
  erUrl: process.env.NEXT_PUBLIC_ER_URL ?? "https://devnet-eu.magicblock.app",
  erWsUrl: process.env.NEXT_PUBLIC_ER_WS_URL ?? "wss://devnet-eu.magicblock.app",
  /** L1 goes through our allowlisted proxy so the keyed RPC never reaches the browser. */
  l1Path: "/api/rpc",
  l1Fallback: process.env.NEXT_PUBLIC_L1_URL ?? "https://api.devnet.solana.com",
  pitchVideo: process.env.NEXT_PUBLIC_PITCH_VIDEO_URL ?? "",
  techVideo: process.env.NEXT_PUBLIC_TECH_VIDEO_URL ?? "",
  turnstileSiteKey: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "",
  repo: process.env.NEXT_PUBLIC_REPO_URL ?? "https://github.com/emediong-etuk/landed",
};

export const l1Url = () => (typeof window === "undefined" ? cfg.l1Fallback : `${window.location.origin}${cfg.l1Path}`);
