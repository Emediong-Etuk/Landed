import type { CheckResult, Snapshot } from "./checks";

export interface Report {
  generatedAt: string;
  source: string;
  summary: { pass: number; fail: number; warn: number; skip: number; ok: boolean };
  checks: CheckResult[];
  counts: { deposits: number; withdrawals: number; ledgers: number; roundsReconstructed: number; historyLen: string | null };
  notes: string[];
}

const json = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

export function buildReport(s: Snapshot, checks: CheckResult[]): Report {
  const c = (st: string) => checks.filter((x) => x.status === st).length;
  return {
    generatedAt: new Date(s.fetchedAtMs).toISOString(),
    source: s.label,
    summary: { pass: c("pass"), fail: c("fail"), warn: c("warn"), skip: c("skip"), ok: c("fail") === 0 },
    checks,
    counts: {
      deposits: s.deposits.length,
      withdrawals: s.withdrawals.length,
      ledgers: s.ledgersEr.size,
      roundsReconstructed: s.rounds.filter((r) => r.settled).length,
      historyLen: s.table ? s.table.historyLen.toString() : null,
    },
    notes: s.notes,
  };
}

export const reportJson = (r: Report) => JSON.stringify(r, json, 2);

export function reportTable(r: Report): string {
  const icon = { pass: "PASS", fail: "FAIL", warn: "WARN", skip: "SKIP" } as const;
  const lines = [`Landed verifier — ${r.generatedAt}`, `source: ${r.source}`, ""];
  for (const c of r.checks) lines.push(`[${icon[c.status]}] ${c.id.padEnd(3)} ${c.title}\n        ${c.detail}`);
  lines.push("", `${r.summary.pass} pass · ${r.summary.fail} fail · ${r.summary.warn} warn · ${r.summary.skip} skip`);
  if (r.notes.length) lines.push("notes:", ...r.notes.map((n) => `  - ${n}`));
  return lines.join("\n");
}
