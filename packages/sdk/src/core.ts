/**
 * TypeScript port of `crates/landed-core`. Must reproduce the Rust golden
 * vectors (`crates/landed-core/vectors.json`) bit for bit — see test/core.test.ts.
 */
import { sha256 } from "@noble/hashes/sha256";

const BPS_DENOM = 10_000n;
const I64_MAX = (1n << 63n) - 1n;
const U64_MAX = (1n << 64n) - 1n;

export function houseFee(pot: bigint, bps: number): bigint | null {
  if (bps > 10_000 || bps < 0) return null;
  return (pot * BigInt(bps)) / BPS_DENOM;
}

export function splitPot(pot: bigint, bps: number): { credit: bigint; fee: bigint } | null {
  const fee = houseFee(pot, bps);
  return fee === null ? null : { credit: pot - fee, fee };
}

function u128le(bytes: Uint8Array): bigint {
  let r = 0n;
  for (let i = 15; i >= 0; i--) r = (r << 8n) | BigInt(bytes[i]);
  return r;
}

export function drawTarget(randomness: Uint8Array, pot: bigint): bigint | null {
  if (pot === 0n) return null;
  return u128le(randomness) % pot;
}

/** Stake-weighted winner: first index whose cumulative sum > target. */
export function selectWinner(randomness: Uint8Array, amounts: bigint[]): number | null {
  let pot = 0n;
  for (const a of amounts) {
    pot += a;
    if (pot > U64_MAX) return null;
  }
  const target = drawTarget(randomness, pot);
  if (target === null) return null;
  let cum = 0n;
  for (let i = 0; i < amounts.length; i++) {
    cum += amounts[i];
    if (cum > target) return i;
  }
  return null;
}

const le = (n: bigint, bytes: number, signed = false): Uint8Array => {
  const b = new Uint8Array(bytes);
  const v = new DataView(b.buffer);
  if (bytes === 8) signed ? v.setBigInt64(0, n, true) : v.setBigUint64(0, n, true);
  else if (bytes === 4) v.setUint32(0, Number(n), true);
  return b;
};

function concat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function entriesHash(players: Uint8Array[], amounts: bigint[]): Uint8Array {
  const n = Math.min(players.length, amounts.length);
  const parts: Uint8Array[] = [le(BigInt(n), 4)];
  for (let i = 0; i < n; i++) parts.push(players[i], le(amounts[i], 8));
  return sha256(concat(parts));
}

export function vrfCallerSeed(tableId: bigint, roundId: bigint, eh: Uint8Array, closesTs: bigint, vrfNonce: bigint): Uint8Array {
  return sha256(concat([new TextEncoder().encode("landed-vrf"), le(tableId, 8), le(roundId, 8), eh, le(closesTs, 8, true), le(vrfNonce, 8)]));
}

export function crankTaskId(programId: Uint8Array, table: Uint8Array): bigint {
  const d = sha256(concat([new TextEncoder().encode("landed-crank"), programId, table]));
  const v = new DataView(d.buffer, d.byteOffset, 8).getBigInt64(0, true);
  return v & I64_MAX;
}

/**
 * Where the reveal needle lands, in degrees [0, 360): the centre of the unit
 * at `target` on a ring whose segments are the entries in order. Derived only
 * from on-chain randomness + entries, so anyone can reproduce the animation.
 */
export function needleAngle(randomness: Uint8Array, amounts: bigint[]): number | null {
  const pot = amounts.reduce((s, a) => s + a, 0n);
  const t = drawTarget(randomness, pot);
  if (t === null) return null;
  // (2t + 1) / (2 pot) * 360, computed with enough precision for display.
  const num = (2n * t + 1n) * 360_000_000n;
  return Number(num / (2n * pot)) / 1_000_000;
}

/** Segment boundaries in degrees, for drawing the PotRing. */
export function segments(amounts: bigint[]): { start: number; end: number }[] {
  const pot = amounts.reduce((s, a) => s + a, 0n);
  if (pot === 0n) return [];
  let cum = 0n;
  return amounts.map((a) => {
    const start = Number((cum * 360_000_000n) / pot) / 1_000_000;
    cum += a;
    const end = Number((cum * 360_000_000n) / pot) / 1_000_000;
    return { start, end };
  });
}

export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const fromHex = (s: string) => new Uint8Array(s.match(/../g)!.map((h) => parseInt(h, 16)));
