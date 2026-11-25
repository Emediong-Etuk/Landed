//! Shared MagicSVM harness for Landed integration tests.
//!
//! MagicSVM runs a base ledger and an ephemeral (ER) ledger in-process with the
//! real Delegation Program and Magic program, post-commit actions, VRF
//! fulfillment and 1.1.1-style cranks. See docs/DECISIONS.md.
#![allow(dead_code)]

use anchor_lang::{prelude::Pubkey, AccountDeserialize, InstructionData, ToAccountMetas};
use ephemeral_rollups_sdk::{
    consts::{MAGIC_CONTEXT_ID, MAGIC_PROGRAM_ID},
    pda::{
        delegate_buffer_pda_from_delegated_account_and_owner_program,
        delegation_metadata_pda_from_delegated_account, delegation_record_pda_from_delegated_account,
        ephemeral_balance_pda_from_payer, magic_fee_vault_pda_from_validator,
    },
};
use landed::{accounts as la, instruction as li, state::*};
use magicsvm::{MagicSVM, TransactionTarget};
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;
use std::path::PathBuf;

pub use TransactionTarget::{Base as L1, Ephemeral as ER};

pub const DLP: Pubkey = ephemeral_rollups_sdk::id();
pub const SYSTEM: Pubkey = anchor_lang::system_program::ID;
pub const TOKEN: Pubkey = anchor_spl::token::ID;
pub const ATA_PROGRAM: Pubkey = anchor_spl::associated_token::ID;
pub const SLOT_HASHES: Pubkey = anchor_lang::pubkey!("SysvarS1otHashes111111111111111111111111111");
pub const IX_SYSVAR: Pubkey = anchor_lang::pubkey!("Sysvar1nstructions1111111111111111111111111");
pub const VRF_PROGRAM: Pubkey = ephemeral_rollups_sdk::vrf::consts::VRF_PROGRAM_ID;
pub const EPH_QUEUE: Pubkey = ephemeral_rollups_sdk::vrf::consts::DEFAULT_EPHEMERAL_QUEUE;
pub const SESSION_PROGRAM: Pubkey = anchor_lang::pubkey!("KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5");
pub const D: u64 = 1_000_000; // 1 dUSDC
pub const ROUND_SECS: u32 = 20;
pub const RETRY_SECS: u32 = 20;
pub const VOID_SECS: u32 = 60; // short-timers build

pub fn addr(p: Pubkey) -> Address {
    Address::new_from_array(p.to_bytes())
}
pub fn pk(a: &Address) -> Pubkey {
    Pubkey::new_from_array(a.to_bytes())
}
pub fn kp_pk(k: &Keypair) -> Pubkey {
    pk(&k.pubkey())
}

pub fn program_so(name: &str) -> PathBuf {
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target");
    let v = base.join("sbf-variants").join(format!("{name}.so"));
    if v.exists() {
        v
    } else {
        base.join("deploy").join(format!("{name}.so"))
    }
}

pub fn ix(data: impl InstructionData, accounts: impl ToAccountMetas) -> Instruction {
    ix_for(landed::ID, data, accounts)
}
pub fn ix_for(program: Pubkey, data: impl InstructionData, accounts: impl ToAccountMetas) -> Instruction {
    Instruction {
        program_id: addr(program),
        accounts: accounts
            .to_account_metas(None)
            .into_iter()
            .map(|m| AccountMeta { pubkey: addr(m.pubkey), is_signer: m.is_signer, is_writable: m.is_writable })
            .collect(),
        data: data.data(),
    }
}

pub fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &landed::ID).0
}
pub fn ledger_pda(owner: &Pubkey) -> Pubkey {
    pda(&[LEDGER_SEED, owner.as_ref()])
}
pub fn user_pda(owner: &Pubkey) -> Pubkey {
    pda(&[USER_SEED, owner.as_ref()])
}
pub fn dep_pda(owner: &Pubkey, n: u64) -> Pubkey {
    pda(&[DEPOSIT_SEED, owner.as_ref(), &n.to_le_bytes()])
}
pub fn wdr_pda(owner: &Pubkey, n: u64) -> Pubkey {
    pda(&[WITHDRAW_SEED, owner.as_ref(), &n.to_le_bytes()])
}
pub fn table_pda(id: u64) -> Pubkey {
    pda(&[TABLE_SEED, &id.to_le_bytes()])
}
pub fn ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    anchor_spl::associated_token::get_associated_token_address(owner, mint)
}

#[derive(Debug)]
pub struct Fail {
    pub err: TransactionError,
    pub logs: String,
}
impl Fail {
    pub fn has(&self, s: &str) -> bool {
        self.logs.contains(s) || format!("{:?}", self.err).contains(s)
    }
}

pub struct H {
    pub svm: MagicSVM,
    pub admin: Keypair,
    pub validator: Pubkey,
    pub config: Pubkey,
    pub mint: Pubkey,
    pub mint_auth: Pubkey,
    pub vault: Pubkey,
    pub vault_auth: Pubkey,
    pub escrow_auth: Pubkey,
    pub escrow: Pubkey,
    pub treasury: Pubkey,
    pub treasury_ledger: Pubkey,
    pub fee_vault: Pubkey,
    pub table: Pubkey,
    pub table_id: u64,
    pub void_secs: u32,
}

pub struct Player {
    pub kp: Keypair,
    pub pk: Pubkey,
    pub ledger: Pubkey,
}

impl H {
    pub fn new() -> Self {
        Self::with_program("landed_test")
    }

    pub fn with_program(so: &str) -> Self {
        let mut svm = MagicSVM::new();
        svm.add_program_from_file(addr(landed::ID), program_so(so)).expect("load landed");
        if program_so("naive_cashout").exists() {
            svm.add_program_from_file(addr(naive_cashout::ID), program_so("naive_cashout")).expect("load naive");
        }
        let admin = Keypair::new();
        svm.airdrop(&admin.pubkey(), 100_000_000_000).unwrap();
        let validator = pk(&svm.validator_identity());
        // Realistic wall clock (MagicSVM starts at unix_timestamp 0).
        let mut c = svm.base().get_sysvar::<solana_clock::Clock>();
        c.unix_timestamp = 1_764_000_000;
        svm.set_sysvar(&c);
        let short = so.starts_with("landed_test");
        let mut h = H {
            svm,
            admin,
            validator,
            config: pda(&[CONFIG_SEED]),
            mint: pda(&[MINT_SEED]),
            mint_auth: pda(&[MINT_AUTH_SEED]),
            vault: pda(&[VAULT_SEED]),
            vault_auth: pda(&[VAULT_AUTH_SEED]),
            escrow_auth: pda(&[ESCROW_AUTH_SEED]),
            escrow: Pubkey::default(),
            treasury: pda(&[TREASURY_SEED]),
            treasury_ledger: Pubkey::default(),
            fee_vault: magic_fee_vault_pda_from_validator(&validator),
            table: table_pda(1),
            table_id: 1,
            void_secs: if short { VOID_SECS } else { 150 },
        };
        h.escrow = ephemeral_balance_pda_from_payer(&h.escrow_auth, ACTION_ESCROW_INDEX);
        h.treasury_ledger = ledger_pda(&h.treasury);
        h.bootstrap();
        h
    }

    fn bootstrap(&mut self) {
        let admin = kp_pk(&self.admin);
        let params = landed::ConfigParams {
            er_validator: self.validator,
            house_fee_bps: 200,
            min_chip: D,
            max_chip: 25 * D,
            max_per_player_round: 100 * D,
            min_withdraw: D,
            round_secs: ROUND_SECS,
            vrf_retry_secs: RETRY_SECS,
            vrf_void_secs: self.void_secs,
        };
        let i1 = ix(
            li::InitializeConfig { params },
            la::InitializeConfig {
                admin,
                config: self.config,
                mint: self.mint,
                mint_auth: self.mint_auth,
                vault: self.vault,
                vault_auth: self.vault_auth,
                token_program: TOKEN,
                system_program: SYSTEM,
            },
        );
        let i2 = ix(
            li::InitializeEscrowAndTreasury { fee_payer_lamports: 2_000_000_000 },
            la::InitializeEscrowAndTreasury {
                admin,
                config: self.config,
                escrow_auth: self.escrow_auth,
                treasury_ledger: self.treasury_ledger,
                system_program: SYSTEM,
            },
        );
        self.ok(L1, &[&clone_kp(&self.admin)], &[i1, i2], "init");
        // Fund the action escrow (rent for receipts / ATAs created by the payout action).
        let topup = top_up_escrow_ix(admin, self.escrow_auth, self.escrow, 1_000_000_000);
        let d1 = self.delegate_escrow_ix();
        let d2 = self.delegate_ledger_ix(admin, self.treasury);
        self.ok(L1, &[&clone_kp(&self.admin)], &[topup, d1, d2], "escrow+delegations");
        let ct = ix(li::CreateTable { id: 1 }, la::CreateTable { admin, config: self.config, table: self.table, system_program: SYSTEM });
        let dt = ix(
            li::DelegateTable { id: 1 },
            la::DelegateTable {
                admin,
                config: self.config,
                buffer_pda: delegate_buffer_pda_from_delegated_account_and_owner_program(&self.table, &landed::ID),
                delegation_record_pda: delegation_record_pda_from_delegated_account(&self.table),
                delegation_metadata_pda: delegation_metadata_pda_from_delegated_account(&self.table),
                pda: self.table,
                owner_program: landed::ID,
                delegation_program: DLP,
                system_program: SYSTEM,
            },
        );
        self.ok(L1, &[&clone_kp(&self.admin)], &[ct, dt], "table");
    }

    pub fn delegate_escrow_ix(&self) -> Instruction {
        ix(
            li::DelegateEscrowAuth {},
            la::DelegateEscrowAuth {
                admin: kp_pk(&self.admin),
                config: self.config,
                buffer_pda: delegate_buffer_pda_from_delegated_account_and_owner_program(&self.escrow_auth, &landed::ID),
                delegation_record_pda: delegation_record_pda_from_delegated_account(&self.escrow_auth),
                delegation_metadata_pda: delegation_metadata_pda_from_delegated_account(&self.escrow_auth),
                pda: self.escrow_auth,
                owner_program: landed::ID,
                delegation_program: DLP,
                system_program: SYSTEM,
            },
        )
    }

    pub fn delegate_ledger_ix(&self, payer: Pubkey, owner: Pubkey) -> Instruction {
        let l = ledger_pda(&owner);
        ix(
            li::DelegateLedger {},
            la::DelegateLedger {
                payer,
                owner,
                config: self.config,
                buffer_pda: delegate_buffer_pda_from_delegated_account_and_owner_program(&l, &landed::ID),
                delegation_record_pda: delegation_record_pda_from_delegated_account(&l),
                delegation_metadata_pda: delegation_metadata_pda_from_delegated_account(&l),
                pda: l,
                owner_program: landed::ID,
                delegation_program: DLP,
                system_program: SYSTEM,
            },
        )
    }

    // ---------------------------------------------------------------- tx helpers

    pub fn send(&mut self, target: TransactionTarget, signers: &[&Keypair], ixs: &[Instruction]) -> Result<(), Fail> {
        let bh = self.svm.latest_blockhash_for(target);
        let tx = Transaction::new(signers, Message::new(ixs, Some(&signers[0].pubkey())), bh);
        let r = self.svm.send_transaction_to(target, tx);
        self.svm.expire_blockhash_for(target);
        r.map(|_| ()).map_err(|f| Fail { err: f.err, logs: f.meta.logs.join("\n") })
    }

    pub fn ok(&mut self, target: TransactionTarget, signers: &[&Keypair], ixs: &[Instruction], label: &str) {
        if let Err(f) = self.send(target, signers, ixs) {
            panic!("{label} failed on {target:?}: {:?}\n{}", f.err, f.logs);
        }
    }

    pub fn fail(&mut self, target: TransactionTarget, signers: &[&Keypair], ixs: &[Instruction], label: &str) -> Fail {
        match self.send(target, signers, ixs) {
            Ok(()) => panic!("{label}: expected failure but succeeded"),
            Err(f) => f,
        }
    }

    // ---------------------------------------------------------------- time

    pub fn now(&self) -> i64 {
        self.svm.base().get_sysvar::<solana_clock::Clock>().unix_timestamp
    }
    pub fn slot(&self) -> u64 {
        self.svm.base().get_sysvar::<solana_clock::Clock>().slot
    }
    pub fn set_time(&mut self, ts: i64) {
        let mut c = self.svm.base().get_sysvar::<solana_clock::Clock>();
        c.unix_timestamp = ts;
        self.svm.set_sysvar(&c);
    }
    pub fn advance(&mut self, secs: i64) {
        let t = self.now() + secs;
        self.set_time(t);
    }
    /// Run due VRF fulfillments / cranks (next slot), keeping wall-clock time.
    pub fn tick_slot(&mut self) -> usize {
        let t = self.now();
        let s = self.slot();
        let n = self.svm.warp_to_slot(s + 1).len();
        self.set_time(t);
        n
    }

    // ---------------------------------------------------------------- reads

    pub fn ledger(&self, target: TransactionTarget, owner: &Pubkey) -> Ledger {
        let a = self.svm.get_account_for(target, &addr(ledger_pda(owner))).expect("ledger missing");
        Ledger::try_deserialize(&mut &a.data[..]).expect("ledger decode")
    }
    pub fn table(&self) -> Table {
        let a = self.svm.get_account_for(ER, &addr(self.table)).expect("table missing");
        *bytemuck::from_bytes::<Table>(&a.data[8..8 + std::mem::size_of::<Table>()])
    }
    pub fn table_l1(&self) -> Table {
        let a = self.svm.get_account_for(L1, &addr(self.table)).expect("table missing");
        *bytemuck::from_bytes::<Table>(&a.data[8..8 + std::mem::size_of::<Table>()])
    }
    pub fn token_balance(&self, account: &Pubkey) -> u64 {
        match self.svm.get_account_for(L1, &addr(*account)) {
            Some(a) if a.data.len() >= 72 => u64::from_le_bytes(a.data[64..72].try_into().unwrap()),
            _ => 0,
        }
    }
    pub fn exists(&self, target: TransactionTarget, k: &Pubkey) -> bool {
        self.svm.get_account_for(target, &addr(*k)).is_some_and(|a| a.lamports > 0)
    }
    pub fn receipt(&self, owner: &Pubkey, n: u64) -> Option<WithdrawReceipt> {
        let a = self.svm.get_account_for(L1, &addr(wdr_pda(owner, n)))?;
        if a.lamports == 0 {
            return None;
        }
        WithdrawReceipt::try_deserialize(&mut &a.data[..]).ok()
    }
    pub fn vault_balance(&self) -> u64 {
        self.token_balance(&self.vault)
    }

    // ---------------------------------------------------------------- players

    /// Fresh player: init_user + faucet + deposit(amount) + delegate on L1, then ingest in the ER.
    pub fn player(&mut self, deposit: u64) -> Player {
        let kp = Keypair::new();
        self.svm.airdrop(&kp.pubkey(), 5_000_000_000).unwrap();
        let p = kp_pk(&kp);
        let ixs = vec![self.init_user_ix(p), self.faucet_ix(p), self.deposit_ix(p, 0, deposit), self.delegate_ledger_ix(p, p)];
        self.ok(L1, &[&kp], &ixs, "onboard");
        let pl = Player { pk: p, ledger: ledger_pda(&p), kp };
        self.ok(ER, &[&pl.kp], &[self.ingest_ix(p, 0)], "ingest");
        pl
    }

    pub fn init_user_ix(&self, owner: Pubkey) -> Instruction {
        ix(li::InitUser {}, la::InitUser { owner, user_meta: user_pda(&owner), ledger: ledger_pda(&owner), system_program: SYSTEM })
    }
    pub fn faucet_ix(&self, owner: Pubkey) -> Instruction {
        ix(
            li::Faucet {},
            la::Faucet {
                owner,
                config: self.config,
                user_meta: user_pda(&owner),
                mint: self.mint,
                mint_auth: self.mint_auth,
                owner_ata: ata(&owner, &self.mint),
                token_program: TOKEN,
                associated_token_program: ATA_PROGRAM,
                system_program: SYSTEM,
            },
        )
    }
    pub fn deposit_ix(&self, owner: Pubkey, n: u64, amount: u64) -> Instruction {
        ix(
            li::Deposit { amount },
            la::Deposit {
                owner,
                config: self.config,
                user_meta: user_pda(&owner),
                receipt: dep_pda(&owner, n),
                mint: self.mint,
                owner_ata: ata(&owner, &self.mint),
                vault: self.vault,
                token_program: TOKEN,
                system_program: SYSTEM,
            },
        )
    }
    pub fn ingest_ix(&self, owner: Pubkey, n: u64) -> Instruction {
        ix(li::IngestDeposit { nonce: n }, la::IngestDeposit { ledger: ledger_pda(&owner), receipt: dep_pda(&owner, n) })
    }
    pub fn request_withdraw_ix(&self, authority: Pubkey, owner: Pubkey, amount: u64, fault: bool, session: Option<Pubkey>) -> Instruction {
        ix(
            li::RequestWithdraw { amount, inject_fault: fault },
            la::RequestWithdraw {
                authority,
                ledger: ledger_pda(&owner),
                config: self.config,
                session_token: session,
                escrow_auth: self.escrow_auth,
                magic_fee_vault: self.fee_vault,
                program: landed::ID,
                magic_program: MAGIC_PROGRAM_ID,
                magic_context: MAGIC_CONTEXT_ID,
            },
        )
    }
    pub fn request_commit_ix(&self, owner: Pubkey) -> Instruction {
        ix(
            li::RequestCommit {},
            la::RequestCommit {
                ledger: ledger_pda(&owner),
                config: self.config,
                escrow_auth: self.escrow_auth,
                magic_fee_vault: self.fee_vault,
                magic_program: MAGIC_PROGRAM_ID,
                magic_context: MAGIC_CONTEXT_ID,
            },
        )
    }
    pub fn finalize_ix(&self, rescuer: Pubkey, owner: Pubkey, n: u64) -> Instruction {
        self.finalize_ix_with(rescuer, owner, n, ata(&owner, &self.mint), ledger_pda(&owner))
    }
    pub fn finalize_ix_with(&self, rescuer: Pubkey, owner: Pubkey, n: u64, owner_ata: Pubkey, ledger: Pubkey) -> Instruction {
        ix(
            li::FinalizeWithdraw { owner, nonce: n },
            la::FinalizeWithdraw {
                rescuer,
                config: self.config,
                ledger,
                owner_account: owner,
                receipt: wdr_pda(&owner, n),
                owner_ata,
                mint: self.mint,
                vault: self.vault,
                vault_auth: self.vault_auth,
                token_program: TOKEN,
                associated_token_program: ATA_PROGRAM,
                system_program: SYSTEM,
            },
        )
    }
    /// A direct (non-action) call of the action handler, as an attacker would make it.
    pub fn settle_direct_ix(&self, owner: Pubkey, n: u64, escrow_auth: Pubkey, escrow: Pubkey) -> Instruction {
        ix(
            li::SettleWithdraw { owner, nonce: n },
            la::SettleWithdraw {
                config: self.config,
                ledger: ledger_pda(&owner),
                owner_account: owner,
                receipt: wdr_pda(&owner, n),
                owner_ata: ata(&owner, &self.mint),
                mint: self.mint,
                vault: self.vault,
                vault_auth: self.vault_auth,
                token_program: TOKEN,
                associated_token_program: ATA_PROGRAM,
                system_program: SYSTEM,
                source_program: landed::ID,
                escrow_auth,
                escrow,
            },
        )
    }
    pub fn ack_ix(&self, owner: Pubkey, n: u64) -> Instruction {
        ix(li::AckWithdrawal { nonce: n }, la::AckWithdrawal { ledger: ledger_pda(&owner), receipt: wdr_pda(&owner, n) })
    }
    pub fn set_session_ix(&self, owner: Pubkey, signer: Pubkey, cap: u64, expires: i64) -> Instruction {
        ix(li::SetSession { signer, cap, expires_ts: expires }, la::SetSession { owner, ledger: ledger_pda(&owner) })
    }
    pub fn enter_ix(&self, authority: Pubkey, owner: Pubkey, amount: u64, session: Option<Pubkey>) -> Instruction {
        ix(
            li::EnterRound { amount },
            la::EnterRound { authority, ledger: ledger_pda(&owner), table: self.table, config: self.config, session_token: session },
        )
    }
    pub fn leave_solo_ix(&self, authority: Pubkey, owner: Pubkey) -> Instruction {
        ix(li::LeaveSolo {}, la::LeaveSolo { authority, ledger: ledger_pda(&owner), table: self.table, session_token: None })
    }
    pub fn close_ix(&self, kind: u8) -> Instruction {
        ix(
            li::CloseRound { caller_kind: kind },
            la::CloseRound {
                table: self.table,
                oracle_queue: EPH_QUEUE,
                instructions: IX_SYSVAR,
                program_identity: pda(&[b"identity"]),
                vrf_program: VRF_PROGRAM,
                slot_hashes: SLOT_HASHES,
                system_program: SYSTEM,
            },
        )
    }
    pub fn retry_ix(&self) -> Instruction {
        ix(
            li::RetryVrf {},
            la::RetryVrf {
                table: self.table,
                oracle_queue: EPH_QUEUE,
                program_identity: pda(&[b"identity"]),
                vrf_program: VRF_PROGRAM,
                slot_hashes: SLOT_HASHES,
                system_program: SYSTEM,
            },
        )
    }
    pub fn settle_round_ix(&self, round_id: u64, winner_owner: Pubkey) -> Instruction {
        ix(
            li::SettleRound { round_id },
            la::SettleRound {
                table: self.table,
                winner_ledger: ledger_pda(&winner_owner),
                treasury_ledger: self.treasury_ledger,
                config: self.config,
                escrow_auth: self.escrow_auth,
                magic_fee_vault: self.fee_vault,
                magic_program: MAGIC_PROGRAM_ID,
                magic_context: MAGIC_CONTEXT_ID,
            },
        )
    }
    pub fn void_ix(&self, round_id: u64, ledgers: &[Pubkey]) -> Instruction {
        let mut i = ix(li::VoidRound { round_id }, la::VoidRound { table: self.table });
        for l in ledgers {
            i.accounts.push(AccountMeta::new(addr(*l), false));
        }
        i
    }
    pub fn vrf_callback_ix(&self, identity: Pubkey, randomness: [u8; 32], round_id: u64, nonce: u64) -> Instruction {
        ix(li::VrfCallback { randomness, round_id, vrf_nonce: nonce }, la::VrfCallback { vrf_program_identity: identity, table: self.table })
    }

    /// Drive one full round: players enter, time passes, close, VRF, settle.
    pub fn play_round(&mut self, entrants: &[(&Player, u64)]) -> (u64, Pubkey) {
        for (p, amt) in entrants {
            let i = self.enter_ix(p.pk, p.pk, *amt, None);
            self.ok(ER, &[&p.kp], &[i], "enter");
        }
        self.advance(ROUND_SECS as i64 + 1);
        let c = self.close_ix(landed::state::closed_by::KEEPER);
        self.ok(ER, &[&entrants[0].0.kp], &[c], "close");
        self.tick_slot();
        let t = self.table();
        assert_eq!(t.status, table_status::DRAWN, "VRF callback should have drawn the round");
        let w = t.entries[t.winner_idx as usize].player;
        let rid = t.round_id;
        let s = self.settle_round_ix(rid, w);
        self.ok(ER, &[&entrants[0].0.kp], &[s], "settle");
        (rid, w)
    }

    /// Fake SessionTokenV2 account (session-keys program isn't loaded in MagicSVM;
    /// our program only reads the account, owned by the session program).
    pub fn put_session_token(&mut self, authority: Pubkey, signer: Pubkey, target: Pubkey, valid_until: i64, v1: bool) -> Pubkey {
        use anchor_lang::Discriminator;
        let key = Pubkey::new_unique();
        let mut data = Vec::new();
        if v1 {
            data.extend_from_slice(session_keys::SessionToken::DISCRIMINATOR);
            data.extend_from_slice(authority.as_ref());
            data.extend_from_slice(target.as_ref());
            data.extend_from_slice(signer.as_ref());
            data.extend_from_slice(&valid_until.to_le_bytes());
        } else {
            data.extend_from_slice(session_keys::SessionTokenV2::DISCRIMINATOR);
            data.extend_from_slice(authority.as_ref());
            data.extend_from_slice(target.as_ref());
            data.extend_from_slice(signer.as_ref());
            data.extend_from_slice(authority.as_ref()); // fee_payer
            data.extend_from_slice(&valid_until.to_le_bytes());
        }
        let acc = solana_account::Account { lamports: 10_000_000, data, owner: addr(SESSION_PROGRAM), executable: false, rent_epoch: 0 };
        self.svm.set_account(addr(key), acc).unwrap();
        key
    }
}

pub fn clone_kp(k: &Keypair) -> Keypair {
    Keypair::try_from(&k.to_bytes()[..]).unwrap()
}

/// DLP `TopUpEphemeralBalance`: funds `[b"balance", authority, index]`.
pub fn top_up_escrow_ix(payer: Pubkey, authority: Pubkey, escrow: Pubkey, lamports: u64) -> Instruction {
    use ephemeral_rollups_sdk::dlp_api::discriminator::DlpDiscriminator;
    let mut data = DlpDiscriminator::TopUpEphemeralBalance.to_vec();
    data.extend_from_slice(&lamports.to_le_bytes());
    data.push(ACTION_ESCROW_INDEX);
    Instruction {
        program_id: addr(DLP),
        accounts: vec![
            AccountMeta::new(addr(payer), true),
            AccountMeta::new_readonly(addr(authority), false),
            AccountMeta::new(addr(escrow), false),
            AccountMeta::new_readonly(addr(SYSTEM), false),
        ],
        data,
    }
}
