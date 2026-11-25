"use client";
import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { motion } from "motion/react";
import { useApp } from "@/lib/store";
import { onboardWallet, playAsGuest } from "@/lib/actions";
import { Pip } from "./Pip";

export function GuestButton({ className = "", label = "Play as guest" }: { className?: string; label?: string }) {
  const progress = useApp((s) => s.progress);
  return (
    <button className={`btn btn-primary ${className}`} data-tour="guest" disabled={!!progress} onClick={() => void playAsGuest()}>
      {progress ? progress.label : label}
    </button>
  );
}

export function WalletButton({ className = "" }: { className?: string }) {
  const { wallets, select, connect, publicKey, signAllTransactions, wallet, connected } = useWallet();
  const [open, setOpen] = useState(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("wallet") === "1");
  const { mode } = useApp();
  const installed = wallets.filter((w) => w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable);
  useEffect(() => {
    if (connected && publicKey && signAllTransactions && mode !== "wallet") void onboardWallet(publicKey, signAllTransactions);
  }, [connected, publicKey, signAllTransactions, mode]);
  useEffect(() => {
    if (wallet && !connected) connect().catch(() => useApp.getState().set({ error: { message: "The wallet didn't connect. You can still play as a guest." } }));
  }, [wallet, connected, connect]);
  return (
    <div className="relative">
      <button className={`btn btn-ghost ${className}`} aria-expanded={open} onClick={() => setOpen(!open)}>Connect wallet</button>
      {open && (
        <div role="menu" className="card absolute left-0 top-full z-30 mt-2 w-64 p-2">
          {installed.length ? installed.map((w) => (
            <button key={w.adapter.name} role="menuitem" className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-[var(--color-raised-2)]"
              onClick={() => { select(w.adapter.name); setOpen(false); }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={w.adapter.icon} alt="" width={20} height={20} /> {w.adapter.name}
            </button>
          )) : <p className="p-2 text-sm text-[var(--color-muted)]">No Solana wallet detected. Phantom, Solflare and Backpack work, or play as a guest — no install needed.</p>}
        </div>
      )}
    </div>
  );
}

export function JoinPanel() {
  const progress = useApp((s) => s.progress);
  return (
    <div className="card flex flex-col items-center gap-4 p-6 text-center">
      <Pip size={64} />
      <h2 className="display text-xl">Grab a seat at The Drop</h2>
      <p className="max-w-sm text-sm text-[var(--color-muted)]">20-second pot rounds. Drop 1–25 dUSDC chips, MagicBlock VRF picks a winner weighted by stake, and every win lands in your Solana wallet.</p>
      <div className="flex flex-wrap justify-center gap-2">
        <GuestButton />
        <WalletButton />
      </div>
      {progress && (
        <div className="w-full max-w-xs" role="status">
          <div className="mb-1 text-xs text-[var(--color-muted)]">{progress.label} {progress.step}/{progress.total}</div>
          <div className="h-1.5 overflow-hidden rounded-full bg-[var(--color-hairline)]">
            <motion.div className="h-full bg-[var(--color-signal)]" initial={{ width: 0 }} animate={{ width: `${(progress.step / progress.total) * 100}%` }} />
          </div>
        </div>
      )}
      <p className="text-xs text-[var(--color-dim)]">Devnet test token. No real money.</p>
    </div>
  );
}
