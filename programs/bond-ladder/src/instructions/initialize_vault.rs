use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

use crate::errors::LadderError;
use crate::state::{Vault, VaultParams};

pub fn handler(ctx: Context<InitializeVault>, params: VaultParams) -> Result<()> {
    params.validate()?;

    let vault = &mut ctx.accounts.vault;
    vault.admin = ctx.accounts.admin.key();
    vault.usdc_mint = ctx.accounts.usdc_mint.key();
    vault.rating_oracle = ctx.accounts.rating_oracle.key();
    vault.issuer_program = ctx.accounts.issuer_program.key();
    vault.fee_bps = params.fee_bps;
    vault.spread_coef_bps = params.spread_coef_bps;
    vault.crank_reward_bps = params.crank_reward_bps;
    vault.min_deposit = params.min_deposit;
    vault.capacity_usdc = params.capacity_usdc;
    vault.total_principal_usdc = 0;
    vault.backstop_free_usdc = 0;
    vault.backstop_locked_value = 0;
    vault.paused = false;
    vault.bump = ctx.bumps.vault;

    Ok(())
}

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + Vault::INIT_SPACE,
        seeds = [Vault::SEED],
        bump,
    )]
    pub vault: Account<'info, Vault>,

    pub usdc_mint: Account<'info, Mint>,

    /// CHECK: адреса джерела рейтингів налаштовується, а не зашивається в код
    /// (FR-002), тож тип запису тут не фіксується — перевіряється лише те, що
    /// за адресою справді програма. Записи рейтингів звіряються з нею у тих
    /// інструкціях, які їх читають.
    #[account(constraint = rating_oracle.executable @ LadderError::ExpectedProgram)]
    pub rating_oracle: UncheckedAccount<'info>,

    /// CHECK: межа маршруту ліквідності (FR-021) — vault не знає, хто саме
    /// виконує обмін, тому й тут перевіряється лише, що це програма.
    #[account(constraint = issuer_program.executable @ LadderError::ExpectedProgram)]
    pub issuer_program: UncheckedAccount<'info>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}
