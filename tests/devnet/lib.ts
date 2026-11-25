/** Shared helpers for devnet scripts, spikes and campaigns. Everything is recorded as evidence. */
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { LandedClient, type SendResult } from "@landed/sdk";
import { recordEvidence } from "@landed/sdk/evidence";

export const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
export const DEPLOYMENTS = resolve(ROOT, "deployments/devnet.json");

export function loadKeypair(path = process.env.LANDED_ADMIN_KEYPAIR ?? `${homedir()}/.config/solana/id.json`): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

/** Labeled test wallets are persisted (gitignored) so campaigns can be resumed. */
export function wallet(label: string): Keypair {
  const dir = resolve(ROOT, "keys");
  mkdirSync(dir, { recursive: true });
  const p = resolve(dir, `${label}.json`);
  if (existsSync(p)) return loadKeypair(p);
  const k = Keypair.generate();
  writeFileSync(p, JSON.stringify(Array.from(k.secretKey)));
  return k;
}

export function client(campaign: string) {
  return new LandedClient({
    l1Url: process.env.LANDED_L1_RPC,
    erUrl: process.env.LANDED_ER_RPC,
    onSend: (label: string, r: SendResult) =>
      recordEvidence({
        campaign, step: label, layer: r.layer, sig: r.sig || null, ok: r.ok, err: r.err ?? null, latency_ms: r.latencyMs, slot: r.slot,
        program: "37AZMxLPm9RY8AKQk4s4oMJaovpRorGQfUmMUbTxiqGq", ix: label,
      }),
  });
}

export async function fund(c: LandedClient, from: Keypair, to: PublicKey, sol: number) {
  const have = await c.l1.getBalance(to);
  const want = Math.round(sol * LAMPORTS_PER_SOL);
  if (have >= want) return null;
  return c.mustSend("L1", [SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports: want - have })], [from], "fund_wallet");
}

export function readDeployments(): Record<string, unknown> {
  return existsSync(DEPLOYMENTS) ? JSON.parse(readFileSync(DEPLOYMENTS, "utf8")) : {};
}
export function writeDeployments(patch: Record<string, unknown>) {
  mkdirSync(dirname(DEPLOYMENTS), { recursive: true });
  const cur = readDeployments();
  writeFileSync(DEPLOYMENTS, JSON.stringify({ ...cur, ...patch, updated_at: new Date().toISOString() }, null, 2) + "\n");
}

export const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
export const now = () => Date.now();
