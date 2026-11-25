/**
 * Generates the instruction table in docs/ARCHITECTURE.md from the IDL
 * (accounts + args) plus the annotations below (layer, signer, checks, events, errors).
 * Run: pnpm tsx scripts/gen-ix-table.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const idl = JSON.parse(readFileSync(resolve(ROOT, "target/idl/landed.json"), "utf8"));
type A = { layer: "L1" | "ER" | "L1 (action)"; signer: string; checks: string; events?: string; errors?: string };
const ann: Record<string, A> = {
  initialize_config: { layer: "L1", signer: "admin", checks: "param bounds (fee ≤ 10%, void > 120 s), PDA mint/vault authorities", errors: "InvalidConfig" },
  initialize_escrow_and_treasury: { layer: "L1", signer: "admin", checks: "config.admin; pre-funds fee payer" },
  delegate_escrow_auth: { layer: "L1", signer: "admin", checks: "validator pinned to config.er_validator" },
  create_table: { layer: "L1", signer: "admin", checks: "snapshot of config timers/fee; derived crank task id" },
  delegate_table: { layer: "L1", signer: "admin", checks: "validator pinned" },
  set_flags: { layer: "L1", signer: "admin", checks: "pause/close-only only; cannot block exits", errors: "Unauthorized" },
  propose_admin: { layer: "L1", signer: "admin", checks: "two-step rotation" },
  accept_admin: { layer: "L1", signer: "pending admin", checks: "address == pending_admin" },
  init_user: { layer: "L1", signer: "owner", checks: "PDA init (UserMeta, Ledger)" },
  faucet: { layer: "L1", signer: "owner", checks: "100 dUSDC, ≥ 6 h cooldown, lifetime cap 1,000", errors: "FaucetCooldown, FaucetCapReached" },
  deposit: { layer: "L1", signer: "owner", checks: "!paused, amount > 0, receipt PDA init at deposit_count", events: "Deposited", errors: "Paused, AmountTooSmall" },
  delegate_ledger: { layer: "L1", signer: "anyone (payer)", checks: "validator pinned to config" },
  settle_withdraw: { layer: "L1 (action)", signer: "DLP-signed escrow", checks: "escrow signer == balance PDA of OUR escrow_auth; source_program == crate; committed ledger PDA/owner/discriminator; Pending entry; receipt init; vault ≥ amount", events: "WithdrawPaid{path:Action}", errors: "Unauthorized, InvalidLedger, NotPending, VaultInsufficient, InjectedFault (devnet)" },
  finalize_withdraw: { layer: "L1", signer: "anyone (rescuer pays rent)", checks: "same committed-ledger checks; receipt init (fails if paid); pays OWNER's ATA", events: "WithdrawPaid{path:Rescue}", errors: "InvalidLedger, NotPending, ConstraintTokenOwner" },
  set_session: { layer: "ER", signer: "owner", checks: "expiry ≤ 24 h; resets spent", errors: "InvalidSession" },
  clear_session: { layer: "ER", signer: "owner", checks: "—" },
  ingest_deposit: { layer: "ER", signer: "anyone", checks: "n == ingested_count; receipt PDA/owner/discriminator", events: "DepositIngested", errors: "OutOfOrder, InvalidReceipt" },
  request_withdraw: { layer: "ER", signer: "owner or session", checks: "≥ min, ≤ available, ring slot reusable; destination fixed; commit + post-commit action via fee payer", events: "WithdrawRequested", errors: "RingFull, InsufficientBalance, FaultLabDisabled" },
  request_commit: { layer: "ER", signer: "anyone", checks: "oldest Pending ≥ 5 s old (anti fee-burn)", events: "CommitForced", errors: "NothingPending, CommitTooEarly" },
  ack_withdrawal: { layer: "ER", signer: "anyone", checks: "receipt PDA/owner/amount/nonce match Pending slot", events: "WithdrawAcked", errors: "InvalidReceipt, NotPending" },
  enter_round: { layer: "ER", signer: "owner or session", checks: "!paused, !close_only, chip bounds, per-player cap, 32 players, session cap+expiry+SessionTokenV2", events: "Entered", errors: "RoundClosed, PlayerCapExceeded, TableFull, SessionCapExceeded" },
  leave_solo: { layer: "ER", signer: "owner or session", checks: "only entrant; Open", events: "SoloLeft", errors: "NotSolo" },
  close_round: { layer: "ER", signer: "anyone / crank (no signer)", checks: "time-checked tick: close+VRF when due, retry when due, else no-op; closed_by from instructions sysvar", events: "RoundClosed, RoundExtended, VrfRetried" },
  retry_vrf: { layer: "ER", signer: "anyone", checks: "AwaitingVrf, ≥ 20 s since last request, < 3 attempts, before void", events: "VrfRetried", errors: "RetryTooEarly, RetryExhausted" },
  vrf_callback: { layer: "ER", signer: "scoped VRF identity", checks: "status/round/nonce must match, else stale no-op", events: "RoundDrawn, StaleCallbackIgnored" },
  settle_round: { layer: "ER", signer: "anyone", checks: "Drawn; winner ledger == entries[winner_idx]; fee exact; commits table", events: "RoundSettled", errors: "AlreadySettled, NotDrawn, WrongWinner" },
  void_round: { layer: "ER", signer: "anyone", checks: "AwaitingVrf ≥ 150 s; every entrant ledger in order; all-or-nothing", events: "RoundVoided", errors: "VoidTooEarly, BadRefundAccounts" },
  schedule_crank: { layer: "ER", signer: "admin", checks: "derived task id; close_round with no signer metas" },
  process_undelegation: { layer: "L1", signer: "delegation program", checks: "injected by #[ephemeral]" },
};

const rows = idl.instructions.map((ix: { name: string; accounts: { name: string }[]; args: { name: string }[] }) => {
  const a = ann[ix.name];
  if (!a) throw new Error(`missing annotation for ${ix.name}`);
  return `| \`${ix.name}\`(${ix.args.map((x) => x.name).join(", ")}) | ${a.layer} | ${a.signer} | ${ix.accounts.map((x) => x.name).join(", ")} | ${a.checks} | ${a.events ?? "—"} | ${a.errors ?? "—"} |`;
});
const table = ["| Instruction | Layer | Signer | Accounts | State checks | Events | Errors |", "|---|---|---|---|---|---|---|", ...rows].join("\n");
const p = resolve(ROOT, "docs/ARCHITECTURE.md");
const doc = readFileSync(p, "utf8");
const out = doc.replace(/<!-- IX-TABLE:START -->[\s\S]*<!-- IX-TABLE:END -->/, `<!-- IX-TABLE:START -->\n${table}\n<!-- IX-TABLE:END -->`);
writeFileSync(p, out);
console.log(`instruction table: ${rows.length} instructions`);
