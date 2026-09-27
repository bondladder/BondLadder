use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::events::{BackstopFunded, BackstopWithdrawn};
use crate::state::Vault;

pub fn fund_backstop(ctx: Context<FundBackstop>, amount_micro: u64) -> Result<()> {
    ctx.accounts.vault.fund_backstop(amount_micro)?;

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.admin_usdc.to_account_info(),
                to: ctx.accounts.backstop_usdc.to_account_info(),
                authority: ctx.accounts.admin.to_account_info(),
            },
        ),
        amount_micro,
    )?;

    emit!(BackstopFunded {
        admin: ctx.accounts.admin.key(),
        amount_micro,
        backstop_free_usdc: ctx.accounts.vault.backstop_free_usdc,
    });

    Ok(())
}

pub fn withdraw_backstop(ctx: Context<WithdrawBackstop>, amount_micro: u64) -> Result<()> {
    ctx.accounts.vault.withdraw_backstop(amount_micro)?;

    let bump = [ctx.accounts.vault.bump];
    let vault_seeds: &[&[u8]] = &[Vault::SEED, &bump];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.backstop_usdc.to_account_info(),
                to: ctx.accounts.destination.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &[vault_seeds],
        ),
        amount_micro,
    )?;

    emit!(BackstopWithdrawn {
        admin: ctx.accounts.admin.key(),
        destination: ctx.accounts.destination.key(),
        amount_micro,
        backstop_free_usdc: ctx.accounts.vault.backstop_free_usdc,
        obligations_usdc: ctx.accounts.vault.total_principal_usdc,
    });

    Ok(())
}

/// The pool is the vault's canonical USDC account, created off chain like the
/// instrument custody. Pinning the canonical address leaves exactly one
/// account behind `backstop_free_usdc`, so the counter cannot be sidestepped
/// through a second one.
#[derive(Accounts)]
pub struct FundBackstop<'info> {
    #[account(
        mut,
        seeds = [Vault::SEED],
        bump = vault.bump,
        has_one = admin,
    )]
    pub vault: Account<'info, Vault>,

    pub admin: Signer<'info>,

    #[account(mut, token::mint = vault.usdc_mint)]
    pub admin_usdc: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = vault.usdc_mint,
        associated_token::authority = vault,
    )]
    pub backstop_usdc: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct WithdrawBackstop<'info> {
    #[account(
        mut,
        seeds = [Vault::SEED],
        bump = vault.bump,
        has_one = admin,
    )]
    pub vault: Account<'info, Vault>,

    pub admin: Signer<'info>,

    #[account(
        mut,
        associated_token::mint = vault.usdc_mint,
        associated_token::authority = vault,
    )]
    pub backstop_usdc: Account<'info, TokenAccount>,

    #[account(mut, token::mint = vault.usdc_mint)]
    pub destination: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}
