import { NextResponse } from "next/server";
import { Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { addresses, decodeTable, DEVNET_EU_VALIDATOR } from "@landed/sdk";

export const dynamic = "force-dynamic";

export async function GET() {
  const l1 = new Connection(process.env.LANDED_L1_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
  const er = new Connection(process.env.NEXT_PUBLIC_ER_URL ?? "https://devnet-eu.magicblock.app", "confirmed");
  const a = addresses(DEVNET_EU_VALIDATOR);
  const safe = async <T,>(f: () => Promise<T>) => { try { return await f(); } catch { return null; } };
  const [rpc, erv, esc, fp, tab, keeper] = await Promise.all([
    safe(() => l1.getSlot()),
    safe(() => er.getVersion()),
    safe(() => l1.getBalance(a.escrow)),
    safe(() => er.getBalance(a.escrowAuth)),
    safe(() => er.getAccountInfo(a.table)),
    process.env.KEEPER_URL ? safe(() => fetch(`${process.env.KEEPER_URL}/health`, { cache: "no-store" }).then((r) => r.json())) : Promise.resolve(null),
  ]);
  const t = tab ? decodeTable(new Uint8Array(tab.data)) : null;
  return NextResponse.json({
    rpc: rpc !== null ? { ok: true, slot: rpc } : { ok: false },
    er: erv ? { ok: true, version: erv } : { ok: false },
    keeper: keeper ?? { configured: !!process.env.KEEPER_URL },
    actionEscrowSol: esc !== null ? esc / LAMPORTS_PER_SOL : null,
    feePayerErSol: fp !== null ? fp / LAMPORTS_PER_SOL : null,
    lastCrankTs: t ? Number(t.lastCrankTs) : null,
    table: t ? { roundId: t.roundId.toString(), status: t.status } : null,
  });
}
