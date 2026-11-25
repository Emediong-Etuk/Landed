//! # naive_cashout — BASELINE, DO NOT COPY
//!
//! The "base-layer custody + post-commit payout" pattern as commonly written:
//! debit in the ER, commit, and pay from a post-commit Magic Action whose
//! amount comes from instruction args. There is **no receipt, no rescue and no
//! reconciliation**. When the action fails, the validator drops it and
//! re-commits without it: the player is debited in the rollup and never paid.
//! The Fault Lab and campaign C3 run this side by side with Landed.
//!
//! It also uses the player's own wallet as intent payer (no delegated fee
//! payer), so the 11th commit of a delegation session fails with `0xA0000000`.

#![allow(unexpected_cfgs)]
#![allow(deprecated)]
#![allow(clippy::result_large_err)]

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};
use ephemeral_rollups_sdk::anchor::{action, commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::{CallHandler, MagicIntentBundleBuilder};
use ephemeral_rollups_sdk::{ActionArgs, ShortAccountMeta};

declare_id!("BrHd4kAtkATdaJYcv5GtyQ6ebNUneBV2yqe24EPRtxBc");

pub const NCONFIG_SEED: &[u8] = b"nconfig";
pub const NVAULT_SEED: &[u8] = b"nvault";
pub const NVAULT_AUTH_SEED: &[u8] = b"nvault_auth";
pub const NLEDGER_SEED: &[u8] = b"nledger";
pub const ACTION_ESCROW_INDEX: u8 = 255;

#[ephemeral]
#[program]
pub mod naive_cashout {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, er_validator: Pubkey) -> Result<()> {
        let c = &mut ctx.accounts.config;
        c.admin = ctx.accounts.admin.key();
        c.mint = ctx.accounts.mint.key();
        c.vault = ctx.accounts.vault.key();
        c.er_validator = er_validator;
        c.vault_auth_bump = ctx.bumps.vault_auth;
        c.bump = ctx.bumps.config;
        Ok(())
    }

    /// One-time: move dUSDC into the naive vault and open a ledger with that balance.
    pub fn fund(ctx: Context<Fund>, amount: u64) -> Result<()> {
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
            6,
        )?;
        let l = &mut ctx.accounts.ledger;
        l.owner = ctx.accounts.owner.key();
        l.balance = amount;
        l.funded_total = amount;
        l.bump = ctx.bumps.ledger;
        Ok(())
    }

    pub fn delegate_ledger(ctx: Context<DelegateLedger>) -> Result<()> {
        let owner = ctx.accounts.owner.key();
        ctx.accounts.delegate_pda(
            &ctx.accounts.owner,
            &[NLEDGER_SEED, owner.as_ref()],
            DelegateConfig { validator: Some(ctx.accounts.config.er_validator), ..Default::default() },
        )?;
        Ok(())
    }

    /// ER: debit, commit, and hope the post-commit payout lands.
    pub fn cash_out(ctx: Context<CashOut>, amount: u64, inject_fault: bool) -> Result<()> {
        let l = &mut ctx.accounts.ledger;
        require!(amount <= l.balance, NaiveError::Insufficient);
        l.balance -= amount;
        l.cashout_count += 1;
        l.requested_total += amount;
        let n = l.cashout_count;
        l.exit(&crate::ID)?;
        let owner = ctx.accounts.owner.key();
        let owner_ata = anchor_spl::associated_token::get_associated_token_address(&owner, &ctx.accounts.config.mint);
        let data = anchor_lang::InstructionData::data(&crate::instruction::NaivePayout { owner, amount, inject_fault, n });
        let m = |k: Pubkey, w: bool| ShortAccountMeta { pubkey: k.to_bytes().into(), is_writable: w };
        let action = CallHandler {
            destination_program: crate::ID,
            accounts: vec![
                m(ctx.accounts.config.key(), false),
                m(owner_ata, true),
                m(ctx.accounts.config.mint, false),
                m(ctx.accounts.config.vault, true),
                m(Pubkey::find_program_address(&[NVAULT_AUTH_SEED], &crate::ID).0, false),
                m(anchor_spl::token::ID, false),
            ],
            args: ActionArgs::new(data),
            escrow_authority: ctx.accounts.owner.to_account_info(),
            compute_units: 200_000,
        };
        MagicIntentBundleBuilder::new(
            ctx.accounts.owner.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit(&[ctx.accounts.ledger.to_account_info()])
        .add_post_commit_actions([action])
        .build_and_invoke()?;
        Ok(())
    }

    /// Post-commit payout. Amount comes from args; no receipt; no idempotency key.
    pub fn naive_payout(ctx: Context<NaivePayout>, owner: Pubkey, amount: u64, inject_fault: bool, n: u64) -> Result<()> {
        require!(!inject_fault, NaiveError::InjectedFault);
        require_keys_eq!(ctx.accounts.owner_ata.owner, owner, NaiveError::BadDestination);
        let bump = ctx.accounts.config.vault_auth_bump;
        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.owner_ata.to_account_info(),
                    authority: ctx.accounts.vault_auth.to_account_info(),
                },
                &[&[NVAULT_AUTH_SEED, &[bump]]],
            ),
            amount,
            6,
        )?;
        emit!(NaivePaid { owner, amount, n });
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct NConfig {
    pub admin: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub er_validator: Pubkey,
    pub vault_auth_bump: u8,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct NLedger {
    pub owner: Pubkey,
    pub balance: u64,
    pub funded_total: u64,
    pub requested_total: u64,
    pub cashout_count: u64,
    pub bump: u8,
}

#[event]
pub struct NaivePaid {
    pub owner: Pubkey,
    pub amount: u64,
    pub n: u64,
}

#[error_code]
pub enum NaiveError {
    #[msg("Insufficient balance")]
    Insufficient,
    #[msg("Injected fault: payout action fails")]
    InjectedFault,
    #[msg("Destination is not the owner's token account")]
    BadDestination,
    #[msg("Unauthorized")]
    Unauthorized,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + NConfig::INIT_SPACE, seeds = [NCONFIG_SEED], bump)]
    pub config: Account<'info, NConfig>,
    pub mint: Box<Account<'info, Mint>>,
    #[account(init, payer = admin, seeds = [NVAULT_SEED], bump, token::mint = mint, token::authority = vault_auth)]
    pub vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: PDA authority
    #[account(seeds = [NVAULT_AUTH_SEED], bump)]
    pub vault_auth: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Fund<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [NCONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, NConfig>,
    #[account(init, payer = owner, space = 8 + NLedger::INIT_SPACE, seeds = [NLEDGER_SEED, owner.key().as_ref()], bump)]
    pub ledger: Account<'info, NLedger>,
    #[account(address = config.mint)]
    pub mint: Box<Account<'info, Mint>>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = owner)]
    pub owner_ata: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = config.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateLedger<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [NCONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, NConfig>,
    /// CHECK: ledger PDA
    #[account(mut, del, seeds = [NLEDGER_SEED, owner.key().as_ref()], bump)]
    pub pda: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct CashOut<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [NLEDGER_SEED, owner.key().as_ref()], bump = ledger.bump, has_one = owner @ NaiveError::Unauthorized)]
    pub ledger: Account<'info, NLedger>,
    #[account(seeds = [NCONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, NConfig>,
    /// CHECK: action destination program
    #[account(address = crate::ID)]
    pub program: UncheckedAccount<'info>,
}

/// The baseline does authenticate its caller (escrow signer) — the failure it
/// demonstrates is *settlement*, not authorization.
#[action]
#[derive(Accounts)]
#[instruction(owner: Pubkey)]
pub struct NaivePayout<'info> {
    #[account(seeds = [NCONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, NConfig>,
    #[account(mut)]
    pub owner_ata: Box<Account<'info, TokenAccount>>,
    #[account(address = config.mint)]
    pub mint: Box<Account<'info, Mint>>,
    #[account(mut, address = config.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: PDA authority
    #[account(seeds = [NVAULT_AUTH_SEED], bump = config.vault_auth_bump)]
    pub vault_auth: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: scheduling program
    #[account(address = crate::ID)]
    pub source_program: UncheckedAccount<'info>,
    /// CHECK: user-paid action: escrow authority is the player
    #[account(address = owner @ NaiveError::Unauthorized)]
    pub escrow_auth: UncheckedAccount<'info>,
    /// CHECK: delegation-program-signed escrow
    #[account(signer, address = ephemeral_rollups_sdk::pda::ephemeral_balance_pda_from_payer(&escrow_auth.key(), ACTION_ESCROW_INDEX))]
    pub escrow: UncheckedAccount<'info>,
}
