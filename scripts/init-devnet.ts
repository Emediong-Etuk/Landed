/**
 * pnpm init:devnet — one-time protocol setup on devnet (idempotent: skips
 * anything that already exists). Admin = deployer keypair.
 *   L1: initialize_config, initialize_escrow_and_treasury (pre-funds the fee payer),
 *       top up the action escrow, delegate escrow_auth + treasury ledger,
 *       create + delegate table 1, initialize the naive baseline
 *   ER: schedule the crank tick
 */
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { DEVNET_EU_VALIDATOR, LANDED_PROGRAM_ID, crankTaskId, ix, naiveIx, naivePda, pda } from "@landed/sdk";
import { client, loadKeypair, writeDeployments } from "../tests/devnet/lib";

const c = client("init");
const admin = loadKeypair();
const A = c.a;
const exists = async (k: import("@solana/web3.js").PublicKey) => !!(await c.l1.getAccountInfo(k));

console.log("admin", admin.publicKey.toBase58(), (await c.l1.getBalance(admin.publicKey)) / LAMPORTS_PER_SOL, "SOL");

if (!(await exists(A.config))) {
  await c.mustSend("L1", [ix.initializeConfig(A, admin.publicKey, {
    erValidator: DEVNET_EU_VALIDATOR, houseFeeBps: 200, minChip: 1_000_000n, maxChip: 25_000_000n, maxPerPlayerRound: 100_000_000n,
    minWithdraw: 1_000_000n, roundSecs: 20, vrfRetrySecs: 20, vrfVoidSecs: 150,
  })], [admin], "initialize_config");
}
if (!(await exists(A.escrowAuth))) {
  await c.mustSend("L1", [ix.initializeEscrowAndTreasury(A, admin.publicKey, BigInt(0.25 * LAMPORTS_PER_SOL))], [admin], "initialize_escrow_and_treasury");
}
const esc = await c.l1.getAccountInfo(A.escrow);
if (!esc || esc.lamports < 0.1 * LAMPORTS_PER_SOL) {
  await c.mustSend("L1", [ix.topUpEscrow(admin.publicKey, A.escrowAuth, BigInt(0.3 * LAMPORTS_PER_SOL))], [admin], "fund_action_escrow");
}
const DLP = "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh";
const owner = async (k: import("@solana/web3.js").PublicKey) => (await c.l1.getAccountInfo(k))?.owner.toBase58();
if ((await owner(A.escrowAuth)) !== DLP) await c.mustSend("L1", [ix.delegateEscrowAuth(A, admin.publicKey)], [admin], "delegate_escrow_auth");
if ((await owner(A.treasuryLedger)) !== DLP) await c.mustSend("L1", [ix.delegateLedger(A, admin.publicKey, A.treasury)], [admin], "delegate_treasury_ledger");
if (!(await exists(A.table))) await c.mustSend("L1", [ix.createTable(A, admin.publicKey, 1n)], [admin], "create_table");
if ((await owner(A.table)) !== DLP) await c.mustSend("L1", [ix.delegateTable(A, admin.publicKey, 1n)], [admin], "delegate_table");
if (!(await exists(naivePda.config()))) await c.mustSend("L1", [naiveIx.initialize(admin.publicKey, A.mint, DEVNET_EU_VALIDATOR)], [admin], "naive_initialize");

// Wait for the ER to see the delegated table, then schedule the crank (ER tx signed by admin).
await c.waitFor(async () => (await c.table("ER")) !== null, 60_000, 1000);
const sched = await c.send("ER", [ix.scheduleCrank(A, admin.publicKey)], [admin], "schedule_crank");
console.log("schedule_crank", sched.ok ? sched.sig : sched.err);

writeDeployments({
  validator: { identity: DEVNET_EU_VALIDATOR.toBase58(), endpoint: "https://devnet-eu.magicblock.app", version: "core 2.0.5" },
  addresses: {
    config: A.config.toBase58(), mint: A.mint.toBase58(), vault: A.vault.toBase58(), vault_auth: A.vaultAuth.toBase58(),
    escrow_auth_fee_payer: A.escrowAuth.toBase58(), action_escrow: A.escrow.toBase58(), magic_fee_vault: A.feeVault.toBase58(),
    treasury: A.treasury.toBase58(), treasury_ledger: A.treasuryLedger.toBase58(), table: A.table.toBase58(),
    naive_config: naivePda.config().toBase58(), naive_vault: naivePda.vault().toBase58(),
    vrf_identity: pda.vrfIdentity().toBase58(), vrf_callback_identity: pda.vrfCallbackIdentity().toBase58(),
  },
  crank: { task_id: crankTaskId(LANDED_PROGRAM_ID.toBytes(), A.table.toBytes()).toString(), schedule_sig: sched.ok ? sched.sig : null, schedule_err: sched.ok ? null : sched.err },
  admin: admin.publicKey.toBase58(),
});
console.log("init complete");
