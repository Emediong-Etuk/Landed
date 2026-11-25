"use client";
import { create } from "zustand";
import type { Keypair, PublicKey } from "@solana/web3.js";
import type { CashoutState } from "@landed/sdk";

export type Mode = "none" | "guest" | "wallet";
export interface Progress { step: number; total: number; label: string }

interface State {
  mode: Mode;
  owner: PublicKey | null;
  /** Signs ER actions: the guest burner, or the wallet's session key. */
  actor: Keypair | null;
  sessionToken: PublicKey | null;
  progress: Progress | null;
  ready: boolean;
  error: { message: string; action?: { label: string; run: () => void } } | null;
  ops: CashoutState[];
  technical: boolean;
  judge: boolean;
  erSlow: boolean;
  latencies: number[];
  set: (p: Partial<State>) => void;
  upsertOp: (o: CashoutState) => void;
  pushLatency: (ms: number) => void;
}

const tryRead = (k: string) => { try { return localStorage.getItem(k) === "1"; } catch { return false; } };

export const useApp = create<State>((set) => ({
  mode: "none",
  owner: null,
  actor: null,
  sessionToken: null,
  progress: null,
  ready: false,
  error: null,
  ops: [],
  technical: typeof window !== "undefined" && tryRead("landed.technical"),
  judge: false,
  erSlow: false,
  latencies: [],
  set: (p) => set(p),
  upsertOp: (o) =>
    set((s) => {
      const i = s.ops.findIndex((x) => x.owner === o.owner && x.nonce === o.nonce);
      const ops = [...s.ops];
      if (i >= 0) ops[i] = o;
      else ops.unshift(o);
      return { ops: ops.slice(0, 20) };
    }),
  pushLatency: (ms) => set((s) => ({ latencies: [...s.latencies.slice(-49), ms] })),
}));
