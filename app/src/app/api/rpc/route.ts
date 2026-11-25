import { NextResponse } from "next/server";
import { z } from "zod";
import { clientIp, hit } from "@/lib/server/ratelimit";

/** L1 JSON-RPC proxy: the keyed RPC URL stays server-side. Method allowlist + size + rate limits. */
const UPSTREAM = process.env.LANDED_L1_RPC_URL ?? "https://api.devnet.solana.com";
const ALLOW = new Set([
  "getAccountInfo", "getMultipleAccounts", "getProgramAccounts", "getBalance", "getLatestBlockhash", "getSignaturesForAddress",
  "getTransaction", "getSignatureStatuses", "sendTransaction", "simulateTransaction", "getSlot", "getBlockHeight",
  "getMinimumBalanceForRentExemption", "getTokenAccountBalance", "getHealth", "getVersion", "getEpochInfo", "isBlockhashValid", "getFeeForMessage",
]);
const Call = z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number(), z.null()]), method: z.string().max(64), params: z.array(z.unknown()).max(8).optional() });
const Body = z.union([Call, z.array(Call).max(10)]);

export async function POST(req: Request) {
  const raw = await req.text();
  if (raw.length > 64 * 1024) return NextResponse.json({ error: "payload too large" }, { status: 413 });
  const ip = clientIp(req.headers);
  const rl = await hit(`rpc:${ip}`, 600, 60);
  if (!rl.ok) return NextResponse.json({ error: "rate limited" }, { status: 429 });
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(JSON.parse(raw));
  } catch {
    return NextResponse.json({ error: "invalid JSON-RPC" }, { status: 400 });
  }
  const calls = Array.isArray(body) ? body : [body];
  const bad = calls.find((c) => !ALLOW.has(c.method));
  if (bad) return NextResponse.json({ jsonrpc: "2.0", id: bad.id, error: { code: -32601, message: `method ${bad.method} not allowed` } }, { status: 403 });
  const r = await fetch(UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body: raw, cache: "no-store" });
  return new NextResponse(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
}
