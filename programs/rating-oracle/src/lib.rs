use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

pub mod errors;
pub mod scale;
pub mod state;

use errors::OracleError;
use state::{OracleConfig, RatingRecord};

declare_id!("EWhJjvNVb5mh1Jb9DTzvTwk7BeS9qdZdK7a6vdneQPa9");

/// Джерело нормалізованих кредитних рейтингів. Самостійна програма, а не поле
/// у vault: FR-002 вимагає конфігурованої адреси джерела, FR-024 — читання
/// стороннім протоколом без позиції у vault.
#[program]
pub mod rating_oracle {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, max_age_secs: i64) -> Result<()> {
        require!(max_age_secs > 0, OracleError::InvalidMaxAge);

        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.max_age_secs = max_age_secs;
        config.bump = ctx.bumps.config;

        Ok(())
    }

    /// Приймає мітку агентства, а не готовий `notch`: нормалізація — обов'язок
    /// програми (FR-003), інакше таблиця у `scale.rs` нічого не вирішує.
    pub fn publish_rating(
        ctx: Context<PublishRating>,
        label: [u8; scale::LABEL_LEN],
        agency_code: [u8; 8],
    ) -> Result<()> {
        let notch =
            scale::notch_for_encoded_label(&label).ok_or(OracleError::UnknownRatingLabel)?;

        let record = &mut ctx.accounts.record;
        record.instrument_mint = ctx.accounts.instrument_mint.key();
        record.notch = notch;
        record.scale_version = scale::SCALE_VERSION;
        record.agency_code = agency_code;
        record.updated_at = Clock::get()?.unix_timestamp;
        record.bump = ctx.bumps.record;

        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + OracleConfig::INIT_SPACE,
        seeds = [OracleConfig::SEED],
        bump,
    )]
    pub config: Account<'info, OracleConfig>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PublishRating<'info> {
    #[account(
        seeds = [OracleConfig::SEED],
        bump = config.bump,
        has_one = authority,
    )]
    pub config: Account<'info, OracleConfig>,

    // init_if_needed тут безпечний: запис перезаписується цілком, а доступ уже
    // звужений has_one на конфізі — повторна ініціалізація не дає authority
    // нічого понад те, що він і так може зробити наступною публікацією.
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + RatingRecord::INIT_SPACE,
        seeds = [RatingRecord::SEED, instrument_mint.key().as_ref()],
        bump,
    )]
    pub record: Account<'info, RatingRecord>,

    pub instrument_mint: Account<'info, Mint>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}
