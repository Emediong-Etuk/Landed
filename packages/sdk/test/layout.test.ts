import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { decodeConfig, decodeLedger, decodeTable, decodeWithdrawReceipt, orderedHistory } from "../src/layout";
import { fromHex, hex } from "../src/core";

const fx = JSON.parse(readFileSync(new URL("./fixtures/accounts.json", import.meta.url), "utf8"));
const e = fx.expect;

describe("decoders match bytes produced by the real program (MagicSVM dump)", () => {
  it("Ledger (ER) and its committed L1 copy", () => {
    for (const k of ["ledger_er", "ledger_l1"]) {
      const l = decodeLedger(fromHex(fx[k]));
      expect(l.owner.toBase58()).toBe(e.ledger_owner);
      expect(l.withdrawNonce.toString()).toBe(e.withdraw_nonce);
      expect(l.ring[0].amount.toString()).toBe(e.ring0_amount);
      expect(l.ring[0].fault).toBe(e.ring0_fault);
    }
    const l = decodeLedger(fromHex(fx.ledger_er));
    expect(l.available.toString()).toBe(e.available);
    expect(l.ingestedTotal.toString()).toBe(e.ingested_total);
    expect(l.withdrawRequestedTotal.toString()).toBe(e.withdraw_requested_total);
    expect(l.ring[0].state).toBe(e.ring0_state);
    expect(l.stats.rounds.toString()).toBe(e.stats_rounds);
    expect(l.stats.wagered.toString()).toBe(e.stats_wagered);
  });
  it("Table (zero-copy)", () => {
    const t = decodeTable(fromHex(fx.table_er));
    expect(t.roundId.toString()).toBe(e.table_round_id);
    expect(t.pot.toString()).toBe(e.table_pot);
    expect(t.status).toBe(e.table_status);
    expect(t.entryCount).toBe(e.table_entry_count);
    expect(t.roundsSettled.toString()).toBe(e.table_rounds_settled);
    expect(t.historyLen.toString()).toBe(e.table_history_len);
    expect(t.roundSecs).toBe(e.table_round_secs);
    expect(t.vrfVoidSecs).toBe(e.table_void_secs);
    expect(t.crankTaskId.toString()).toBe(e.table_crank_task_id);
    expect(t.entries[0].player.toBase58()).toBe(e.table_entry0);
    const h0 = orderedHistory(t)[0];
    expect(h0.winner.toBase58()).toBe(e.h0_winner);
    expect(h0.pot.toString()).toBe(e.h0_pot);
    expect(h0.fee.toString()).toBe(e.h0_fee);
    expect(hex(h0.randomness)).toBe(e.h0_randomness);
    expect(hex(h0.entriesHash)).toBe(e.h0_entries_hash);
  });
  it("WithdrawReceipt + Config", () => {
    const r = decodeWithdrawReceipt(fromHex(fx.receipt));
    expect(r.amount.toString()).toBe(e.receipt_amount);
    expect(r.path).toBe(e.receipt_path);
    expect(r.rescuer.toBase58()).toBe(e.receipt_rescuer);
    const c = decodeConfig(fromHex(fx.config));
    expect(c.houseFeeBps).toBe(200);
    expect(c.faultLab).toBe(true);
  });
});
