//! Baseline program sanity: the naive pattern pays when nothing fails.
mod common;
use common::*;
use naive_cashout::{accounts as na, instruction as ni};

#[test]
fn naive_happy_path_and_fault_behavior_in_magicsvm() {
    let mut h = H::new();
    let admin = clone_kp(&h.admin);
    let nconfig = anchor_lang::prelude::Pubkey::find_program_address(&[b"nconfig"], &naive_cashout::ID).0;
    let nvault = anchor_lang::prelude::Pubkey::find_program_address(&[b"nvault"], &naive_cashout::ID).0;
    let nauth = anchor_lang::prelude::Pubkey::find_program_address(&[b"nvault_auth"], &naive_cashout::ID).0;
    let init = ix_for(naive_cashout::ID, ni::Initialize { er_validator: h.validator }, na::Initialize {
        admin: kp_pk(&admin), config: nconfig, mint: h.mint, vault: nvault, vault_auth: nauth, token_program: TOKEN, system_program: SYSTEM,
    });
    h.ok(L1, &[&admin], &[init], "naive init");
    let p = h.player(10 * D); // has 90 dUSDC left in wallet
    let nledger = anchor_lang::prelude::Pubkey::find_program_address(&[b"nledger", p.pk.as_ref()], &naive_cashout::ID).0;
    let fund = ix_for(naive_cashout::ID, ni::Fund { amount: 30 * D }, na::Fund {
        owner: p.pk, config: nconfig, ledger: nledger, mint: h.mint, owner_ata: ata(&p.pk, &h.mint), vault: nvault,
        token_program: TOKEN, associated_token_program: ATA_PROGRAM, system_program: SYSTEM,
    });
    use ephemeral_rollups_sdk::pda::*;
    let del = ix_for(naive_cashout::ID, ni::DelegateLedger {}, na::DelegateLedger {
        owner: p.pk, config: nconfig,
        buffer_pda: delegate_buffer_pda_from_delegated_account_and_owner_program(&nledger, &naive_cashout::ID),
        delegation_record_pda: delegation_record_pda_from_delegated_account(&nledger),
        delegation_metadata_pda: delegation_metadata_pda_from_delegated_account(&nledger),
        pda: nledger, owner_program: naive_cashout::ID, delegation_program: DLP, system_program: SYSTEM,
    });
    let escrow = ephemeral_balance_pda_from_payer(&p.pk, 255);
    let top = top_up_escrow_ix(p.pk, p.pk, escrow, 10_000_000);
    h.ok(L1, &[&p.kp], &[fund, del, top], "fund+delegate");
    let co = |amount: u64, fault: bool| ix_for(naive_cashout::ID, ni::CashOut { amount, inject_fault: fault }, na::CashOut {
        owner: p.pk, ledger: nledger, config: nconfig, program: naive_cashout::ID,
        magic_program: ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID, magic_context: ephemeral_rollups_sdk::consts::MAGIC_CONTEXT_ID,
    });
    h.ok(ER, &[&p.kp], &[co(10 * D, false)], "naive cash out");
    assert_eq!(h.token_balance(&ata(&p.pk, &h.mint)), 70 * D, "naive pays when nothing fails");
    // In MagicSVM a failing action reverts the ER tx; on devnet the committor drops it instead
    // (that is where funds strand: campaign C3).
    let f = h.fail(ER, &[&p.kp], &[co(10 * D, true)], "naive fault");
    assert!(f.has("InjectedFault") || f.has("6001"), "{}", f.logs);
}
