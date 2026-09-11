use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token};

pub mod errors;
pub mod instructions;
pub mod state;

use errors::IssuerError;
use instructions::*;
use state::{Fill, Instrument, IssuerConfig};

declare_id!("EX1tNj2MLTacJPfAVzbBW8ejFsnSp7AsnZvnRLmDy3vK");

/// ДЕМО-ЗАГЛУШКА. Випускає токенізовані інструменти за USDC і викуповує їх
/// ЛИШЕ після дати погашення (FR-026). На mainnet її місце займає справжній
/// маршрут ліквідності — межа проходить по внутрішньому інтерфейсу з FR-021.
#[program]
pub mod mock_issuer {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.usdc_mint = ctx.accounts.usdc_mint.key();
        config.bump = ctx.bumps.config;

        Ok(())
    }

    pub fn register_instrument(
        ctx: Context<RegisterInstrument>,
        issuer_id: [u8; 16],
        maturity_ts: i64,
        coupon_bps: u16,
        price_micro: u64,
    ) -> Result<()> {
        require!(price_micro > 0, IssuerError::InvalidPrice);
        require!(
            maturity_ts > Clock::get()?.unix_timestamp,
            IssuerError::MaturityInThePast
        );

        let instrument = &mut ctx.accounts.instrument;
        instrument.mint = ctx.accounts.mint.key();
        instrument.issuer_id = issuer_id;
        instrument.maturity_ts = maturity_ts;
        instrument.coupon_bps = coupon_bps;
        instrument.price_micro = price_micro;
        instrument.bump = ctx.bumps.instrument;

        Ok(())
    }

    pub fn set_price(ctx: Context<SetPrice>, price_micro: u64) -> Result<()> {
        require!(price_micro > 0, IssuerError::InvalidPrice);

        ctx.accounts.instrument.price_micro = price_micro;

        Ok(())
    }

    pub fn mint_for_usdc(ctx: Context<MintForUsdc>, amount_micro: u64) -> Result<Fill> {
        instructions::mint_for_usdc::handler(ctx, amount_micro)
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + IssuerConfig::INIT_SPACE,
        seeds = [IssuerConfig::SEED],
        bump,
    )]
    pub config: Account<'info, IssuerConfig>,

    pub usdc_mint: Account<'info, Mint>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterInstrument<'info> {
    #[account(
        seeds = [IssuerConfig::SEED],
        bump = config.bump,
        has_one = authority,
    )]
    pub config: Account<'info, IssuerConfig>,

    // Мінт створює сама програма, щоб mint authority за побудовою належав
    // емітенту. Інакше можливий стан «інструмент зареєстровано, а випустити
    // його нікому», і mint_for_usdc (FR-021) падав би вже в рантаймі.
    #[account(
        init,
        payer = authority,
        mint::decimals = 0,
        mint::authority = config,
    )]
    pub mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        space = 8 + Instrument::INIT_SPACE,
        seeds = [Instrument::SEED, mint.key().as_ref()],
        bump,
    )]
    pub instrument: Account<'info, Instrument>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct SetPrice<'info> {
    #[account(
        seeds = [IssuerConfig::SEED],
        bump = config.bump,
        has_one = authority,
    )]
    pub config: Account<'info, IssuerConfig>,

    #[account(
        mut,
        seeds = [Instrument::SEED, instrument.mint.as_ref()],
        bump = instrument.bump,
    )]
    pub instrument: Account<'info, Instrument>,

    pub authority: Signer<'info>,
}
