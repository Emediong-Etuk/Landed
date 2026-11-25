#!/usr/bin/env -S npx tsx
/**
 * landed-verify --cluster devnet [--rpc URL] [--er URL] [--json out.json] [--no-naive]
 * Exit: 0 all pass · 1 violation · 2 could not fetch.
 */
import { writeFileSync } from "node:fs";
import { ENDPOINTS } from "@landed/sdk";
import { buildReport, fetchSnapshot, reportJson, reportTable, runAll } from "./index";

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const cluster = (arg("--cluster") ?? "devnet") as keyof typeof ENDPOINTS;
const ep = ENDPOINTS[cluster] ?? ENDPOINTS.devnet;
const l1Url = arg("--rpc") ?? process.env.LANDED_L1_RPC ?? ep.l1;
const erUrl = arg("--er") ?? process.env.LANDED_ER_RPC ?? ep.er;

try {
  const snap = await fetchSnapshot({ l1Url, erUrl, includeNaive: !args.includes("--no-naive"), onProgress: (m) => process.stderr.write(`… ${m}\n`) });
  const checks = runAll(snap);
  const rep = buildReport(snap, checks);
  console.log(reportTable(rep));
  const out = arg("--json");
  if (out) writeFileSync(out, reportJson(rep));
  // The naive baseline is EXPECTED to fail (that is the point); it doesn't affect the exit code.
  process.exit(checks.some((c) => c.status === "fail" && c.id !== "N1") ? 1 : 0);
} catch (e) {
  console.error(`could not fetch: ${(e as Error).message}`);
  process.exit(2);
}
