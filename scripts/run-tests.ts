/**
 * pnpm test:all — runs every test layer and records real counts in
 * evidence/tests/summary.json (consumed by evidence:summarize / TEST_REPORT).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
interface Row { layer: string; cmd: string; tests: number; passed: number; failed: number; skipped: number; ok: boolean; seconds: number }
const rows: Row[] = [];

function run(layer: string, cmd: string, cwd: string, kind: "cargo" | "vitest") {
  const t0 = Date.now();
  const r = spawnSync("bash", ["-lc", cmd], { cwd: resolve(ROOT, cwd), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  let passed = 0, failed = 0, skipped = 0;
  if (kind === "cargo") {
    for (const m of out.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/g)) { passed += +m[1]; failed += +m[2]; skipped += +m[3]; }
  } else {
    const m = out.match(/Tests\s+(?:(\d+) failed \| )?(\d+) passed(?: \| (\d+) skipped)?/);
    if (m) { failed = +(m[1] ?? 0); passed = +m[2]; skipped = +(m[3] ?? 0); }
  }
  const row = { layer, cmd, tests: passed + failed, passed, failed, skipped, ok: r.status === 0, seconds: Math.round((Date.now() - t0) / 1000) };
  rows.push(row);
  console.log(`${row.ok ? "PASS" : "FAIL"} ${layer}: ${passed}/${row.tests} (${row.seconds}s)`);
  if (!row.ok) console.log(out.split("\n").filter((l) => /FAIL|panicked|error/i.test(l)).slice(0, 20).join("\n"));
}

run("landed-core: unit + property + fairness (Rust)", "cargo test -p landed-core --release", ".", "cargo");
run("landed program: unit (sizes, syscall hashing)", "cargo test -p landed --lib", ".", "cargo");
run("program integration on MagicSVM (Rust)", "cargo test", "tests/magicsvm", "cargo");
run("sdk: golden vectors, decoders, tracker (TS)", "npx vitest run", "packages/sdk", "vitest");
run("verifier: tamper fixtures (TS)", "npx vitest run", "packages/verifier", "vitest");
run("app: unit (TS)", "npx vitest run", "app", "vitest");

mkdirSync(resolve(ROOT, "evidence/tests"), { recursive: true });
writeFileSync(resolve(ROOT, "evidence/tests/summary.json"), JSON.stringify({ ran_at: new Date().toISOString(), rows }, null, 2));
process.exit(rows.every((r) => r.ok) ? 0 : 1);
