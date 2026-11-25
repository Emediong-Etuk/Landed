# Reusing the Landed settlement pattern in your MagicBlock game

**Problem.** "Base-layer custody + post-commit payout" is the recommended way to pay players from an Ephemeral Rollup. But a Magic Action is not atomic with the commit across retries: if the action fails, the committor removes it and re-commits without it. Your ER says the player was paid; Solana says they weren't. Nobody gets an error.

**Pattern.** Make the payout *recoverable by anyone* and *payable at most once*.

## The five rules

1. **Record before you pay.** In the ER, debit the balance and write `{nonce, amount, Pending}` into a fixed-size ring in the delegated account. `exit()` the account, *then* schedule `commit(ledger) + post-commit action(owner, nonce)`.
2. **Pay only from committed state.** The L1 payout reads the *committed* account (owner = delegation program while delegated): check PDA, owner, discriminator, deserialize, find the Pending entry. Amount and destination never come from instruction args.
3. **Exactly-once by PDA `init`.** Paying creates `Receipt[owner, nonce]` with `init`. A second payer fails on "already in use".
4. **Two entrypoints, one payout.** `#[action] settle(...)` (escrow signer pinned to *your* escrow authority PDA + `source_program`) and a permissionless `rescue(owner, nonce)` that pays the **owner**, with the caller funding rent. Add `force_commit(owner)` (commit with no action, rate-limited) for the case where the commit itself is missing.
5. **Free slots only after you see the receipt.** `ack(owner, nonce)` reads the L1 receipt (cloned read-only into the ER) and marks the slot reusable. A full ring rejects new withdrawals instead of overwriting unpaid ones.

## Minimal code map (from `programs/landed/src/lib.rs`)

| Piece | Function |
|---|---|
| request | `request_withdraw` (ring write, `ledger.exit()`, `MagicIntentBundleBuilder…commit…add_post_commit_actions`) |
| fast path | `settle_withdraw` + `SettleWithdraw` context (escrow checks) |
| slow path | `finalize_withdraw` |
| committed read | `read_committed_pending` |
| commit-only | `request_commit` |
| slot release | `ack_withdrawal` |
| fee payer for > 10 commits | delegated `EscrowAuth` PDA + `.magic_fee_vault(...)` + `build_and_invoke_signed` |

## Checklist for your program

- [ ] Every delegated account is ≤ 10,240 bytes (`const` assert).
- [ ] The action handler requires `escrow` as a signer at the derived address, binds `escrow_auth` to your PDA, and pins `source_program`.
- [ ] No payout path accepts an amount or a destination as an argument.
- [ ] Receipt PDAs are `init` (never `init_if_needed`).
- [ ] Use a delegated fee payer + `magic_fee_vault`, or your players' 11th commit fails (`0xA0000000`).
- [ ] Your UI (and/or keeper) automatically rescues anything owed for more than a few seconds, and shows "rollup balance / wallet balance / on the way" separately.
- [ ] A verifier checks `vault == Σ deposits − Σ receipts` from L1 alone.

## Test it

`tests/magicsvm/tests/settlement.rs` runs the whole protocol in MagicSVM in ~15 s, including the injected-fault rescue (`sim-committor-drop` feature reproduces the live committor dropping a failed action).
