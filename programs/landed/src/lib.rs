//! # Landed: every win lands.
//!
//! A MagicBlock Ephemeral Rollup jackpot game ("The Drop") whose cash-outs are
//! **exactly-once and never lost**, even when the post-commit Magic Action that
//! normally pays them out fails (F1).
//!
//! * L1 (Solana) holds custody: dUSDC vault, deposit receipts, withdraw receipts.
//! * The ER holds game state: per-player `Ledger`s and the `Table`.
//! * Withdrawals are requested in the ER, committed to L1, and paid by a
//!   post-commit action **or** by a permissionless rescue that reads the
//!   *committed* ledger. Whichever lands first creates the unique
//!   `WithdrawReceipt` PDA; the other fails harmlessly.
//!
//! See `docs/SETTLEMENT_PATTERN.md` for the protocol and `docs/SECURITY.md` for
//! the threat model.

#![allow(unexpected_cfgs)]
#![allow(deprecated)]
#![allow(clippy::too_many_arguments)]
#![allow(clippy::result_large_err)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::Instruction, program::invoke_signed};
use solana_instructions_sysvar as ix_sysvar;
use anchor_lang::Discriminator;
use anchor_spl::associated_token::{get_associated_token_address, AssociatedToken};
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, TransferChecked};
use ephemeral_rollups_sdk::anchor::{action, commit, delegate, ephemeral, vrf, vrf_callback};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::crank::{ScheduleCrankCpi, ScheduleTaskArgs};
use ephemeral_rollups_sdk::ephem::{CallHandler, MagicIntentBundleBuilder};
use ephemeral_rollups_sdk::vrf::{
    consts::{program_identity_pda, IDENTITY},
    instructions::{create_request_randomness_ix_const, RequestRandomnessParams},
    types::SerializableAccountMeta,
};
use ephemeral_rollups_sdk::{ActionArgs, ShortAccountMeta};
use session_keys::SessionTokenV2;

pub mod errors;
pub mod events;
pub mod state;

use errors::LandedError;
use events::*;
use state::*;

declare_id!("37AZMxLPm9RY8AKQk4s4oMJaovpRorGQfUmMUbTxiqGq");

/// Delegation program (owner of every delegated account on L1).
pub const DELEGATION_PROGRAM_ID: Pubkey = ephemeral_rollups_sdk::id();
/// Hydra ephemeral crank program (validator 2.0 scheduler).
pub const HYDRA_EPHEMERAL_ID: Pubkey = pubkey!("eHyd5BU8QffvHi4GnXwxrK4WpS7pM2x9UGKHBWii7mf");
const VRF_IDENTITY: ([u8; 32], u8) = program_identity_pda(&crate::ID);
/// Crank tick interval. The crank only advances the round when it is due, so a
/// short tick bounds close latency without changing round length.
pub const CRANK_INTERVAL_MS: i64 = 2_000;
pub const CRANK_ITERATIONS: i64 = 10_000_000;
pub const ACTION_COMPUTE_UNITS: u32 = 200_000;

#[ephemeral]
#[program]
pub mod landed {
    use super::*;

    // =====================================================================
    // L1 — setup & admin
    // =====================================================================

    /// Creates Config, the dUSDC mint (PDA authority) and the vault.
    pub fn initialize_config(ctx: Context<InitializeConfig>, params: ConfigParams) -> Result<()> {
        params.validate()?;
        let c = &mut ctx.accounts.config;
        c.admin = ctx.accounts.admin.key();
        c.pending_admin = Pubkey::default();
        c.mint = ctx.accounts.mint.key();
        c.vault = ctx.accounts.vault.key();
        c.er_validator = params.er_validator;
        c.magic_fee_vault =
            ephemeral_rollups_sdk::pda::magic_fee_vault_pda_from_validator(&params.er_validator);
        let (treasury, tb) = Pubkey::find_program_address(&[TREASURY_SEED], &crate::ID);
        c.treasury = treasury;
        c.treasury_bump = tb;
        c.house_fee_bps = params.house_fee_bps;
        c.min_chip = params.min_chip;
        c.max_chip = params.max_chip;
        c.max_per_player_round = params.max_per_player_round;
        c.min_withdraw = params.min_withdraw;
        c.round_secs = params.round_secs;
        c.vrf_retry_secs = params.vrf_retry_secs;
        c.vrf_void_secs = params.vrf_void_secs;
        c.paused = false;
        c.close_only = false;
        c.fault_lab = cfg!(feature = "fault-lab");
        c.bump = ctx.bumps.config;
        c.mint_bump = ctx.bumps.mint;
        c.mint_auth_bump = ctx.bumps.mint_auth;
        c.vault_bump = ctx.bumps.vault;
        c.vault_auth_bump = ctx.bumps.vault_auth;
        let (_, eb) = Pubkey::find_program_address(&[ESCROW_AUTH_SEED], &crate::ID);
        c.escrow_auth_bump = eb;
        Ok(())
    }

    /// Creates the fee-payer/escrow-authority PDA and the treasury ledger,
    /// pre-funding the fee payer with `fee_payer_lamports` for ER commit fees.
    pub fn initialize_escrow_and_treasury(
        ctx: Context<InitializeEscrowAndTreasury>,
        fee_payer_lamports: u64,
    ) -> Result<()> {
        ctx.accounts.escrow_auth.bump = ctx.bumps.escrow_auth;
        let t = &mut ctx.accounts.treasury_ledger;
        t.owner = ctx.accounts.config.treasury;
        t.bump = ctx.bumps.treasury_ledger;
        if fee_payer_lamports > 0 {
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.key(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.admin.to_account_info(),
                        to: ctx.accounts.escrow_auth.to_account_info(),
                    },
                ),
                fee_payer_lamports,
            )?;
        }
        Ok(())
    }

    /// Delegates the fee payer / escrow authority to the configured ER validator.
    pub fn delegate_escrow_auth(ctx: Context<DelegateEscrowAuth>) -> Result<()> {
        ctx.accounts.delegate_pda(
            &ctx.accounts.admin,
            &[ESCROW_AUTH_SEED],
            DelegateConfig { validator: Some(ctx.accounts.config.er_validator), ..Default::default() },
        )?;
        Ok(())
    }

    pub fn create_table(ctx: Context<CreateTable>, id: u64) -> Result<()> {
        let c = &ctx.accounts.config;
        let mut t = ctx.accounts.table.load_init()?;
        t.id = id;
        t.round_id = 1;
        t.status = table_status::OPEN;
        t.treasury = c.treasury;
        t.round_secs = c.round_secs;
        t.vrf_retry_secs = c.vrf_retry_secs;
        t.vrf_void_secs = c.vrf_void_secs;
        t.house_fee_bps = c.house_fee_bps;
        t.crank_task_id =
            landed_core::crank_task_id(&crate::ID.to_bytes(), &ctx.accounts.table.key().to_bytes());
        t.bump = ctx.bumps.table;
        Ok(())
    }

    pub fn delegate_table(ctx: Context<DelegateTable>, id: u64) -> Result<()> {
        ctx.accounts.delegate_pda(
            &ctx.accounts.admin,
            &[TABLE_SEED, &id.to_le_bytes()],
            DelegateConfig { validator: Some(ctx.accounts.config.er_validator), ..Default::default() },
        )?;
        Ok(())
    }

    /// `paused` blocks entries + deposits; `close_only` blocks entries.
    /// Nothing here can block withdrawals, rescues, commits or acks.
    pub fn set_flags(ctx: Context<AdminOnly>, paused: bool, close_only: bool) -> Result<()> {
        let c = &mut ctx.accounts.config;
        c.paused = paused;
        c.close_only = close_only;
        Ok(())
    }

    pub fn propose_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        ctx.accounts.config.pending_admin = new_admin;
        Ok(())
    }

    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        let c = &mut ctx.accounts.config;
        c.admin = c.pending_admin;
        c.pending_admin = Pubkey::default();
        Ok(())
    }

    // =====================================================================
    // L1 — player onboarding
    // =====================================================================

    pub fn init_user(ctx: Context<InitUser>) -> Result<()> {
        let owner = ctx.accounts.owner.key();
        let m = &mut ctx.accounts.user_meta;
        m.owner = owner;
        m.bump = ctx.bumps.user_meta;
        let l = &mut ctx.accounts.ledger;
        l.owner = owner;
        l.bump = ctx.bumps.ledger;
        Ok(())
    }

    /// 100 dUSDC, at most once per 6 h, lifetime cap 1,000 (enforced on-chain).
    pub fn faucet(ctx: Context<Faucet>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let m = &mut ctx.accounts.user_meta;
        require!(
            m.faucet_total == 0 || now >= m.last_faucet_ts + FAUCET_COOLDOWN_SECS,
            LandedError::FaucetCooldown
        );
        let next = m.faucet_total.checked_add(FAUCET_AMOUNT).ok_or(LandedError::MathOverflow)?;
        require!(next <= FAUCET_LIFETIME_CAP, LandedError::FaucetCapReached);
        m.last_faucet_ts = now;
        m.faucet_total = next;
        let bump = ctx.accounts.config.mint_auth_bump;
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.owner_ata.to_account_info(),
                    authority: ctx.accounts.mint_auth.to_account_info(),
                },
                &[&[MINT_AUTH_SEED, &[bump]]],
            ),
            FAUCET_AMOUNT,
        )
    }

    /// Owner ATA → vault, and a unique, ordered `DepositReceipt`.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(!ctx.accounts.config.paused, LandedError::Paused);
        require!(amount > 0, LandedError::AmountTooSmall);
        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.owner_ata.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
            DUSDC_DECIMALS,
        )?;
        let clock = Clock::get()?;
        let m = &mut ctx.accounts.user_meta;
        let n = m.deposit_count;
        let r = &mut ctx.accounts.receipt;
        r.owner = m.owner;
        r.nonce = n;
        r.amount = amount;
        r.ts = clock.unix_timestamp;
        r.slot = clock.slot;
        r.bump = ctx.bumps.receipt;
        m.deposit_count = n.checked_add(1).ok_or(LandedError::MathOverflow)?;
        m.deposit_total = m.deposit_total.checked_add(amount).ok_or(LandedError::MathOverflow)?;
        emit!(Deposited { owner: m.owner, nonce: n, amount });
        Ok(())
    }

    /// Permissionless: delegates `["ledger", owner]` to the configured validator.
    pub fn delegate_ledger(ctx: Context<DelegateLedger>) -> Result<()> {
        let owner = ctx.accounts.owner.key();
        ctx.accounts.delegate_pda(
            &ctx.accounts.payer,
            &[LEDGER_SEED, owner.as_ref()],
            DelegateConfig { validator: Some(ctx.accounts.config.er_validator), ..Default::default() },
        )?;
        Ok(())
    }

    // =====================================================================
    // L1 — payouts (fast path: Magic Action; slow path: permissionless rescue)
    // =====================================================================

    /// Post-commit Magic Action. Callable ONLY through the delegation program
    /// (escrow signer pinned to our escrow authority, source program pinned).
    /// Amount and destination come exclusively from the *committed* ledger.
    pub fn settle_withdraw(ctx: Context<SettleWithdraw>, owner: Pubkey, nonce: u64) -> Result<()> {
        let entry = read_committed_pending(&ctx.accounts.ledger, &owner, nonce)?;
        #[cfg(feature = "fault-lab")]
        if entry.fault != 0 {
            msg!("fault-lab: injected payout failure for nonce {}", nonce);
            return err!(LandedError::InjectedFault);
        }
        let a = &ctx.accounts;
        pay_out(
            &a.config,
            &a.vault,
            &a.vault_auth,
            &a.mint,
            &a.owner_ata,
            &a.token_program,
            owner,
            nonce,
            entry.amount,
            pay_path::ACTION,
            Pubkey::default(),
        )?;
        ctx.accounts.receipt.set_inner(build_receipt(owner, nonce, entry.amount, a.owner_ata.key(), pay_path::ACTION, Pubkey::default(), ctx.bumps.receipt)?);
        Ok(())
    }

    /// Permissionless rescue. Pays the *owner* (never the caller) from the
    /// committed ledger. Fails harmlessly if the action already paid.
    pub fn finalize_withdraw(ctx: Context<FinalizeWithdraw>, owner: Pubkey, nonce: u64) -> Result<()> {
        let entry = read_committed_pending(&ctx.accounts.ledger, &owner, nonce)?;
        let a = &ctx.accounts;
        let rescuer = a.rescuer.key();
        pay_out(
            &a.config,
            &a.vault,
            &a.vault_auth,
            &a.mint,
            &a.owner_ata,
            &a.token_program,
            owner,
            nonce,
            entry.amount,
            pay_path::RESCUE,
            rescuer,
        )?;
        ctx.accounts.receipt.set_inner(build_receipt(owner, nonce, entry.amount, a.owner_ata.key(), pay_path::RESCUE, rescuer, ctx.bumps.receipt)?);
        Ok(())
    }

    // =====================================================================
    // ER — sessions & deposits
    // =====================================================================

    /// Owner authorizes a session signer with a spend cap and expiry (enforced here,
    /// because the session-keys program enforces no spend limits).
    pub fn set_session(ctx: Context<SetSession>, signer: Pubkey, cap: u64, expires_ts: i64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(expires_ts > now && expires_ts <= now + MAX_SESSION_SECS, LandedError::InvalidSession);
        let l = &mut ctx.accounts.ledger;
        l.session = SessionGrant { signer, expires_ts, cap, spent: 0 };
        Ok(())
    }

    pub fn clear_session(ctx: Context<SetSession>) -> Result<()> {
        ctx.accounts.ledger.session = SessionGrant::default();
        Ok(())
    }

    /// Permissionless: credits L1 `DepositReceipt[owner, n]` exactly once, in order.
    pub fn ingest_deposit(ctx: Context<IngestDeposit>, nonce: u64) -> Result<()> {
        let l = &mut ctx.accounts.ledger;
        require!(nonce == l.ingested_count, LandedError::OutOfOrder);
        let r = read_l1_account::<DepositReceipt>(
            &ctx.accounts.receipt,
            &[DEPOSIT_SEED, l.owner.as_ref(), &nonce.to_le_bytes()],
        )?;
        require!(r.owner == l.owner && r.nonce == nonce, LandedError::InvalidReceipt);
        l.available = l.available.checked_add(r.amount).ok_or(LandedError::MathOverflow)?;
        l.ingested_total = l.ingested_total.checked_add(r.amount).ok_or(LandedError::MathOverflow)?;
        l.ingested_count += 1;
        emit!(DepositIngested { owner: l.owner, nonce, amount: r.amount, available: l.available });
        Ok(())
    }

    // =====================================================================
    // ER — withdrawals
    // =====================================================================

    /// Debits the rollup balance, records a Pending ring entry, commits the
    /// ledger and schedules the `settle_withdraw` post-commit action.
    /// Destination is always the owner's dUSDC ATA — never an argument.
    pub fn request_withdraw<'info>(
        ctx: Context<'info, RequestWithdraw<'info>>,
        amount: u64,
        inject_fault: bool,
    ) -> Result<()> {
        #[cfg(not(feature = "fault-lab"))]
        require!(!inject_fault, LandedError::FaultLabDisabled);
        let now = Clock::get()?.unix_timestamp;
        let cfg = &ctx.accounts.config;
        let ledger = &mut ctx.accounts.ledger;
        authorize(&ctx.accounts.authority, ledger, ctx.accounts.session_token.as_deref().map(|a| &**a), 0, now)?;
        require!(amount >= cfg.min_withdraw, LandedError::AmountTooSmall);
        require!(amount <= ledger.available, LandedError::InsufficientBalance);
        let nonce = ledger.withdraw_nonce;
        let slot = landed_core::ring_slot(nonce);
        require!(landed_core::slot_reusable(ledger.ring[slot].state), LandedError::RingFull);
        ledger.available -= amount;
        ledger.withdraw_requested_total =
            ledger.withdraw_requested_total.checked_add(amount).ok_or(LandedError::MathOverflow)?;
        ledger.ring[slot] = PendingWithdrawal {
            nonce,
            amount,
            requested_ts: now,
            state: landed_core::slot_state::PENDING,
            fault: inject_fault as u8,
        };
        ledger.withdraw_nonce = nonce + 1;
        let owner = ledger.owner;
        emit!(WithdrawRequested { owner, nonce, amount, fault: inject_fault, ts: now });
        // Serialize before the commit CPI so the committed bytes include this request.
        ledger.exit(&crate::ID)?;

        let action = build_settle_action(cfg, &owner, &ctx.accounts.ledger.key(), nonce, ctx.accounts.escrow_auth.to_account_info())?;
        let a = &ctx.accounts;
        let seeds: &[&[u8]] = &[ESCROW_AUTH_SEED, &[cfg.escrow_auth_bump]];
        // TEST-ONLY (MagicSVM): MagicSVM executes post-commit actions inside the ER
        // transaction, so a failing action reverts the whole ER tx. The live
        // committor instead drops the failed action and re-commits without it.
        // This feature reproduces the live outcome (commit lands, no action) so
        // the rescue path can be tested in-process. Never enabled for deploys.
        #[cfg(feature = "sim-committor-drop")]
        if inject_fault {
            MagicIntentBundleBuilder::new(
                a.escrow_auth.to_account_info(),
                a.magic_context.to_account_info(),
                a.magic_program.to_account_info(),
            )
            .magic_fee_vault(a.magic_fee_vault.to_account_info())
            .commit(&[a.ledger.to_account_info()])
            .build_and_invoke_signed(&[seeds])?;
            return Ok(());
        }
        MagicIntentBundleBuilder::new(
            a.escrow_auth.to_account_info(),
            a.magic_context.to_account_info(),
            a.magic_program.to_account_info(),
        )
        .magic_fee_vault(a.magic_fee_vault.to_account_info())
        .commit(&[a.ledger.to_account_info()])
        .add_post_commit_actions([action])
        .build_and_invoke_signed(&[seeds])?;
        Ok(())
    }

    /// Permissionless: commit the ledger WITHOUT an action, for the case where
    /// the original commit never landed. Only allowed while a withdrawal has
    /// been pending for ≥ 5 s (so it can't be used to burn the fee payer).
    pub fn request_commit(ctx: Context<RequestCommit>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let l = &ctx.accounts.ledger;
        let oldest = l
            .ring
            .iter()
            .filter(|s| s.state == landed_core::slot_state::PENDING)
            .min_by_key(|s| s.nonce)
            .copied()
            .ok_or(LandedError::NothingPending)?;
        require!(now >= oldest.requested_ts + REQUEST_COMMIT_MIN_AGE_SECS, LandedError::CommitTooEarly);
        emit!(CommitForced { owner: l.owner, oldest_pending_nonce: oldest.nonce });
        let a = &ctx.accounts;
        let seeds: &[&[u8]] = &[ESCROW_AUTH_SEED, &[a.config.escrow_auth_bump]];
        MagicIntentBundleBuilder::new(
            a.escrow_auth.to_account_info(),
            a.magic_context.to_account_info(),
            a.magic_program.to_account_info(),
        )
        .magic_fee_vault(a.magic_fee_vault.to_account_info())
        .commit(&[a.ledger.to_account_info()])
        .build_and_invoke_signed(&[seeds])?;
        Ok(())
    }

    /// Permissionless: marks a ring slot Acked once its L1 `WithdrawReceipt` is
    /// visible. Only Acked (or Empty) slots can be reused.
    pub fn ack_withdrawal(ctx: Context<AckWithdrawal>, nonce: u64) -> Result<()> {
        let l = &mut ctx.accounts.ledger;
        let r = read_l1_account::<WithdrawReceipt>(
            &ctx.accounts.receipt,
            &[WITHDRAW_SEED, l.owner.as_ref(), &nonce.to_le_bytes()],
        )?;
        let slot = landed_core::ring_slot(nonce);
        let s = l.ring[slot];
        require!(s.nonce == nonce && s.state == landed_core::slot_state::PENDING, LandedError::NotPending);
        require!(r.owner == l.owner && r.nonce == nonce && r.amount == s.amount, LandedError::InvalidReceipt);
        l.ring[slot].state = landed_core::slot_state::ACKED;
        emit!(WithdrawAcked { owner: l.owner, nonce });
        Ok(())
    }

    // =====================================================================
    // ER — The Drop
    // =====================================================================

    pub fn enter_round(ctx: Context<EnterRound>, amount: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let cfg = &ctx.accounts.config;
        require!(!cfg.paused, LandedError::Paused);
        require!(!cfg.close_only, LandedError::CloseOnly);
        require!(amount >= cfg.min_chip, LandedError::AmountTooSmall);
        require!(amount <= cfg.max_chip, LandedError::AmountTooLarge);
        let ledger = &mut ctx.accounts.ledger;
        authorize(&ctx.accounts.authority, ledger, ctx.accounts.session_token.as_deref().map(|a| &**a), amount, now)?;
        require!(amount <= ledger.available, LandedError::InsufficientBalance);

        let mut t = ctx.accounts.table.load_mut()?;
        require!(t.status == table_status::OPEN, LandedError::RoundNotOpen);
        require!(t.closes_ts == 0 || now < t.closes_ts, LandedError::RoundClosed);
        let player = ledger.owner;
        let n = t.entry_count as usize;
        let mut new_player = true;
        let mut idx = n;
        for i in 0..n {
            if t.entries[i].player == player {
                idx = i;
                new_player = false;
                break;
            }
        }
        if new_player {
            require!(n < landed_core::MAX_ENTRIES, LandedError::TableFull);
            require!(amount <= cfg.max_per_player_round, LandedError::PlayerCapExceeded);
            t.entries[idx] = Entry { player, amount };
            t.entry_count += 1;
        } else {
            let total = t.entries[idx].amount.checked_add(amount).ok_or(LandedError::MathOverflow)?;
            require!(total <= cfg.max_per_player_round, LandedError::PlayerCapExceeded);
            t.entries[idx].amount = total;
        }
        t.pot = t.pot.checked_add(amount).ok_or(LandedError::MathOverflow)?;
        if t.closes_ts == 0 {
            t.opened_ts = now;
            t.closes_ts = now + t.round_secs as i64;
        }
        ledger.available -= amount;
        ledger.debited_total = ledger.debited_total.checked_add(amount).ok_or(LandedError::MathOverflow)?;
        ledger.stats.wagered = ledger.stats.wagered.saturating_add(amount);
        if new_player {
            ledger.stats.rounds = ledger.stats.rounds.saturating_add(1);
        }
        emit!(Entered { table: t.id, round_id: t.round_id, player, amount, pot: t.pot });
        Ok(())
    }

    /// A lone entrant may take their chips back while waiting for an opponent.
    pub fn leave_solo(ctx: Context<LeaveSolo>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let ledger = &mut ctx.accounts.ledger;
        authorize(&ctx.accounts.authority, ledger, ctx.accounts.session_token.as_deref().map(|a| &**a), 0, now)?;
        let mut t = ctx.accounts.table.load_mut()?;
        require!(t.status == table_status::OPEN, LandedError::RoundNotOpen);
        require!(t.entry_count == 1 && t.entries[0].player == ledger.owner, LandedError::NotSolo);
        let amount = t.entries[0].amount;
        ledger.available = ledger.available.checked_add(amount).ok_or(LandedError::MathOverflow)?;
        ledger.credited_total = ledger.credited_total.checked_add(amount).ok_or(LandedError::MathOverflow)?;
        let (id, round_id) = (t.id, t.round_id);
        t.entries[0] = Entry::default();
        t.entry_count = 0;
        t.pot = 0;
        t.opened_ts = 0;
        t.closes_ts = 0;
        emit!(SoloLeft { table: id, round_id, player: ledger.owner, amount });
        Ok(())
    }

    /// Crankable + permissionless "tick". Open & due → lock entries and request
    /// VRF (or extend if < 2 players). AwaitingVrf & retry due → re-request with
    /// a new nonce. Anything else is a no-op (keeps the crank healthy).
    pub fn close_round(ctx: Context<CloseRound>, caller_kind: u8) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let by_crank = invoked_by_hydra(&ctx.accounts.instructions)?;
        let request = {
            let mut t = ctx.accounts.table.load_mut()?;
            if by_crank {
                t.last_crank_ts = now;
            }
            match t.status {
                table_status::OPEN => {
                    if t.entry_count == 0 || t.closes_ts == 0 || now < t.closes_ts {
                        msg!("close_round: not due");
                        None
                    } else if t.entry_count < 2 {
                        t.closes_ts = now + t.round_secs as i64;
                        emit!(RoundExtended { table: t.id, round_id: t.round_id, closes_ts: t.closes_ts });
                        None
                    } else {
                        let kind = if by_crank {
                            closed_by::CRANK
                        } else if caller_kind == closed_by::PLAYER {
                            closed_by::PLAYER
                        } else {
                            closed_by::KEEPER
                        };
                        t.closed_by = kind;
                        if kind == closed_by::CRANK {
                            t.closes_by_crank += 1;
                        } else {
                            t.closes_by_keeper += 1;
                        }
                        t.entries_hash = t.compute_entries_hash();
                        t.vrf_nonce += 1;
                        t.status = table_status::AWAITING_VRF;
                        t.vrf_first_request_ts = now;
                        t.vrf_last_request_ts = now;
                        t.vrf_attempts = 1;
                        emit!(RoundClosed { table: t.id, round_id: t.round_id, vrf_nonce: t.vrf_nonce, closed_by: kind, entries_hash: t.entries_hash });
                        Some((t.id, t.round_id, t.entries_hash, t.closes_ts, t.vrf_nonce, t.bump))
                    }
                }
                table_status::AWAITING_VRF => {
                    if retry_due(&t, now) {
                        bump_retry(&mut t, now);
                        Some((t.id, t.round_id, t.entries_hash, t.closes_ts, t.vrf_nonce, t.bump))
                    } else {
                        None
                    }
                }
                _ => None,
            }
        };
        if let Some(req) = request {
            request_vrf(&ctx.accounts.table.to_account_info(), &ctx.accounts.program_identity, &ctx.accounts.oracle_queue, &ctx.accounts.system_program.to_account_info(), &ctx.accounts.slot_hashes, req)?;
        }
        Ok(())
    }

    /// Explicit retry (also performed by the crank tick). New nonce ⇒ the old
    /// request's callback becomes stale and is ignored.
    pub fn retry_vrf(ctx: Context<RetryVrf>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let req = {
            let mut t = ctx.accounts.table.load_mut()?;
            require!(t.status == table_status::AWAITING_VRF, LandedError::NotAwaitingVrf);
            require!(now < t.vrf_first_request_ts + t.vrf_void_secs as i64, LandedError::RetryExhausted);
            require!(t.vrf_attempts < 3, LandedError::RetryExhausted);
            require!(now >= t.vrf_last_request_ts + t.vrf_retry_secs as i64, LandedError::RetryTooEarly);
            bump_retry(&mut t, now);
            (t.id, t.round_id, t.entries_hash, t.closes_ts, t.vrf_nonce, t.bump)
        };
        request_vrf(&ctx.accounts.table.to_account_info(), &ctx.accounts.program_identity, &ctx.accounts.oracle_queue, &ctx.accounts.system_program.to_account_info(), &ctx.accounts.slot_hashes, req)
    }

    /// VRF oracle callback (scoped identity enforced by `#[vrf_callback]`).
    /// A callback for any round/nonce other than the live request is a no-op.
    pub fn vrf_callback(ctx: Context<VrfCallback>, randomness: [u8; 32], round_id: u64, vrf_nonce: u64) -> Result<()> {
        let mut t = ctx.accounts.table.load_mut()?;
        if t.status != table_status::AWAITING_VRF || t.round_id != round_id || t.vrf_nonce != vrf_nonce {
            t.stale_callbacks += 1;
            emit!(StaleCallbackIgnored { table: t.id, round_id, vrf_nonce, expected_round_id: t.round_id, expected_nonce: t.vrf_nonce, status: t.status });
            return Ok(());
        }
        let (amounts, n) = t.amounts();
        let w = landed_core::select_winner(&randomness, &amounts[..n]).ok_or(LandedError::MathOverflow)?;
        t.randomness = randomness;
        t.winner_idx = w as u8;
        t.status = table_status::DRAWN;
        emit!(RoundDrawn { table: t.id, round_id, vrf_nonce, winner_idx: w as u8, randomness });
        Ok(())
    }

    /// Permissionless. Credits the winner (pot − fee) and the treasury (fee),
    /// records history, opens the next round and commits the table to L1.
    pub fn settle_round(ctx: Context<SettleRound>, round_id: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        {
            let mut t = ctx.accounts.table.load_mut()?;
            require!(round_id >= t.round_id, LandedError::AlreadySettled);
            require!(round_id == t.round_id && t.status == table_status::DRAWN, LandedError::NotDrawn);
            let w = t.winner_idx as usize;
            let winner = t.entries[w].player;
            let wl = &mut ctx.accounts.winner_ledger;
            require!(wl.owner == winner, LandedError::WrongWinner);
            require_keys_eq!(ctx.accounts.treasury_ledger.owner, t.treasury, LandedError::InvalidLedger);
            let (credit, fee) = landed_core::split_pot(t.pot, t.house_fee_bps).ok_or(LandedError::MathOverflow)?;
            wl.available = wl.available.checked_add(credit).ok_or(LandedError::MathOverflow)?;
            wl.credited_total = wl.credited_total.checked_add(credit).ok_or(LandedError::MathOverflow)?;
            wl.stats.wins = wl.stats.wins.saturating_add(1);
            wl.stats.won = wl.stats.won.saturating_add(credit);
            let tl = &mut ctx.accounts.treasury_ledger;
            tl.available = tl.available.checked_add(fee).ok_or(LandedError::MathOverflow)?;
            tl.credited_total = tl.credited_total.checked_add(fee).ok_or(LandedError::MathOverflow)?;
            let r = RoundResult {
                round_id: t.round_id,
                pot: t.pot,
                fee,
                vrf_nonce: t.vrf_nonce,
                settled_ts: now,
                winner,
                randomness: t.randomness,
                entries_hash: t.entries_hash,
                outcome: round_outcome::SETTLED,
                winner_idx: t.winner_idx,
                entry_count: t.entry_count,
                closed_by: t.closed_by,
                _pad: [0; 4],
            };
            t.push_history(r);
            t.rounds_settled += 1;
            emit!(RoundSettled { table: t.id, round_id, winner, pot: t.pot, fee, credit });
            t.reset_for_next_round();
        }
        ctx.accounts.winner_ledger.exit(&crate::ID)?;
        ctx.accounts.treasury_ledger.exit(&crate::ID)?;
        // Durable proof of the result on L1 (history ring).
        let a = &ctx.accounts;
        let seeds: &[&[u8]] = &[ESCROW_AUTH_SEED, &[a.config.escrow_auth_bump]];
        MagicIntentBundleBuilder::new(
            a.escrow_auth.to_account_info(),
            a.magic_context.to_account_info(),
            a.magic_program.to_account_info(),
        )
        .magic_fee_vault(a.magic_fee_vault.to_account_info())
        .commit(&[a.table.to_account_info()])
        .build_and_invoke_signed(&[seeds])?;
        Ok(())
    }

    /// Permissionless after 150 s without a usable callback: refunds every
    /// entry (all-or-nothing). `remaining_accounts` = entrant ledgers, in entry order.
    pub fn void_round<'info>(ctx: Context<'info, VoidRound<'info>>, round_id: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let mut t = ctx.accounts.table.load_mut()?;
        require!(round_id >= t.round_id, LandedError::AlreadySettled);
        require!(round_id == t.round_id && t.status == table_status::AWAITING_VRF, LandedError::NotAwaitingVrf);
        require!(now >= t.vrf_first_request_ts + t.vrf_void_secs as i64, LandedError::VoidTooEarly);
        let n = t.entry_count as usize;
        require!(ctx.remaining_accounts.len() == n, LandedError::BadRefundAccounts);
        let mut refunded: u64 = 0;
        for (i, ai) in ctx.remaining_accounts.iter().enumerate() {
            require!(ai.is_writable, LandedError::BadRefundAccounts);
            let mut l: Account<'info, Ledger> = Account::try_from(ai)?;
            let e = t.entries[i];
            require!(l.owner == e.player, LandedError::BadRefundAccounts);
            let (pda, _) = Pubkey::find_program_address(&[LEDGER_SEED, e.player.as_ref()], &crate::ID);
            require_keys_eq!(pda, ai.key(), LandedError::BadRefundAccounts);
            l.available = l.available.checked_add(e.amount).ok_or(LandedError::MathOverflow)?;
            l.credited_total = l.credited_total.checked_add(e.amount).ok_or(LandedError::MathOverflow)?;
            refunded = refunded.checked_add(e.amount).ok_or(LandedError::MathOverflow)?;
            l.exit(&crate::ID)?;
        }
        require!(refunded == t.pot, LandedError::BadRefundAccounts);
        let r = RoundResult {
            round_id: t.round_id,
            pot: t.pot,
            fee: 0,
            vrf_nonce: t.vrf_nonce,
            settled_ts: now,
            winner: Pubkey::default(),
            randomness: [0; 32],
            entries_hash: t.entries_hash,
            outcome: round_outcome::VOIDED,
            winner_idx: 0,
            entry_count: t.entry_count,
            closed_by: t.closed_by,
            _pad: [0; 4],
        };
        t.push_history(r);
        t.rounds_voided += 1;
        emit!(RoundVoided { table: t.id, round_id, refunded });
        t.reset_for_next_round();
        Ok(())
    }

    /// Admin (ER): schedules the `close_round` tick with a derived task id.
    pub fn schedule_crank<'info>(ctx: Context<'info, ScheduleCrank<'info>>) -> Result<()> {
        let task_id = ctx.accounts.table.load()?.crank_task_id;
        let close_ix = Instruction {
            program_id: crate::ID,
            accounts: vec![
                AccountMeta::new(ctx.accounts.table.key(), false),
                AccountMeta::new(ctx.accounts.oracle_queue.key(), false),
                AccountMeta::new_readonly(ix_sysvar::ID, false),
                AccountMeta::new_readonly(ctx.accounts.program_identity.key(), false),
                AccountMeta::new_readonly(ctx.accounts.vrf_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.slot_hashes.key(), false),
                AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
            ],
            data: anchor_lang::InstructionData::data(&crate::instruction::CloseRound { caller_kind: closed_by::CRANK }),
        };
        let accs: &'info ScheduleCrank<'info> = ctx.accounts;
        let admin: &'info AccountInfo<'info> = accs.admin.as_ref();
        let magic: &'info AccountInfo<'info> = accs.magic_program.as_ref();
        let accounts = [
            ctx.accounts.table.to_account_info(),
            ctx.accounts.oracle_queue.to_account_info(),
            ctx.accounts.instructions.to_account_info(),
            ctx.accounts.program_identity.to_account_info(),
            ctx.accounts.vrf_program.to_account_info(),
            ctx.accounts.slot_hashes.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.program.to_account_info(),
        ];
        ScheduleCrankCpi {
            payer: admin,
            magic_program: magic,
            instruction_accounts: &accounts,
            args: ScheduleTaskArgs {
                task_id,
                execution_interval_millis: CRANK_INTERVAL_MS,
                iterations: CRANK_ITERATIONS,
                instructions: vec![close_ix],
            },
        }
        .invoke()?;
        msg!("crank scheduled task_id={}", task_id);
        Ok(())
    }
}

// =========================================================================
// helpers
// =========================================================================

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ConfigParams {
    pub er_validator: Pubkey,
    pub house_fee_bps: u16,
    pub min_chip: u64,
    pub max_chip: u64,
    pub max_per_player_round: u64,
    pub min_withdraw: u64,
    pub round_secs: u32,
    pub vrf_retry_secs: u32,
    pub vrf_void_secs: u32,
}

impl ConfigParams {
    pub fn validate(&self) -> Result<()> {
        require!(self.house_fee_bps <= 1_000, LandedError::InvalidConfig);
        require!(self.min_chip > 0 && self.min_chip <= self.max_chip, LandedError::InvalidConfig);
        require!(self.max_chip <= self.max_per_player_round, LandedError::InvalidConfig);
        require!(self.min_withdraw > 0, LandedError::InvalidConfig);
        require!(self.round_secs >= 5, LandedError::InvalidConfig);
        require!(self.vrf_retry_secs >= 1, LandedError::InvalidConfig);
        // Void only after the VRF queue's ~120 s purge window has passed.
        require!(self.vrf_void_secs > 120 || cfg!(feature = "short-timers"), LandedError::InvalidConfig);
        require!(self.vrf_void_secs > self.vrf_retry_secs, LandedError::InvalidConfig);
        Ok(())
    }
}

/// Owner, or a session signer within its expiry and spend cap. A valid
/// `SessionTokenV2` (MagicBlock session-keys program) for this program is also
/// required on the session path.
fn authorize(signer: &Signer, ledger: &mut Ledger, token: Option<&SessionTokenV2>, spend: u64, now: i64) -> Result<()> {
    if signer.key() == ledger.owner {
        return Ok(());
    }
    let s = &mut ledger.session;
    require!(s.signer != Pubkey::default() && s.signer == signer.key(), LandedError::Unauthorized);
    require!(now < s.expires_ts, LandedError::InvalidSession);
    let tok = token.ok_or(LandedError::InvalidSession)?;
    require!(
        tok.authority == ledger.owner
            && tok.session_signer == signer.key()
            && tok.target_program == crate::ID
            && now < tok.valid_until,
        LandedError::InvalidSession
    );
    let next = s.spent.checked_add(spend).ok_or(LandedError::MathOverflow)?;
    require!(next <= s.cap, LandedError::SessionCapExceeded);
    s.spent = next;
    Ok(())
}

/// Reads an L1 (non-delegated) program account inside the ER: checks owner,
/// PDA derivation and discriminator before deserializing.
fn read_l1_account<T: AccountDeserialize + Discriminator>(ai: &UncheckedAccount, seeds: &[&[u8]]) -> Result<T> {
    require_keys_eq!(*ai.owner, crate::ID, LandedError::InvalidReceipt);
    let (pda, _) = Pubkey::find_program_address(seeds, &crate::ID);
    require_keys_eq!(pda, ai.key(), LandedError::InvalidReceipt);
    let data = ai.try_borrow_data()?;
    let mut s: &[u8] = &data;
    T::try_deserialize(&mut s).map_err(|_| error!(LandedError::InvalidReceipt))
}

/// Reads the *committed* ledger on L1 (owner = delegation program while
/// delegated, or this program after undelegation) and returns the Pending entry.
fn read_committed_pending(ai: &UncheckedAccount, owner: &Pubkey, nonce: u64) -> Result<PendingWithdrawal> {
    let (pda, _) = Pubkey::find_program_address(&[LEDGER_SEED, owner.as_ref()], &crate::ID);
    require_keys_eq!(pda, ai.key(), LandedError::InvalidLedger);
    require!(*ai.owner == DELEGATION_PROGRAM_ID || *ai.owner == crate::ID, LandedError::InvalidLedger);
    let data = ai.try_borrow_data()?;
    let mut s: &[u8] = &data;
    let l = Ledger::try_deserialize(&mut s).map_err(|_| error!(LandedError::InvalidLedger))?;
    require_keys_eq!(l.owner, *owner, LandedError::InvalidLedger);
    l.find_pending(nonce).ok_or(error!(LandedError::NotPending))
}

fn build_receipt(owner: Pubkey, nonce: u64, amount: u64, dest_ata: Pubkey, path: u8, rescuer: Pubkey, bump: u8) -> Result<WithdrawReceipt> {
    let clock = Clock::get()?;
    Ok(WithdrawReceipt { owner, nonce, amount, dest_ata, path, rescuer, ts: clock.unix_timestamp, slot: clock.slot, bump })
}

/// Transfers `amount` from the vault to the owner's ATA. Never partial.
fn pay_out<'info>(
    config: &Account<'info, Config>,
    vault: &Account<'info, TokenAccount>,
    vault_auth: &UncheckedAccount<'info>,
    mint: &Account<'info, Mint>,
    owner_ata: &Account<'info, TokenAccount>,
    token_program: &Program<'info, Token>,
    owner: Pubkey,
    nonce: u64,
    amount: u64,
    path: u8,
    rescuer: Pubkey,
) -> Result<()> {
    require_keys_eq!(owner_ata.owner, owner, LandedError::InvalidDestination);
    require!(vault.amount >= amount, LandedError::VaultInsufficient);
    token::transfer_checked(
        CpiContext::new_with_signer(
            token_program.key(),
            TransferChecked {
                from: vault.to_account_info(),
                mint: mint.to_account_info(),
                to: owner_ata.to_account_info(),
                authority: vault_auth.to_account_info(),
            },
            &[&[VAULT_AUTH_SEED, &[config.vault_auth_bump]]],
        ),
        amount,
        DUSDC_DECIMALS,
    )?;
    emit!(WithdrawPaid { owner, nonce, amount, path, rescuer });
    Ok(())
}

fn meta(k: Pubkey, w: bool) -> ShortAccountMeta {
    ShortAccountMeta { pubkey: k.to_bytes().into(), is_writable: w }
}

/// The post-commit `settle_withdraw` call, with account order matching
/// `SettleWithdraw` (DLP appends source_program, escrow_auth, escrow).
fn build_settle_action<'info>(cfg: &Config, owner: &Pubkey, ledger: &Pubkey, nonce: u64, escrow_auth: AccountInfo<'info>) -> Result<CallHandler<'info>> {
    let (receipt, _) =
        Pubkey::find_program_address(&[WITHDRAW_SEED, owner.as_ref(), &nonce.to_le_bytes()], &crate::ID);
    let owner_ata = get_associated_token_address(owner, &cfg.mint);
    let config = Pubkey::create_program_address(&[CONFIG_SEED, &[cfg.bump]], &crate::ID)
        .map_err(|_| error!(LandedError::InvalidConfig))?;
    let vault_auth = Pubkey::create_program_address(&[VAULT_AUTH_SEED, &[cfg.vault_auth_bump]], &crate::ID)
        .map_err(|_| error!(LandedError::InvalidConfig))?;
    let data = anchor_lang::InstructionData::data(&crate::instruction::SettleWithdraw { owner: *owner, nonce });
    Ok(CallHandler {
        destination_program: crate::ID,
        accounts: vec![
            meta(config, false),
            meta(*ledger, false),
            meta(*owner, false),
            meta(receipt, true),
            meta(owner_ata, true),
            meta(cfg.mint, false),
            meta(cfg.vault, true),
            meta(vault_auth, false),
            meta(anchor_spl::token::ID, false),
            meta(anchor_spl::associated_token::ID, false),
            meta(anchor_lang::system_program::ID, false),
        ],
        args: ActionArgs::new(data),
        escrow_authority: escrow_auth,
        compute_units: ACTION_COMPUTE_UNITS,
    })
}

fn retry_due(t: &Table, now: i64) -> bool {
    t.vrf_attempts < 3
        && now >= t.vrf_last_request_ts + t.vrf_retry_secs as i64
        && now < t.vrf_first_request_ts + t.vrf_void_secs as i64
}

fn bump_retry(t: &mut Table, now: i64) {
    t.vrf_nonce += 1;
    t.vrf_attempts += 1;
    t.vrf_last_request_ts = now;
    t.vrf_retries += 1;
    emit!(VrfRetried { table: t.id, round_id: t.round_id, vrf_nonce: t.vrf_nonce, attempts: t.vrf_attempts });
}

/// Requests randomness from the delegated ephemeral queue. The delegated table
/// PDA signs as payer, so a signer-less crank tick can request VRF (validator
/// 2.0 / Hydra rejects signer metas in scheduled instructions).
fn request_vrf<'info>(
    table: &AccountInfo<'info>,
    program_identity: &UncheckedAccount<'info>,
    oracle_queue: &UncheckedAccount<'info>,
    system_program: &AccountInfo<'info>,
    slot_hashes: &UncheckedAccount<'info>,
    req: (u64, u64, [u8; 32], i64, u64, u8),
) -> Result<()> {
    let (table_id, round_id, entries_hash, closes_ts, vrf_nonce, bump) = req;
    let seed = landed_core::vrf_caller_seed(table_id, round_id, &entries_hash, closes_ts, vrf_nonce);
    let mut args = Vec::with_capacity(16);
    args.extend_from_slice(&round_id.to_le_bytes());
    args.extend_from_slice(&vrf_nonce.to_le_bytes());
    let ix = create_request_randomness_ix_const(
        RequestRandomnessParams {
            payer: table.key(),
            oracle_queue: oracle_queue.key(),
            callback_program_id: crate::ID,
            callback_discriminator: crate::instruction::VrfCallback::DISCRIMINATOR.to_vec(),
            caller_seed: seed,
            accounts_metas: Some(vec![SerializableAccountMeta { pubkey: table.key(), is_signer: false, is_writable: true }]),
            callback_args: Some(args),
        },
        ephemeral_rollups_sdk::vrf::consts::program_identity_pubkey(&crate::ID),
    );
    let id_bytes = table_id.to_le_bytes();
    invoke_signed(
        &ix,
        &[table.clone(), program_identity.to_account_info(), oracle_queue.to_account_info(), system_program.clone(), slot_hashes.to_account_info()],
        &[&[IDENTITY, &[VRF_IDENTITY.1]], &[TABLE_SEED, &id_bytes, &[bump]]],
    )?;
    Ok(())
}

/// True when the instruction immediately before this one is a Hydra `Trigger`
/// (validator 2.0 crank execution). Used only for telemetry (`closed_by`).
fn invoked_by_hydra(ix_acc: &UncheckedAccount) -> Result<bool> {
    let cur = ix_sysvar::load_current_index_checked(&ix_acc.to_account_info())? as usize;
    if cur == 0 {
        return Ok(false);
    }
    let prev = ix_sysvar::load_instruction_at_checked(cur - 1, &ix_acc.to_account_info())?;
    Ok(prev.program_id == HYDRA_EPHEMERAL_ID)
}

// =========================================================================
// account contexts — L1
// =========================================================================

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(init, payer = admin, seeds = [MINT_SEED], bump, mint::decimals = DUSDC_DECIMALS, mint::authority = mint_auth)]
    pub mint: Box<Account<'info, Mint>>,
    /// CHECK: PDA mint authority
    #[account(seeds = [MINT_AUTH_SEED], bump)]
    pub mint_auth: UncheckedAccount<'info>,
    #[account(init, payer = admin, seeds = [VAULT_SEED], bump, token::mint = mint, token::authority = vault_auth)]
    pub vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: PDA vault authority
    #[account(seeds = [VAULT_AUTH_SEED], bump)]
    pub vault_auth: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeEscrowAndTreasury<'info> {
    #[account(mut, address = config.admin @ LandedError::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(init, payer = admin, space = ESCROW_AUTH_SPACE, seeds = [ESCROW_AUTH_SEED], bump)]
    pub escrow_auth: Account<'info, EscrowAuth>,
    #[account(init, payer = admin, space = LEDGER_SPACE, seeds = [LEDGER_SEED, config.treasury.as_ref()], bump)]
    pub treasury_ledger: Box<Account<'info, Ledger>>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateEscrowAuth<'info> {
    #[account(mut, address = config.admin @ LandedError::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: escrow authority PDA
    #[account(mut, del, seeds = [ESCROW_AUTH_SEED], bump)]
    pub pda: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct CreateTable<'info> {
    #[account(mut, address = config.admin @ LandedError::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(init, payer = admin, space = TABLE_SPACE, seeds = [TABLE_SEED, &id.to_le_bytes()], bump)]
    pub table: AccountLoader<'info, Table>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(id: u64)]
pub struct DelegateTable<'info> {
    #[account(mut, address = config.admin @ LandedError::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: table PDA
    #[account(mut, del, seeds = [TABLE_SEED, &id.to_le_bytes()], bump)]
    pub pda: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(address = config.admin @ LandedError::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    #[account(address = config.pending_admin @ LandedError::Unauthorized)]
    pub new_admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
}

#[derive(Accounts)]
pub struct InitUser<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(init, payer = owner, space = 8 + UserMeta::INIT_SPACE, seeds = [USER_SEED, owner.key().as_ref()], bump)]
    pub user_meta: Account<'info, UserMeta>,
    #[account(init, payer = owner, space = LEDGER_SPACE, seeds = [LEDGER_SEED, owner.key().as_ref()], bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Faucet<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [USER_SEED, owner.key().as_ref()], bump = user_meta.bump)]
    pub user_meta: Account<'info, UserMeta>,
    #[account(mut, address = config.mint)]
    pub mint: Box<Account<'info, Mint>>,
    /// CHECK: PDA mint authority
    #[account(seeds = [MINT_AUTH_SEED], bump = config.mint_auth_bump)]
    pub mint_auth: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = owner, associated_token::mint = mint, associated_token::authority = owner)]
    pub owner_ata: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [USER_SEED, owner.key().as_ref()], bump = user_meta.bump)]
    pub user_meta: Account<'info, UserMeta>,
    #[account(init, payer = owner, space = 8 + DepositReceipt::INIT_SPACE,
        seeds = [DEPOSIT_SEED, owner.key().as_ref(), &user_meta.deposit_count.to_le_bytes()], bump)]
    pub receipt: Account<'info, DepositReceipt>,
    #[account(address = config.mint)]
    pub mint: Box<Account<'info, Mint>>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = owner)]
    pub owner_ata: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = config.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateLedger<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: ledger owner (only used for PDA seeds)
    pub owner: UncheckedAccount<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: ledger PDA
    #[account(mut, del, seeds = [LEDGER_SEED, owner.key().as_ref()], bump)]
    pub pda: UncheckedAccount<'info>,
}

/// Account order = `build_settle_action` metas, then the three accounts the
/// delegation program appends (source_program, escrow_auth, escrow).
#[action]
#[derive(Accounts)]
#[instruction(owner: Pubkey, nonce: u64)]
pub struct SettleWithdraw<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: committed ledger; validated in `read_committed_pending`
    pub ledger: UncheckedAccount<'info>,
    /// CHECK: must equal the `owner` arg; only used as ATA authority
    #[account(address = owner @ LandedError::InvalidDestination)]
    pub owner_account: UncheckedAccount<'info>,
    #[account(init, payer = escrow, space = 8 + WithdrawReceipt::INIT_SPACE,
        seeds = [WITHDRAW_SEED, owner.as_ref(), &nonce.to_le_bytes()], bump)]
    pub receipt: Box<Account<'info, WithdrawReceipt>>,
    #[account(init_if_needed, payer = escrow, associated_token::mint = mint, associated_token::authority = owner_account)]
    pub owner_ata: Box<Account<'info, TokenAccount>>,
    #[account(address = config.mint)]
    pub mint: Box<Account<'info, Mint>>,
    #[account(mut, address = config.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: PDA vault authority
    #[account(seeds = [VAULT_AUTH_SEED], bump = config.vault_auth_bump)]
    pub vault_auth: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    /// CHECK: program that scheduled the action (DLP CallHandlerV2)
    #[account(address = crate::ID @ LandedError::Unauthorized)]
    pub source_program: UncheckedAccount<'info>,
    /// CHECK: must be OUR escrow authority PDA (blocks foreign programs' actions)
    #[account(seeds = [ESCROW_AUTH_SEED], bump = config.escrow_auth_bump)]
    pub escrow_auth: UncheckedAccount<'info>,
    /// CHECK: only the delegation program can sign for this PDA, so `signer`
    /// proves the call arrived through the real post-commit path.
    #[account(
        mut,
        signer @ LandedError::Unauthorized,
        address = ephemeral_rollups_sdk::pda::ephemeral_balance_pda_from_payer(&escrow_auth.key(), ACTION_ESCROW_INDEX) @ LandedError::Unauthorized,
    )]
    pub escrow: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(owner: Pubkey, nonce: u64)]
pub struct FinalizeWithdraw<'info> {
    #[account(mut)]
    pub rescuer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: committed ledger; validated in `read_committed_pending`
    pub ledger: UncheckedAccount<'info>,
    /// CHECK: must equal the `owner` arg
    #[account(address = owner @ LandedError::InvalidDestination)]
    pub owner_account: UncheckedAccount<'info>,
    #[account(init, payer = rescuer, space = 8 + WithdrawReceipt::INIT_SPACE,
        seeds = [WITHDRAW_SEED, owner.as_ref(), &nonce.to_le_bytes()], bump)]
    pub receipt: Box<Account<'info, WithdrawReceipt>>,
    #[account(init_if_needed, payer = rescuer, associated_token::mint = mint, associated_token::authority = owner_account)]
    pub owner_ata: Box<Account<'info, TokenAccount>>,
    #[account(address = config.mint)]
    pub mint: Box<Account<'info, Mint>>,
    #[account(mut, address = config.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: PDA vault authority
    #[account(seeds = [VAULT_AUTH_SEED], bump = config.vault_auth_bump)]
    pub vault_auth: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

// =========================================================================
// account contexts — ER
// =========================================================================

#[derive(Accounts)]
pub struct SetSession<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [LEDGER_SEED, owner.key().as_ref()], bump = ledger.bump, has_one = owner @ LandedError::Unauthorized)]
    pub ledger: Box<Account<'info, Ledger>>,
}

#[derive(Accounts)]
pub struct IngestDeposit<'info> {
    #[account(mut, seeds = [LEDGER_SEED, ledger.owner.as_ref()], bump = ledger.bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    /// CHECK: L1 DepositReceipt cloned into the ER; validated in handler
    pub receipt: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct RequestWithdraw<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [LEDGER_SEED, ledger.owner.as_ref()], bump = ledger.bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    pub session_token: Option<Box<Account<'info, SessionTokenV2>>>,
    #[account(mut, seeds = [ESCROW_AUTH_SEED], bump = config.escrow_auth_bump)]
    pub escrow_auth: Account<'info, EscrowAuth>,
    /// CHECK: validator-scoped magic fee vault
    #[account(mut, address = config.magic_fee_vault @ LandedError::WrongFeeVault)]
    pub magic_fee_vault: UncheckedAccount<'info>,
    /// CHECK: action destination program (must be present in the outer tx)
    #[account(address = crate::ID)]
    pub program: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct RequestCommit<'info> {
    #[account(mut, seeds = [LEDGER_SEED, ledger.owner.as_ref()], bump = ledger.bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [ESCROW_AUTH_SEED], bump = config.escrow_auth_bump)]
    pub escrow_auth: Account<'info, EscrowAuth>,
    /// CHECK: validator-scoped magic fee vault
    #[account(mut, address = config.magic_fee_vault @ LandedError::WrongFeeVault)]
    pub magic_fee_vault: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct AckWithdrawal<'info> {
    #[account(mut, seeds = [LEDGER_SEED, ledger.owner.as_ref()], bump = ledger.bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    /// CHECK: L1 WithdrawReceipt cloned into the ER; validated in handler
    pub receipt: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct EnterRound<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [LEDGER_SEED, ledger.owner.as_ref()], bump = ledger.bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    #[account(mut)]
    pub table: AccountLoader<'info, Table>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    pub session_token: Option<Box<Account<'info, SessionTokenV2>>>,
}

#[derive(Accounts)]
pub struct LeaveSolo<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [LEDGER_SEED, ledger.owner.as_ref()], bump = ledger.bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    #[account(mut)]
    pub table: AccountLoader<'info, Table>,
    pub session_token: Option<Box<Account<'info, SessionTokenV2>>>,
}

#[vrf]
#[derive(Accounts)]
pub struct CloseRound<'info> {
    #[account(mut)]
    pub table: AccountLoader<'info, Table>,
    /// CHECK: VRF oracle queue (ephemeral queue in the ER)
    #[account(mut, constraint = is_vrf_queue(&oracle_queue.key()) @ LandedError::InvalidConfig)]
    pub oracle_queue: UncheckedAccount<'info>,
    /// CHECK: instructions sysvar (crank detection for telemetry)
    #[account(address = ix_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
}

#[vrf]
#[derive(Accounts)]
pub struct RetryVrf<'info> {
    #[account(mut)]
    pub table: AccountLoader<'info, Table>,
    /// CHECK: VRF oracle queue
    #[account(mut, constraint = is_vrf_queue(&oracle_queue.key()) @ LandedError::InvalidConfig)]
    pub oracle_queue: UncheckedAccount<'info>,
}

#[vrf_callback]
#[derive(Accounts)]
pub struct VrfCallback<'info> {
    #[account(mut)]
    pub table: AccountLoader<'info, Table>,
}

#[commit]
#[derive(Accounts)]
pub struct SettleRound<'info> {
    #[account(mut)]
    pub table: AccountLoader<'info, Table>,
    #[account(mut, seeds = [LEDGER_SEED, winner_ledger.owner.as_ref()], bump = winner_ledger.bump)]
    pub winner_ledger: Box<Account<'info, Ledger>>,
    #[account(mut, seeds = [LEDGER_SEED, config.treasury.as_ref()], bump = treasury_ledger.bump)]
    pub treasury_ledger: Box<Account<'info, Ledger>>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [ESCROW_AUTH_SEED], bump = config.escrow_auth_bump)]
    pub escrow_auth: Account<'info, EscrowAuth>,
    /// CHECK: validator-scoped magic fee vault
    #[account(mut, address = config.magic_fee_vault @ LandedError::WrongFeeVault)]
    pub magic_fee_vault: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct VoidRound<'info> {
    #[account(mut)]
    pub table: AccountLoader<'info, Table>,
}

#[vrf]
#[derive(Accounts)]
pub struct ScheduleCrank<'info> {
    #[account(mut, address = config.admin @ LandedError::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut)]
    pub table: AccountLoader<'info, Table>,
    /// CHECK: VRF oracle queue
    #[account(mut, constraint = is_vrf_queue(&oracle_queue.key()) @ LandedError::InvalidConfig)]
    pub oracle_queue: UncheckedAccount<'info>,
    /// CHECK: instructions sysvar
    #[account(address = ix_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
    /// CHECK: this program (scheduled instruction target)
    #[account(address = crate::ID)]
    pub program: UncheckedAccount<'info>,
    /// CHECK: MagicBlock magic program
    #[account(address = ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

fn is_vrf_queue(k: &Pubkey) -> bool {
    use ephemeral_rollups_sdk::vrf::consts::*;
    *k == DEFAULT_EPHEMERAL_QUEUE || *k == DEFAULT_EPHEMERAL_TEST_QUEUE || *k == DEFAULT_QUEUE || *k == DEFAULT_TEST_QUEUE
}
