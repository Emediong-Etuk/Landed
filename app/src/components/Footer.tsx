import Link from "next/link";
import { cfg } from "@/lib/config";

export function Footer() {
  return (
    <footer className="border-t hair">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-6 text-sm text-[var(--color-dim)] sm:px-6">
        <span>Landed · Solana Blitz v10 · Entertainment Finance</span>
        <span>Devnet only · test token (dUSDC) · no real money</span>
        <Link href="/how-it-works#limitations" className="underline-offset-2 hover:underline">Honest limitations</Link>
        <a href={cfg.repo} className="underline-offset-2 hover:underline" rel="noreferrer">Source</a>
      </div>
    </footer>
  );
}
