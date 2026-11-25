/**
 * pnpm deploy:devnet — deploys `landed` (fault-lab build) and `naive_cashout`
 * to devnet with the deployer keypair, then records sigs + hashes in
 * deployments/devnet.json and evidence/ledger.jsonl.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { recordEvidence } from "@landed/sdk/evidence";
import { ROOT, writeDeployments } from "../tests/devnet/lib";

const SOLANA = `${homedir()}/.local/share/solana/install/active_release/bin/solana`;
const url = process.env.LANDED_L1_RPC ?? "https://api.devnet.solana.com";
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const out: Record<string, unknown> = {};

for (const [name, kp] of [["landed", "landed-keypair.json"], ["naive_cashout", "naive_cashout-keypair.json"]] as const) {
  const so = resolve(ROOT, `target/deploy/${name}.so`);
  const t0 = Date.now();
  const res = execFileSync(SOLANA, ["program", "deploy", so, "--program-id", resolve(ROOT, `target/deploy/${kp}`), "-u", url, "--output", "json", "--with-compute-unit-price", "1000"], { encoding: "utf8" });
  const j = JSON.parse(res.slice(res.indexOf("{")));
  const sig = j.signature ?? null;
  console.log(`${name}: ${j.programId} sig=${sig}`);
  recordEvidence({ campaign: "deploy", step: `deploy_${name}`, layer: "L1", sig, ok: true, program: j.programId, latency_ms: Date.now() - t0, notes: `so sha256 ${sha(so)}` });
  out[name] = { program_id: j.programId, deploy_sig: sig, so_sha256: sha(so), idl_sha256: sha(resolve(ROOT, `target/idl/${name}.json`)) };
}
const git = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
const ver = (cmd: string, args: string[]) => { try { return execFileSync(cmd, args, { encoding: "utf8" }).trim(); } catch { return null; } };
writeDeployments({
  cluster: "devnet",
  programs: out,
  git_commit: git,
  versions: { solana: ver(SOLANA, ["--version"]), anchor: ver("anchor", ["--version"]), "ephemeral-rollups-sdk": "0.18.0", "session-keys": "3.1.1" },
  deployed_at: new Date().toISOString(),
});
