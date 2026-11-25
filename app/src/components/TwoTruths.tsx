"use client";
import { motion, useReducedMotion } from "motion/react";

/** Animated explainer: the win settles in the rollup; the cash-out has to cross to Solana. */
export function TwoTruths() {
  const reduce = useReducedMotion();
  const dot = (delay: number, dropped = false) => (
    <motion.circle r="7" cy="60" fill={dropped ? "var(--color-danger)" : "var(--color-mint)"}
      initial={{ cx: 178, opacity: 0 }}
      animate={reduce ? { cx: dropped ? 260 : 342, opacity: 1 } : dropped ? { cx: [178, 260, 260], cy: [60, 60, 118], opacity: [1, 1, 0] } : { cx: [178, 342], opacity: [1, 1] }}
      transition={{ duration: 2.4, delay, repeat: reduce ? 0 : Infinity, repeatDelay: 1.6, ease: "easeInOut" }} />
  );
  return (
    <figure className="card p-4">
      <svg viewBox="0 0 520 150" className="mx-auto w-full max-w-2xl" role="img" aria-label="A cash-out leaves the rollup as a commit plus a separate payout action. If the action fails, the commit lands but the payout doesn't.">
        <rect x="10" y="20" width="160" height="80" rx="14" fill="var(--color-raised-2)" stroke="var(--color-er)" />
        <text x="90" y="52" textAnchor="middle" fill="var(--color-er)" fontSize="13">Ephemeral Rollup</text>
        <text x="90" y="72" textAnchor="middle" fill="var(--color-muted)" fontSize="11">win settles · ~10 ms</text>
        <rect x="350" y="20" width="160" height="80" rx="14" fill="var(--color-raised-2)" stroke="var(--color-l1)" />
        <text x="430" y="52" textAnchor="middle" fill="var(--color-l1)" fontSize="13">Solana</text>
        <text x="430" y="72" textAnchor="middle" fill="var(--color-muted)" fontSize="11">your wallet</text>
        <line x1="170" y1="60" x2="350" y2="60" stroke="var(--color-hairline)" strokeWidth="2" strokeDasharray="6 6" />
        <text x="260" y="45" textAnchor="middle" fill="var(--color-dim)" fontSize="11">commit + post-commit action</text>
        {dot(0)}
        {dot(2, true)}
        <text x="260" y="140" textAnchor="middle" fill="var(--color-danger)" fontSize="11">action fails → dropped, commit lands without it</text>
      </svg>
      <figcaption className="mt-2 text-sm text-[var(--color-muted)]">
        Two truths: the rollup says you were paid out; Solana says you weren't. Landed records every cash-out in the committed ledger, so a dropped payout can always be rescued — by you, our keeper, or anyone.
      </figcaption>
    </figure>
  );
}
