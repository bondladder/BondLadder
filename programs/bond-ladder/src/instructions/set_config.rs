use anchor_lang::prelude::*;

use crate::errors::LadderError;
use crate::state::Vault;

pub fn set_rating_oracle(ctx: Context<SetRatingOracle>) -> Result<()> {
    ctx.accounts.vault.rating_oracle = ctx.accounts.rating_oracle.key();

    Ok(())
}

pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
    ctx.accounts.vault.paused = paused;

    Ok(())
}

#[derive(Accounts)]
pub struct SetRatingOracle<'info> {
    #[account(
        mut,
        seeds = [Vault::SEED],
        bump = vault.bump,
        has_one = admin,
    )]
    pub vault: Account<'info, Vault>,

    /// CHECK: те саме, що й при створенні vault — джерело задається адресою
    /// програми, і перевіряється лише те, що це програма.
    #[account(constraint = rating_oracle.executable @ LadderError::ExpectedProgram)]
    pub rating_oracle: UncheckedAccount<'info>,

    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct SetPaused<'info> {
    #[account(
        mut,
        seeds = [Vault::SEED],
        bump = vault.bump,
        has_one = admin,
    )]
    pub vault: Account<'info, Vault>,

    pub admin: Signer<'info>,
}
