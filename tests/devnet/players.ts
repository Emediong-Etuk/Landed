import { Keypair } from "@solana/web3.js";
import { LandedClient, ONE_DUSDC } from "@landed/sdk";
import { fund, wallet } from "./lib";

/** A funded, onboarded player (L1 user + faucet + deposit + delegated ledger + ingested). */
export async function player(c: LandedClient, admin: Keypair, label: string, depositD = 50, sol = 0.03) {
  const kp = wallet(label);
  await fund(c, admin, kp.publicKey, sol);
  const led = await c.ledger(kp.publicKey, "ER");
  if (!led || led.available < BigInt(depositD) * ONE_DUSDC / 2n) {
    const meta = await c.userMeta(kp.publicKey);
    const wal = await c.walletBalance(kp.publicKey);
    if (!meta || wal >= BigInt(depositD) * ONE_DUSDC) await c.onboard(kp, BigInt(depositD) * ONE_DUSDC);
    else await c.ingestAll(kp.publicKey, kp);
  }
  return kp;
}
