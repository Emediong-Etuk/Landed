/// <reference lib="webworker" />
import { Buffer } from "buffer";
(self as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
import { buildReport, fetchSnapshot, reportJson, runAll } from "@landed/verifier";

self.onmessage = async (e: MessageEvent<{ l1Url: string; erUrl: string }>) => {
  const post = (m: unknown) => (self as unknown as Worker).postMessage(m);
  try {
    const snap = await fetchSnapshot({ ...e.data, onProgress: (msg) => post({ type: "progress", msg }), maxSignatures: 400 });
    const checks = runAll(snap);
    const rep = buildReport(snap, checks);
    const rounds = snap.rounds.filter((r) => r.settled).slice(-30).map((r) => ({ ...r, entries: r.entries.map((x) => ({ ...x, amount: x.amount.toString() })) }));
    post({ type: "done", report: JSON.parse(reportJson(rep)), rounds: JSON.parse(JSON.stringify(rounds, (_k, v) => (typeof v === "bigint" ? v.toString() : v))) });
  } catch (err) {
    post({ type: "error", message: (err as Error).message });
  }
};
