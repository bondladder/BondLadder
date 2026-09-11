use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};

use crate::errors::IssuerError;
use crate::state::{Fill, Instrument, IssuerConfig};

pub fn handler(ctx: Context<MintForUsdc>, amount_micro: u64) -> Result<Fill> {
    let price_micro = ctx.accounts.instrument.price_micro;
    require!(price_micro > 0, IssuerError::InvalidPrice);
    require!(
        Clock::get()?.unix_timestamp < ctx.accounts.instrument.maturity_ts,
        IssuerError::MaturityInThePast
    );

    // Округлення вниз тут — відкидання залишку, а не множення: неподільний
    // хвіст лишається платнику, і жодна дія не може вийти за u64.
    let spent_micro = amount_micro - amount_micro % price_micro;
    let units = spent_micro / price_micro;
    require!(units > 0, IssuerError::AmountBelowUnitPrice);

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.buyer_usdc.to_account_info(),
                to: ctx.accounts.treasury.to_account_info(),
                authority: ctx.accounts.buyer.to_account_info(),
            },
        ),
        spent_micro,
    )?;

    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.buyer_instrument.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            &[&[IssuerConfig::SEED, &[ctx.accounts.config.bump]]],
        ),
        units,
    )?;

    Ok(Fill { units, spent_micro })
}

#[derive(Accounts)]
pub struct MintForUsdc<'info> {
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

    #[account(
        mut,
        constraint = buyer_usdc.mint == config.usdc_mint @ IssuerError::WrongUsdcMint,
    )]
    pub buyer_usdc: Account<'info, TokenAccount>,

    // Без перевірки власника покупець вказав би скарбницею власний рахунок:
    // USDC не вийшов би з-під його контролю, а інструмент він отримав би.
    #[account(
        mut,
        constraint = treasury.mint == config.usdc_mint @ IssuerError::WrongUsdcMint,
        constraint = treasury.owner == config.key() @ IssuerError::TreasuryNotOwnedByIssuer,
    )]
    pub treasury: Account<'info, TokenAccount>,

    #[account(mut)]
    pub buyer_instrument: Account<'info, TokenAccount>,

    pub buyer: Signer<'info>,

    pub token_program: Program<'info, Token>,
}
