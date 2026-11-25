/**
 * Node-only evidence recorder. EVERY script/test that touches devnet writes
 * through `recordEvidence` into `evidence/ledger.jsonl` (append-only, never
 * hand-edited). `pnpm evidence:summarize` turns it into docs/EVIDENCE.md.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { txUrl, type Layer } from "./explorer";

export interface EvidenceLine {
  ts: string;
  campaign: string;
  step: string;
  layer: Layer;
  sig: string | null;
  explorer_url: string | null;
  program: string | null;
  ix: string | null;
  accounts: string[];
  ok: boolean;
  err: string | null;
  latency_ms: number | null;
  slot: number | null;
  notes: string | null;
}

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../../..");
export const EVIDENCE_PATH = process.env.LANDED_EVIDENCE_PATH ?? resolve(ROOT, "evidence/ledger.jsonl");

export function recordEvidence(e: Partial<EvidenceLine> & { campaign: string; step: string; layer: Layer; ok: boolean }): EvidenceLine {
  const line: EvidenceLine = {
    ts: new Date().toISOString(),
    sig: null,
    program: null,
    ix: null,
    accounts: [],
    err: null,
    latency_ms: null,
    slot: null,
    notes: null,
    ...e,
    explorer_url: e.sig ? txUrl(e.sig, e.layer) : null,
  };
  mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
  appendFileSync(EVIDENCE_PATH, JSON.stringify(line) + "\n");
  return line;
}
