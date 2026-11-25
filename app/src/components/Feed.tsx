"use client";
import { AnimatePresence, motion } from "motion/react";
import { fmtD, short } from "@landed/sdk";
import { useFeed, useBots } from "@/lib/hooks";
import { useApp } from "@/lib/store";
import { colorFor } from "./PotRing";
import { TxChip } from "./Rail";

export function Feed() {
  const { data, isError } = useFeed();
  const bots = useBots();
  const me = useApp((s) => s.owner?.toBase58());
  return (
    <div className="card p-4">
      <h2 className="mb-2 text-sm font-semibold text-[var(--color-muted)]">Live drops</h2>
      {isError && <p className="text-sm text-[var(--color-dim)]">Feed unavailable — the ring still updates.</p>}
      <ul className="flex max-h-64 flex-col gap-1.5 overflow-y-auto" aria-live="polite">
        <AnimatePresence initial={false}>
          {(data ?? []).map((f) => (
            <motion.li key={f.sig + f.player} layout initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              className="flex items-center gap-2 text-sm">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: colorFor(f.player) }} aria-hidden />
              <span className="num">{f.player === me ? "you" : short(f.player)}</span>
              {bots.has(f.player) && <span className="rounded border hair px-1 text-[10px] text-[var(--color-dim)]">BOT</span>}
              <span className="num ml-auto">{fmtD(f.amount, 0)}</span>
              <TxChip sig={f.sig} layer="ER" />
            </motion.li>
          ))}
        </AnimatePresence>
        {!data?.length && !isError && <li className="text-sm text-[var(--color-dim)]">No drops yet this round.</li>}
      </ul>
    </div>
  );
}
