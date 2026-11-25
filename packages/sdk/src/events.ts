/** Anchor event decoding from transaction logs ("Program data: <base64>"). */
import { PublicKey } from "@solana/web3.js";
import idl from "./idl/landed.json";
import { Reader } from "./layout";

type IdlEv = { name: string; discriminator: number[] };
const D = new Map<string, string>((idl.events as IdlEv[]).map((e) => [Buffer.from(e.discriminator).toString("hex"), e.name]));

export type LandedEvent =
  | { name: "Entered"; table: bigint; roundId: bigint; player: PublicKey; amount: bigint; pot: bigint }
  | { name: "RoundClosed"; table: bigint; roundId: bigint; vrfNonce: bigint; closedBy: number; entriesHash: Uint8Array }
  | { name: "RoundDrawn"; table: bigint; roundId: bigint; vrfNonce: bigint; winnerIdx: number; randomness: Uint8Array }
  | { name: "RoundSettled"; table: bigint; roundId: bigint; winner: PublicKey; pot: bigint; fee: bigint; credit: bigint }
  | { name: "RoundVoided"; table: bigint; roundId: bigint; refunded: bigint }
  | { name: "RoundExtended"; table: bigint; roundId: bigint; closesTs: bigint }
  | { name: "StaleCallbackIgnored"; table: bigint; roundId: bigint; vrfNonce: bigint; expectedRoundId: bigint; expectedNonce: bigint; status: number }
  | { name: "VrfRetried"; table: bigint; roundId: bigint; vrfNonce: bigint; attempts: number }
  | { name: "SoloLeft"; table: bigint; roundId: bigint; player: PublicKey; amount: bigint }
  | { name: "WithdrawRequested"; owner: PublicKey; nonce: bigint; amount: bigint; fault: boolean; ts: bigint }
  | { name: "WithdrawPaid"; owner: PublicKey; nonce: bigint; amount: bigint; path: number; rescuer: PublicKey }
  | { name: "WithdrawAcked"; owner: PublicKey; nonce: bigint }
  | { name: "DepositIngested"; owner: PublicKey; nonce: bigint; amount: bigint; available: bigint }
  | { name: "Deposited"; owner: PublicKey; nonce: bigint; amount: bigint }
  | { name: "CommitForced"; owner: PublicKey; oldestPendingNonce: bigint };

export function decodeEvent(b64: string): LandedEvent | null {
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(Buffer.from(b64, "base64"));
  } catch {
    return null;
  }
  if (bytes.length < 8) return null;
  const name = D.get(Buffer.from(bytes.slice(0, 8)).toString("hex"));
  if (!name) return null;
  const r = new Reader(bytes, 8);
  switch (name) {
    case "Entered": return { name, table: r.u64(), roundId: r.u64(), player: r.pk(), amount: r.u64(), pot: r.u64() };
    case "RoundClosed": return { name, table: r.u64(), roundId: r.u64(), vrfNonce: r.u64(), closedBy: r.u8(), entriesHash: r.bytes(32) };
    case "RoundDrawn": return { name, table: r.u64(), roundId: r.u64(), vrfNonce: r.u64(), winnerIdx: r.u8(), randomness: r.bytes(32) };
    case "RoundSettled": return { name, table: r.u64(), roundId: r.u64(), winner: r.pk(), pot: r.u64(), fee: r.u64(), credit: r.u64() };
    case "RoundVoided": return { name, table: r.u64(), roundId: r.u64(), refunded: r.u64() };
    case "RoundExtended": return { name, table: r.u64(), roundId: r.u64(), closesTs: r.i64() };
    case "StaleCallbackIgnored": return { name, table: r.u64(), roundId: r.u64(), vrfNonce: r.u64(), expectedRoundId: r.u64(), expectedNonce: r.u64(), status: r.u8() };
    case "VrfRetried": return { name, table: r.u64(), roundId: r.u64(), vrfNonce: r.u64(), attempts: r.u8() };
    case "SoloLeft": return { name, table: r.u64(), roundId: r.u64(), player: r.pk(), amount: r.u64() };
    case "WithdrawRequested": return { name, owner: r.pk(), nonce: r.u64(), amount: r.u64(), fault: r.bool(), ts: r.i64() };
    case "WithdrawPaid": return { name, owner: r.pk(), nonce: r.u64(), amount: r.u64(), path: r.u8(), rescuer: r.pk() };
    case "WithdrawAcked": return { name, owner: r.pk(), nonce: r.u64() };
    case "DepositIngested": return { name, owner: r.pk(), nonce: r.u64(), amount: r.u64(), available: r.u64() };
    case "Deposited": return { name, owner: r.pk(), nonce: r.u64(), amount: r.u64() };
    case "CommitForced": return { name, owner: r.pk(), oldestPendingNonce: r.u64() };
  }
  return null;
}

/** All Landed events in a transaction's logs (only those emitted by our program). */
export function eventsFromLogs(logs: string[] | null | undefined, programId = idl.address): LandedEvent[] {
  if (!logs) return [];
  const out: LandedEvent[] = [];
  const stack: string[] = [];
  for (const l of logs) {
    const inv = l.match(/^Program (\w+) invoke/);
    if (inv) { stack.push(inv[1]); continue; }
    if (/^Program \w+ (success|failed)/.test(l)) { stack.pop(); continue; }
    if (l.startsWith("Program data: ") && stack[stack.length - 1] === programId) {
      const e = decodeEvent(l.slice("Program data: ".length));
      if (e) out.push(e);
    }
  }
  return out;
}
