"use client";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { PublicKey } from "@solana/web3.js";
import { eventsFromLogs, type Table } from "@landed/sdk";
import { getClient } from "./chain";

export function useTable() {
  return useQuery<Table | null>({
    queryKey: ["table"],
    queryFn: () => getClient().table("ER"),
    refetchInterval: 700,
    retry: 1,
  });
}

export function useBalances(owner: PublicKey | null) {
  return useQuery({
    queryKey: ["balances", owner?.toBase58()],
    queryFn: () => getClient().balances(owner!),
    enabled: !!owner,
    refetchInterval: 1200,
  });
}

export interface FeedItem { sig: string; player: string; amount: bigint; roundId: bigint; at: number }
/** Live entry feed straight from ER transaction logs (Entered events). */
export function useFeed() {
  return useQuery<FeedItem[]>({
    queryKey: ["feed"],
    queryFn: async () => {
      const c = getClient();
      const sigs = await c.er.getSignaturesForAddress(c.a.table, { limit: 20 });
      const txs = await Promise.all(sigs.map((s) => c.er.getTransaction(s.signature, { maxSupportedTransactionVersion: 1 }).catch(() => null)));
      const out: FeedItem[] = [];
      txs.forEach((t, i) => {
        for (const e of eventsFromLogs(t?.meta?.logMessages)) {
          if (e.name === "Entered") out.push({ sig: sigs[i].signature, player: e.player.toBase58(), amount: e.amount, roundId: e.roundId, at: (sigs[i].blockTime ?? 0) * 1000 });
        }
      });
      return out.slice(0, 12);
    },
    refetchInterval: 2500,
    retry: 0,
  });
}

export function useNow(everyMs = 250) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

export { useStats, type Stats } from "./stats";

export function useBots(): Set<string> {
  const { data } = useQuery<{ bots: { pubkey: string }[] }>({ queryKey: ["bots"], queryFn: () => fetch("/bots.json").then((r) => r.json()), staleTime: Infinity });
  return new Set((data?.bots ?? []).map((b) => b.pubkey));
}
