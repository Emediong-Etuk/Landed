import { NextResponse } from "next/server";
import { z } from "zod";
import bs58 from "bs58";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { clientIp, hit } from "@/lib/server/ratelimit";

/**
 * Gas top-up for guest burners: a fixed 0.02 devnet SOL, ONLY to the requesting
 * pubkey, only if its balance is < 0.01 SOL. 1 per pubkey/24 h, 3 per IP/24 h,
 * plus a global daily SOL budget (circuit breaker). Optional Cloudflare Turnstile.
 * The faucet key lives only in server env and is never logged.
 */
const AMOUNT = 0.02 * LAMPORTS_PER_SOL;
const DAILY_BUDGET_SOL = Number(process.env.LANDED_TOPUP_DAILY_SOL ?? "5");
const Body = z.object({ pubkey: z.string().min(32).max(44), turnstileToken: z.string().max(4096).optional() });

function faucetKey(): Keypair | null {
  const s = process.env.LANDED_FAUCET_SECRET;
  if (!s) return null;
  try {
    return s.trim().startsWith("[") ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(s))) : Keypair.fromSecretKey(bs58.decode(s.trim()));
  } catch {
    return null;
  }
}

async function turnstileOk(token: string | undefined, ip: string) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return true; // not configured (local dev)
  if (!token) return false;
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST", body: new URLSearchParams({ secret, response: token, remoteip: ip }),
  });
  return ((await r.json()) as { success?: boolean }).success === true;
}

export async function POST(req: Request) {
  const ip = clientIp(req.headers);
  let body: z.infer<typeof Body>;
  try { body = Body.parse(await req.json()); } catch { return NextResponse.json({ error: "invalid request" }, { status: 400 }); }
  let to: PublicKey;
  try { to = new PublicKey(body.pubkey); } catch { return NextResponse.json({ error: "invalid pubkey" }, { status: 400 }); }
  if (!(await turnstileOk(body.turnstileToken, ip))) return NextResponse.json({ error: "human check failed" }, { status: 403 });
  const kp = faucetKey();
  if (!kp) return NextResponse.json({ error: "gas top-ups are not configured on this deployment" }, { status: 503 });
  const conn = new Connection(process.env.LANDED_L1_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
  const bal = await conn.getBalance(to);
  if (bal >= 0.01 * LAMPORTS_PER_SOL) return NextResponse.json({ ok: true, skipped: "balance already sufficient" }, { status: 409 });
  const [pk, ipc, budget] = await Promise.all([
    hit(`topup:pk:${to.toBase58()}`, 1, 86_400),
    hit(`topup:ip:${ip}`, 3, 86_400),
    hit(`topup:day:${new Date().toISOString().slice(0, 10)}`, Math.floor(DAILY_BUDGET_SOL / 0.02), 86_400),
  ]);
  if (!pk.ok) return NextResponse.json({ error: "this wallet already got gas today" }, { status: 429 });
  if (!ipc.ok) return NextResponse.json({ error: "too many guest wallets from this network today" }, { status: 429 });
  if (!budget.ok) return NextResponse.json({ error: "today's gas budget is used up — connect a wallet instead" }, { status: 429 });
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: to, lamports: AMOUNT }));
  const sig = await conn.sendTransaction(tx, [kp]);
  return NextResponse.json({ ok: true, sig, lamports: AMOUNT });
}
