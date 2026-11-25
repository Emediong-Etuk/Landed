"use client";
import { useQuery } from "@tanstack/react-query";

export interface Stats {
  deployed: boolean;
  roundsSettled: number | null;
  totalPaidD: number | null;
  owedOver60s: number | null;
  crankPct: number | null;
  erP50Ms: number | null;
  receipts: number | null;
  rescues: number | null;
  asOf: string;
  note?: string;
}
export function useStats() {
  return useQuery<Stats>({ queryKey: ["stats"], queryFn: () => fetch("/api/stats").then((r) => r.json()), refetchInterval: 15_000 });
}

