/**
 * Builds a Snapshot directly from chain data (L1 RPC + ER RPC). Works in Node
 * and in the browser. Never touches the Landed backend.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import {
  DELEGATION_PROGRAM_ID,
  DISC,
  LANDED_PROGRAM_ID,
  NAIVE_PROGRAM_ID,
  VRF_PROGRAM_ID,
  decodeConfig,
  decodeDepositReceipt,
  decodeLedger,
  decodeNLedger,
  decodeTable,
  decodeTokenAmount,
  decodeUserMeta,
  decodeWithdrawReceipt,
  eventsFromLogs,
  hex,
  naivePda,
  pda,
  type Ledger,
  type NLedger,
} from "@landed/sdk";
import type { RoundRecon, Snapshot } from "./checks";

export interface FetchOptions {
  l1Url: string;
  erUrl: string;
  tableId?: bigint;
  /** Max ER signatures to scan for round reconstruction. */
  maxSignatures?: number;
  includeNaive?: boolean;
  onProgress?: (msg: string) => void;
}

async function gpa(c: Connection, program: PublicKey, disc: Uint8Array) {
  return c.getProgramAccounts(program, { commitment: "confirmed", filters: [{ memcmp: { offset: 0, bytes: bs58.encode(disc) } }] });
}

async function multiple(c: Connection, keys: PublicKey[]) {
  const out: { key: PublicKey; data: Uint8Array | null }[] = [];
  let slot: number | null = null;
  for (let i = 0; i < keys.length; i += 99) {
    const chunk = keys.slice(i, i + 99);
    const r = await c.getMultipleAccountsInfoAndContext(chunk, "confirmed");
    slot = slot ?? r.context.slot;
    r.value.forEach((a, j) => out.push({ key: chunk[j], data: a ? new Uint8Array(a.data) : null }));
  }
  return { out, slot };
}

export async function fetchSnapshot(o: FetchOptions): Promise<Snapshot> {
  const log = o.onProgress ?? (() => {});
  const l1 = new Connection(o.l1Url, "confirmed");
  const er = new Connection(o.erUrl, "confirmed");
  const notes: string[] = [];
  const tablePk = pda.table(o.tableId ?? 1n);

  log("L1: config, vault, receipts, users");
  const cfgInfo = await l1.getAccountInfo(pda.config());
  if (!cfgInfo) throw new Error("Landed config not found on L1 — is the program initialized on this cluster?");
  const cfg = decodeConfig(new Uint8Array(cfgInfo.data));
  const vaultInfo = await l1.getAccountInfo(cfg.vault);
  const vaultAmount = vaultInfo ? decodeTokenAmount(new Uint8Array(vaultInfo.data)) : 0n;
  const [depAcc, wdrAcc, userAcc] = await Promise.all([
    gpa(l1, LANDED_PROGRAM_ID, DISC.DepositReceipt),
    gpa(l1, LANDED_PROGRAM_ID, DISC.WithdrawReceipt),
    gpa(l1, LANDED_PROGRAM_ID, DISC.UserMeta),
  ]);
  const deposits = depAcc.map((a) => decodeDepositReceipt(new Uint8Array(a.account.data)));
  const withdrawals = wdrAcc.map((a) => decodeWithdrawReceipt(new Uint8Array(a.account.data)));
  const owners = [...new Set([...userAcc.map((a) => decodeUserMeta(new Uint8Array(a.account.data)).owner.toBase58()), cfg.treasury.toBase58()])];

  log(`ER: one getMultipleAccounts snapshot of ${owners.length} ledgers + table`);
  const ledgerKeys = owners.map((o) => pda.ledger(new PublicKey(o)));
  const erSnap = await multiple(er, [tablePk, ...ledgerKeys]);
  const tableData = erSnap.out[0].data;
  const table = tableData ? decodeTable(tableData) : null;
  const ledgersEr = new Map<string, Ledger>();
  erSnap.out.slice(1).forEach((a, i) => { if (a.data) try { ledgersEr.set(owners[i], decodeLedger(a.data)); } catch { /* not yet cloned */ } });
  if (erSnap.out.length > 100) notes.push("ER snapshot spans multiple getMultipleAccounts calls (> 99 accounts)");

  log("L1: committed ledgers + table");
  const l1Snap = await multiple(l1, [tablePk, ...ledgerKeys]);
  const tableL1 = l1Snap.out[0].data ? decodeTable(l1Snap.out[0].data) : null;
  const ledgersL1 = new Map<string, Ledger>();
  l1Snap.out.slice(1).forEach((a, i) => { if (a.data) try { ledgersL1.set(owners[i], decodeLedger(a.data)); } catch { /* */ } });

  log("ER: reconstructing rounds from table transaction logs");
  const rounds = await reconstructRounds(er, tablePk, o.maxSignatures ?? 600, notes);

  let naive: Snapshot["naive"];
  if (o.includeNaive !== false) {
    try {
      const nv = await l1.getAccountInfo(naivePda.vault());
      if (nv) {
        let ledgers: NLedger[] = [];
        try {
          const erAcc = await gpa(er, NAIVE_PROGRAM_ID, DISC.NLedger);
          ledgers = erAcc.map((a) => decodeNLedger(new Uint8Array(a.account.data)));
        } catch {
          const dl = await gpa(l1, DELEGATION_PROGRAM_ID, DISC.NLedger);
          ledgers = dl.map((a) => decodeNLedger(new Uint8Array(a.account.data)));
          notes.push("naive ledgers read from committed L1 copies (ER getProgramAccounts unavailable)");
        }
        naive = { vaultAmount: decodeTokenAmount(new Uint8Array(nv.data)), ledgers };
      }
    } catch (e) {
      notes.push(`naive baseline not readable: ${(e as Error).message}`);
    }
  }

  return {
    label: `${o.l1Url} + ${o.erUrl}`,
    fetchedAtMs: Date.now(),
    houseFeeBps: cfg.houseFeeBps,
    vaultAmount,
    deposits,
    withdrawals,
    owners,
    ledgersEr,
    ledgersL1,
    erSnapshotSlot: erSnap.slot,
    table,
    tableL1,
    rounds,
    naive,
    notes,
  };
}

/** Replays Landed events from the table's ER transactions (newest `max`). */
export async function reconstructRounds(er: Connection, table: PublicKey, max: number, notes: string[]): Promise<RoundRecon[]> {
  const sigs: { signature: string }[] = [];
  let before: string | undefined;
  try {
    while (sigs.length < max) {
      const page = await er.getSignaturesForAddress(table, { before, limit: Math.min(1000, max - sigs.length) }, "confirmed");
      if (!page.length) break;
      sigs.push(...page);
      before = page[page.length - 1].signature;
      if (page.length < 1000) break;
    }
  } catch (e) {
    notes.push(`ER signature history unavailable (${(e as Error).message}); I6 limited to on-chain history fee checks`);
    return [];
  }
  const byRound = new Map<string, RoundRecon>();
  const get = (id: bigint) => {
    const k = id.toString();
    if (!byRound.has(k)) byRound.set(k, { roundId: id, entries: [], staleIgnored: 0, retries: 0 });
    return byRound.get(k)!;
  };
  // chronological
  const ordered = sigs.reverse();
  for (let i = 0; i < ordered.length; i += 25) {
    const batch = ordered.slice(i, i + 25);
    const txs = await Promise.all(batch.map((s) => er.getTransaction(s.signature, { maxSupportedTransactionVersion: 1, commitment: "confirmed" }).catch(() => null)));
    txs.forEach((tx, j) => {
      if (!tx || tx.meta?.err) return;
      const sig = batch[j].signature;
      const keys = tx.transaction.message.staticAccountKeys ?? (tx.transaction.message as unknown as { accountKeys: PublicKey[] }).accountKeys;
      const ix0 = tx.transaction.message.compiledInstructions?.[0];
      const viaVrf = !!ix0 && keys[ix0.programIdIndex]?.equals(VRF_PROGRAM_ID);
      for (const ev of eventsFromLogs(tx.meta?.logMessages)) {
        switch (ev.name) {
          case "Entered": {
            const r = get(ev.roundId);
            const p = ev.player.toBase58();
            const e = r.entries.find((x) => x.player === p);
            if (e) e.amount += ev.amount; else r.entries.push({ player: p, amount: ev.amount });
            break;
          }
          case "SoloLeft": get(ev.roundId).entries = []; break;
          case "RoundClosed": { const r = get(ev.roundId); r.closedEntriesHash = hex(ev.entriesHash); r.closedBy = ev.closedBy; break; }
          case "RoundDrawn": get(ev.roundId).drawn = { randomness: hex(ev.randomness), vrfNonce: ev.vrfNonce, winnerIdx: ev.winnerIdx, sig, viaVrfProgram: viaVrf }; break;
          case "RoundSettled": get(ev.roundId).settled = { winner: ev.winner.toBase58(), pot: ev.pot, fee: ev.fee, credit: ev.credit, sig }; break;
          case "RoundVoided": get(ev.roundId).voided = { refunded: ev.refunded, sig }; break;
          case "StaleCallbackIgnored": get(ev.roundId).staleIgnored++; break;
          case "VrfRetried": get(ev.roundId).retries++; break;
        }
      }
    });
  }
  // Rounds whose first entries fell outside the scanned window are incomplete: drop their entries.
  const rounds = [...byRound.values()].sort((a, b) => (a.roundId < b.roundId ? -1 : 1));
  if (rounds.length && sigs.length >= max) rounds[0].entries = [];
  return rounds;
}
