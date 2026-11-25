"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import NumberFlow from "@number-flow/react";
import confetti from "canvas-confetti";
import { needleAngle, segments, TABLE_STATUS, type Table, fmtD, short, hex } from "@landed/sdk";
import Link from "next/link";

const PALETTE = ["#FF6A3D", "#8FB4FF", "#C49BFF", "#3DFFB4", "#FFB547", "#5EE1FF", "#FF8FD1", "#B8F06A"];
export const colorFor = (pk: string) => {
  let h = 0;
  for (let i = 0; i < pk.length; i++) h = (h * 31 + pk.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
};

interface Reveal { roundId: bigint; entries: { player: string; amount: bigint }[]; randomness: Uint8Array; winnerIdx: number }

const R = 120, STROKE = 26, C = 150;
function arc(startDeg: number, endDeg: number) {
  const a0 = ((startDeg - 90) * Math.PI) / 180, a1 = ((endDeg - 90) * Math.PI) / 180;
  const large = endDeg - startDeg > 180 ? 1 : 0;
  const x0 = C + R * Math.cos(a0), y0 = C + R * Math.sin(a0), x1 = C + R * Math.cos(a1), y1 = C + R * Math.sin(a1);
  return `M ${x0} ${y0} A ${R} ${R} 0 ${large} 1 ${x1} ${y1}`;
}

export function PotRing({ table, me, bots, now }: { table: Table | null | undefined; me: string | null; bots: Set<string>; now: number }) {
  const reduce = useReducedMotion();
  const seen = useRef(new Map<string, { player: string; amount: bigint }[]>());
  const [reveal, setReveal] = useState<Reveal | null>(null);

  // Remember entries per round so a reveal can be shown even if settle lands fast.
  useEffect(() => {
    if (!table) return;
    if (table.entries.length) seen.current.set(table.roundId.toString(), table.entries.map((e) => ({ player: e.player.toBase58(), amount: e.amount })));
    if (table.status === TABLE_STATUS.DRAWN) {
      setReveal({ roundId: table.roundId, entries: table.entries.map((e) => ({ player: e.player.toBase58(), amount: e.amount })), randomness: table.randomness, winnerIdx: table.winnerIdx });
    } else {
      const last = table.history.filter((h) => h.outcome === 1).sort((a, b) => Number(b.roundId - a.roundId))[0];
      if (last && last.roundId === table.roundId - 1n && (!reveal || reveal.roundId !== last.roundId)) {
        const ents = seen.current.get(last.roundId.toString());
        if (ents && Date.now() / 1000 - Number(last.settledTs) < 8) setReveal({ roundId: last.roundId, entries: ents, randomness: last.randomness, winnerIdx: last.winnerIdx });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table?.roundId, table?.status, table?.entryCount, table?.pot]);

  // Clear a reveal after it has been on screen for a while.
  useEffect(() => {
    if (!reveal) return;
    const t = setTimeout(() => setReveal((r) => (r && r.roundId === reveal.roundId && table?.status !== TABLE_STATUS.DRAWN ? null : r)), 7000);
    return () => clearTimeout(t);
  }, [reveal, table?.status]);

  const showing = reveal ?? (table ? { roundId: table.roundId, entries: table.entries.map((e) => ({ player: e.player.toBase58(), amount: e.amount })), randomness: null, winnerIdx: -1 } : null);
  const amounts = useMemo(() => (showing?.entries ?? []).map((e) => e.amount), [showing]);
  const segs = useMemo(() => segments(amounts), [amounts]);
  const angle = reveal ? needleAngle(reveal.randomness, reveal.entries.map((e) => e.amount)) : null;
  const winner = reveal ? reveal.entries[reveal.winnerIdx]?.player : null;
  const iWon = !!(winner && me && winner === me);
  const pot = amounts.reduce((a, b) => a + b, 0n);

  useEffect(() => {
    if (iWon && !reduce) {
      const t = setTimeout(() => confetti({ particleCount: 120, spread: 70, origin: { y: 0.45 }, colors: ["#FF6A3D", "#3DFFB4", "#FFB547"] }), 1400);
      return () => clearTimeout(t);
    }
  }, [iWon, reduce, reveal?.roundId]);

  const secsLeft = table && table.closesTs > 0n ? Math.max(0, Number(table.closesTs) - Math.floor(now / 1000)) : null;
  const status = table === undefined ? "loading" : table === null ? "missing" : reveal ? "reveal" : table.status === TABLE_STATUS.AWAITING_VRF ? "vrf" : table.entryCount === 0 ? "idle" : secsLeft === 0 ? "closing" : "open";

  return (
    <div className="relative mx-auto aspect-square w-full max-w-[360px]" data-tour="ring">
      <svg viewBox="0 0 300 300" className="h-full w-full" role="img" aria-label={`Pot ring: ${segs.length} players, pot ${fmtD(pot)} dUSDC`}>
        <defs>
          <pattern id="botStripes" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="transparent" />
            <rect width="3" height="6" fill="rgba(11,14,20,.45)" />
          </pattern>
        </defs>
        <circle cx={C} cy={C} r={R} fill="none" stroke="var(--color-hairline)" strokeWidth={STROKE} />
        {segs.map((s, i) => {
          const p = showing!.entries[i].player;
          const col = colorFor(p);
          const isWinner = reveal && i === reveal.winnerIdx;
          const d = segs.length === 1 ? arc(0, 359.99) : arc(s.start + 0.6, s.end - 0.6);
          return (
            <g key={`${p}-${showing!.roundId}`}>
              <motion.path d={d} fill="none" stroke={col} strokeWidth={isWinner ? STROKE + 8 : STROKE} strokeLinecap="butt"
                initial={reduce ? false : { pathLength: 0, opacity: 0 }} animate={{ pathLength: 1, opacity: reveal && !isWinner ? 0.35 : 1 }}
                transition={{ type: "spring", stiffness: 140, damping: 20 }} />
              {bots.has(p) && <path d={d} fill="none" stroke="url(#botStripes)" strokeWidth={STROKE} />}
              {p === me && <path d={d} fill="none" stroke="#e8ecf4" strokeWidth={2} transform="" strokeDasharray="1 5" />}
            </g>
          );
        })}
        {status === "vrf" && !reduce && (
          <g style={{ transformOrigin: "150px 150px" }} className="animate-sweep">
            <path d={arc(0, 40)} fill="none" stroke="var(--color-signal)" strokeOpacity={0.6} strokeWidth={STROKE + 10} />
          </g>
        )}
        {angle !== null && (
          <motion.g style={{ transformOrigin: "150px 150px" }} initial={{ rotate: reduce ? angle : angle - 720 - 90 }} animate={{ rotate: angle }}
            transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 22, damping: 9, mass: 1.2 }}>
            <line x1={C} y1={C} x2={C} y2={C - R - 18} stroke="#e8ecf4" strokeWidth={3} strokeLinecap="round" />
            <circle cx={C} cy={C - R - 18} r={5} fill="#e8ecf4" />
          </motion.g>
        )}
        <circle cx={C} cy={C} r={8} fill="#e8ecf4" opacity={angle !== null ? 1 : 0} />
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
        {status === "open" && secsLeft !== null && (
          <>
            <span className="text-xs uppercase tracking-widest text-[var(--color-dim)]">closes in</span>
            <span className="display num text-5xl font-semibold"><NumberFlow value={secsLeft} /></span>
            <span className="num mt-1 text-sm text-[var(--color-muted)]">pot {fmtD(pot)} dUSDC</span>
          </>
        )}
        {status === "idle" && <><span className="display text-lg">Drop zone open</span><span className="mt-1 text-sm text-[var(--color-muted)]">First chip starts the 20 s round</span></>}
        {status === "closing" && <span className="display text-lg">Closing…</span>}
        {status === "vrf" && <><span className="display text-lg">Drawing</span><span className="mt-1 text-sm text-[var(--color-muted)]">MagicBlock VRF</span></>}
        {status === "reveal" && winner && (
          <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ delay: reduce ? 0 : 1.2 }} className="px-6">
            <div className="text-xs uppercase tracking-widest text-[var(--color-dim)]">landed on</div>
            <div className={`display text-xl ${iWon ? "text-[var(--color-mint)]" : ""}`}>{iWon ? "You!" : short(winner)}</div>
            <div className="num text-sm text-[var(--color-muted)]">{fmtD((pot * 98n) / 100n)} dUSDC</div>
            <Link href={`/verify?round=${reveal!.roundId}`} className="pointer-events-auto mt-1 inline-block text-xs text-[var(--color-signal)] underline">
              Verify this round
            </Link>
          </motion.div>
        )}
        {status === "loading" && <span className="text-sm text-[var(--color-muted)]">Connecting to the rollup…</span>}
        {status === "missing" && <span className="max-w-[60%] text-sm text-[var(--color-muted)]">The Drop table isn&apos;t live on devnet yet.</span>}
      </div>
      {reveal && <span className="sr-only" aria-live="polite">Round {reveal.roundId.toString()} landed on {iWon ? "you" : winner}. Randomness {hex(reveal.randomness).slice(0, 16)}…</span>}
    </div>
  );
}
