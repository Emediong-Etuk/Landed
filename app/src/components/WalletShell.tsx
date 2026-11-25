"use client";
import { useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { cfg } from "@/lib/config";

/** Wallet providers only where wallets are used (/play, /lab) so the landing page stays light. */
export function WalletShell({ children }: { children: React.ReactNode }) {
  // Wallet Standard auto-detects Phantom, Solflare, Backpack — no adapter bundles needed.
  const wallets = useMemo(() => [], []);
  return (
    <ConnectionProvider endpoint={cfg.l1Fallback}>
      <WalletProvider wallets={wallets} autoConnect={false}>{children}</WalletProvider>
    </ConnectionProvider>
  );
}
