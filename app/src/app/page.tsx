import Link from "next/link";
import { LiveStats } from "@/components/Stats";
import { TwoTruths } from "@/components/TwoTruths";
import { Pip } from "@/components/Pip";

export default function Home() {
  return (
    <div className="flex flex-col gap-10 pt-6">
      <section data-tour="hero" className="grid items-center gap-8 md:grid-cols-[1.3fr_1fr]">
        <div>
          <p className="mb-3 text-sm font-medium text-[var(--color-signal)]">Solana Blitz v10 · Entertainment Finance · MagicBlock</p>
          <h1 className="display text-4xl font-semibold leading-tight sm:text-5xl">
            Every win <span className="text-[var(--color-mint)]">lands.</span>
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-relaxed text-[var(--color-muted)] sm:text-lg">
            On MagicBlock, a jackpot round settles in ~10 ms inside the Ephemeral Rollup, but the cash-out to Solana rides a post-commit Magic Action that is
            not atomic with the commit — when the action fails, the validator drops it and re-commits without it, so one failed action means 100% of that
            withdrawal is debited in the rollup and 0% reaches the player&apos;s wallet, with no error the player ever sees.
          </p>
          <p className="mt-3 max-w-2xl text-base text-[var(--color-text)]">
            Landed is a 20-second jackpot game where every cash-out is exactly-once and permissionlessly rescuable. Nobody loses a win to a dropped action.
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            <Link href="/play?guest=1" className="btn btn-primary !px-6" data-tour="guest">Play as guest</Link>
            <Link href="/play?wallet=1" className="btn btn-ghost">Connect wallet</Link>
            <Link href="/verify" className="btn btn-ghost">Verify everything</Link>
          </div>
        </div>
        <div className="hidden justify-center md:flex"><Pip size={200} /></div>
      </section>
      <LiveStats />
      <section className="grid gap-4 md:grid-cols-3">
        {[
          ["The Drop", "Drop chips in one tap — free, ~10 ms, no wallet popup. MagicBlock VRF picks a stake-weighted winner.", "/play"],
          ["Fault Lab", "Break a payout on purpose. Watch the documented pattern strand the funds and Landed rescue them.", "/lab"],
          ["Verify", "Recompute every round and reconcile every payout from chain data, in your browser or terminal.", "/verify"],
        ].map(([t, d, h]) => (
          <Link key={h} href={h} className="card p-5 transition-colors hover:bg-[var(--color-raised-2)]">
            <h2 className="display text-lg">{t}</h2>
            <p className="mt-2 text-sm text-[var(--color-muted)]">{d}</p>
          </Link>
        ))}
      </section>
      <TwoTruths />
      <Link href="/watch" data-tour="watch"
        className="fixed bottom-5 right-5 z-30 flex items-center gap-2 rounded-full border hair bg-[var(--color-raised)] px-4 py-2.5 text-sm shadow-lg hover:bg-[var(--color-raised-2)]">
        <span aria-hidden className="inline-block h-0 w-0 border-y-[6px] border-l-[10px] border-y-transparent border-l-[var(--color-signal)]" /> Watch the pitch (≤3:00)
      </Link>
    </div>
  );
}
