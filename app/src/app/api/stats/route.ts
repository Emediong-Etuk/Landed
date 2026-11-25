import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import bs58 from "bs58";
import { Connection, PublicKey } from "@solana/web3.js";
import { DISC, LANDED_PROGRAM_ID, OWED_ALERT_SECS, SLOT_STATE, decodeLedger, decodeTable, decodeUserMeta, decodeWithdrawReceipt, pda } from "@landed/sdk";

/** Cached aggregate for the hero. The verifier NEVER uses this endpoint. */
export const dynamic = "force-dynamic";
let cache: { at: number; body: unknown } | null = null;

export async function GET() {
  if (cache && Date.now() - cache.at < 15_000) return NextResponse.json(cache.body);
  const l1 = new Connection(process.env.LANDED_L1_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
  const er = new Connection(process.env.NEXT_PUBLIC_ER_URL ?? "https://devnet-eu.magicblock.app", "confirmed");
  let erP50Ms: number | null = null;
  try {
    const ev = JSON.parse(await readFile(join(process.cwd(), "public/evidence.json"), "utf8"));
    erP50Ms = ev.metrics?.find((m: { id: string; p50?: number }) => m.id === "M6")?.p50 ?? null;
  } catch { /* no evidence yet */ }
  try {
    const cfg = await l1.getAccountInfo(pda.config());
    if (!cfg) {
      const body = { deployed: false, roundsSettled: null, totalPaidD: null, owedOver60s: null, crankPct: null, erP50Ms, receipts: null, rescues: null, asOf: new Date().toISOString(), note: "Not deployed to devnet yet — the deployer is waiting for devnet SOL." };
      cache = { at: Date.now(), body };
      return NextResponse.json(body);
    }
    const [tableAcc, wdr, users] = await Promise.all([
      er.getAccountInfo(pda.table(1)),
      l1.getProgramAccounts(LANDED_PROGRAM_ID, { filters: [{ memcmp: { offset: 0, bytes: bs58.encode(DISC.WithdrawReceipt) } }] }),
      l1.getProgramAccounts(LANDED_PROGRAM_ID, { filters: [{ memcmp: { offset: 0, bytes: bs58.encode(DISC.UserMeta) } }] }),
    ]);
    const t = tableAcc ? decodeTable(new Uint8Array(tableAcc.data)) : null;
    const receipts = wdr.map((a) => decodeWithdrawReceipt(new Uint8Array(a.account.data)));
    const paid = new Set(receipts.map((r) => `${r.owner.toBase58()}:${r.nonce}`));
    const owners = users.map((u) => decodeUserMeta(new Uint8Array(u.account.data)).owner);
    let owed = 0;
    for (let i = 0; i < owners.length; i += 99) {
      const chunk = owners.slice(i, i + 99);
      const accs = await er.getMultipleAccountsInfo(chunk.map((o: PublicKey) => pda.ledger(o)));
      accs.forEach((a, j) => {
        if (!a) return;
        try {
          for (const s of decodeLedger(new Uint8Array(a.data)).ring)
            if (s.state === SLOT_STATE.PENDING && !paid.has(`${chunk[j].toBase58()}:${s.nonce}`) && Date.now() / 1000 - Number(s.requestedTs) > OWED_ALERT_SECS) owed++;
        } catch { /* */ }
      });
    }
    const closes = t ? Number(t.closesByCrank + t.closesByKeeper) : 0;
    const body = {
      deployed: true,
      roundsSettled: t ? Number(t.roundsSettled) : null,
      totalPaidD: receipts.reduce((s, r) => s + Number(r.amount), 0) / 1e6,
      owedOver60s: owed,
      crankPct: closes ? (Number(t!.closesByCrank) / closes) * 100 : null,
      erP50Ms,
      receipts: receipts.length,
      rescues: receipts.filter((r) => r.path === 1).length,
      asOf: new Date().toISOString(),
    };
    cache = { at: Date.now(), body };
    return NextResponse.json(body);
  } catch (e) {
    return NextResponse.json({ deployed: false, asOf: new Date().toISOString(), note: `chain read failed: ${(e as Error).message.slice(0, 100)}` }, { status: 200 });
  }
}
