use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};

use crate::errors::IssuerError;
use crate::state::{Instrument, IssuerConfig, Redemption};

pub fn redeem_at_maturity(ctx: Context<RedeemAtMaturity>, units: u64) -> Result<Redemption> {
    // The complement of mint_for_usdc, which stops issuing at maturity_ts:
    // an instrument is either for sale or redeemable, never both or neither.
    require!(
        Clock::get()?.unix_timestamp >= ctx.accounts.instrument.maturity_ts,
        IssuerError::NotYetMatured
    );
    require!(units > 0, IssuerError::NothingToRedeem);

    // A payout beyond u64 is one no token account could hold.
    let paid_micro = u128::from(units)
        .checked_mul(u128::from(Instrument::PAR_MICRO))
        .and_then(|paid| u64::try_from(paid).ok())
        .ok_or(IssuerError::TreasuryShort)?;
    require!(
        ctx.accounts.treasury.amount >= paid_micro,
        IssuerError::TreasuryShort
    );

    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.mint.to_account_info(),
                from: ctx.accounts.holder_instrument.to_account_info(),
                authority: ctx.accounts.holder.to_account_info(),
            },
        ),
        units,
    )?;

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.treasury.to_account_info(),
                to: ctx.accounts.holder_usdc.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            &[&[IssuerConfig::SEED, &[ctx.accounts.config.bump]]],
        ),
        paid_micro,
    )?;

    Ok(Redemption { units, paid_micro })
}

#[derive(Accounts)]
pub struct RedeemAtMaturity<'info> {
    #[account(
        seeds = [IssuerConfig::SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, IssuerConfig>,

    #[account(
        seeds = [Instrument::SEED, instrument.mint.as_ref()],
        bump = instrument.bump,
        has_one = mint,
    )]
    pub instrument: Account<'info, Instrument>,

    #[account(mut)]
    pub mint: Account<'info, Mint>,

    #[account(mut)]
    pub holder_instrument: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = holder_usdc.mint == config.usdc_mint @ IssuerError::WrongUsdcMint,
    )]
    pub holder_usdc: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = treasury.mint == config.usdc_mint @ IssuerError::WrongUsdcMint,
        constraint = treasury.owner == config.key() @ IssuerError::TreasuryNotOwnedByIssuer,
    )]
    pub treasury: Account<'info, TokenAccount>,

    pub holder: Signer<'info>,

    pub token_program: Program<'info, Token>,
}
