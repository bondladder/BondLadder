use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use mock_issuer::state::Instrument;
use rating_oracle::state::{OracleConfig, RatingRecord};

use crate::errors::LadderError;
use crate::instructions::open_ladder::read_owned;
use crate::math::{self, RungValue};
use crate::profiles::RUNG_COUNT;
use crate::route::{self, RedemptionVenue, Venue};
use crate::selection::{verify_roll, RollCandidate, ROLL_MONTHS};
use crate::state::{Position, Rung, Vault};

/// Rolls a matured rung into the 18-month rung (FR-017). The new instrument is
/// the caller's proposal and is held to the deposit's own constraints, so no
/// caller can steer the position below its profile (SC-004).
///
/// The face value pays the fee due first (FR-020), the rest buys whole units,
/// and the change below one unit's price goes back to the owner in the same
/// transaction, as it does on the deposit (FR-032).
pub fn maintain<'info>(
    ctx: Context<'_, '_, '_, 'info, Maintain<'info>>,
    rung_index: u8,
) -> Result<()> {
    require!(!ctx.accounts.vault.paused, LadderError::VaultPaused);
    require!(
        ctx.remaining_accounts.len() == RUNG_COUNT,
        LadderError::MissingRungAccounts
    );

    let index = usize::from(rung_index);
    require!(index < RUNG_COUNT, LadderError::RungOutOfGrid);

    let now_ts = Clock::get()?.unix_timestamp;
    let vault_key = ctx.accounts.vault.key();
    let issuer_program = ctx.accounts.vault.issuer_program;
    let rating_oracle = ctx.accounts.vault.rating_oracle;
    let held = ctx.accounts.position.rungs;
    let matured = held[index];

    // A rung an exit has whittled down to nothing has no face value to roll.
    require!(
        matured.amount > 0 && now_ts >= matured.maturity_ts,
        LadderError::NothingToMaintain
    );

    let mut values = [RungValue::default(); RUNG_COUNT];
    let mut issuers = [[0u8; 16]; RUNG_COUNT];
    for (slot, info) in ctx.remaining_accounts.iter().enumerate() {
        let instrument: Instrument =
            read_owned(info, &issuer_program, LadderError::ForeignAccountOwner)?;
        require_keys_eq!(
            instrument.mint,
            held[slot].instrument,
            LadderError::RungInstrumentMismatch
        );

        values[slot] = RungValue {
            units: held[slot].amount,
            price_micro: instrument.price_micro,
            maturity_ts: held[slot].maturity_ts,
        };
        issuers[slot] = instrument.issuer_id;
    }

    require_keys_eq!(
        ctx.accounts.matured_custody.owner,
        vault_key,
        LadderError::CustodyNotOwnedByVault
    );
    require_keys_eq!(
        ctx.accounts.matured_custody.mint,
        matured.instrument,
        LadderError::CustodyNotOwnedByVault
    );

    let oracle: OracleConfig = read_owned(
        &ctx.accounts.oracle_config,
        &rating_oracle,
        LadderError::RatingUnusable,
    )?;
    let next: Instrument = read_owned(
        &ctx.accounts.next_instrument,
        &issuer_program,
        LadderError::ForeignAccountOwner,
    )?;
    let record: RatingRecord = read_owned(
        &ctx.accounts.next_rating,
        &rating_oracle,
        LadderError::RatingUnusable,
    )?;
    require_keys_eq!(
        record.instrument_mint,
        next.mint,
        LadderError::RatingMintMismatch
    );
    require!(
        record.is_usable(now_ts, oracle.max_age_secs),
        LadderError::RatingUnusable
    );
    require_keys_eq!(
        ctx.accounts.next_custody.owner,
        vault_key,
        LadderError::CustodyNotOwnedByVault
    );
    require_keys_eq!(
        ctx.accounts.next_custody.mint,
        next.mint,
        LadderError::CustodyNotOwnedByVault
    );

    let mut staying = [[0u8; 16]; RUNG_COUNT - 1];
    for (slot, issuer_id) in issuers
        .iter()
        .enumerate()
        .filter(|(slot, _)| *slot != index)
        .map(|(_, issuer_id)| issuer_id)
        .enumerate()
    {
        staying[slot] = *issuer_id;
    }
    verify_roll(
        ctx.accounts.position.profile,
        now_ts,
        &RollCandidate {
            issuer_id: next.issuer_id,
            maturity_ts: next.maturity_ts,
            notch: record.notch,
        },
        &staying,
    )?;

    let elapsed = now_ts
        .saturating_sub(ctx.accounts.position.last_fee_ts)
        .max(0)
        .unsigned_abs();
    let fee_due = math::accrue_fee(
        math::gross_value(&values)?,
        ctx.accounts.vault.fee_bps,
        elapsed,
    )?
    .checked_add(ctx.accounts.position.fee_accrued)
    .ok_or_else(|| error!(LadderError::MathOverflow))?;

    let bump = [ctx.accounts.vault.bump];
    let vault_seeds: &[&[u8]] = &[Vault::SEED, &bump];

    let proceeds = route::redeem_at_maturity(
        RedemptionVenue {
            program: ctx.accounts.issuer_program.to_account_info(),
            config: ctx.accounts.issuer_config.to_account_info(),
            instrument: ctx.remaining_accounts[index].clone(),
            instrument_mint: ctx.accounts.matured_mint.to_account_info(),
            holder_instrument: ctx.accounts.matured_custody.to_account_info(),
            holder_usdc: ctx.accounts.vault_usdc.to_account_info(),
            venue_usdc: ctx.accounts.issuer_treasury.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
        },
        matured.amount,
        &[vault_seeds],
    )?;

    // What the face value cannot cover stays owed, as on a thin partial exit.
    let fee_charged = fee_due.min(proceeds);
    let budget = proceeds - fee_charged;

    let fill = route::buy_for_usdc(
        Venue {
            program: ctx.accounts.issuer_program.to_account_info(),
            config: ctx.accounts.issuer_config.to_account_info(),
            instrument: ctx.accounts.next_instrument.to_account_info(),
            instrument_mint: ctx.accounts.next_mint.to_account_info(),
            payer_usdc: ctx.accounts.vault_usdc.to_account_info(),
            venue_usdc: ctx.accounts.issuer_treasury.to_account_info(),
            destination: ctx.accounts.next_custody.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
        },
        budget,
        &[vault_seeds],
    )?;

    let change = budget - fill.spent_micro;
    if change > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault_usdc.to_account_info(),
                    to: ctx.accounts.owner_usdc.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[vault_seeds],
            ),
            change,
        )?;
    }

    // The fee is protocol income and stays in the pool, as it does on an exit.
    let vault = &mut ctx.accounts.vault;
    vault.backstop_free_usdc = vault
        .backstop_free_usdc
        .checked_add(fee_charged)
        .ok_or_else(|| error!(LadderError::MathOverflow))?;

    let position = &mut ctx.accounts.position;
    position.roll(
        index,
        Rung {
            target_months: ROLL_MONTHS,
            instrument: next.mint,
            amount: fill.units,
            entry_price_micro: next.price_micro,
            entry_notch: record.notch,
            maturity_ts: next.maturity_ts,
            flagged: false,
        },
    )?;
    position.fee_accrued = fee_due - fee_charged;
    position.last_fee_ts = now_ts;

    Ok(())
}

/// No signer: anyone may roll a matured rung (FR-018), and every account that
/// moves money is pinned to the vault or to the position's owner. The large
/// accounts are boxed: six of them on the stack overrun the SBF frame.
#[derive(Accounts)]
pub struct Maintain<'info> {
    #[account(
        mut,
        seeds = [Vault::SEED],
        bump = vault.bump,
    )]
    pub vault: Box<Account<'info, Vault>>,

    #[account(
        mut,
        seeds = [Position::SEED, position.owner.as_ref(), &[position.profile.seed_byte()]],
        bump = position.bump,
    )]
    pub position: Box<Account<'info, Position>>,

    #[account(
        mut,
        associated_token::mint = vault.usdc_mint,
        associated_token::authority = position.owner,
    )]
    pub owner_usdc: Box<Account<'info, TokenAccount>>,

    /// The pool's account: the face value lands here, and the purchase, the
    /// change and the fee are settled out of it within the transaction.
    #[account(
        mut,
        associated_token::mint = vault.usdc_mint,
        associated_token::authority = vault,
    )]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,

    /// CHECK: the rating source is configured by address (FR-002); only its
    /// ownership is checked here and the content is read by hand.
    #[account(owner = vault.rating_oracle @ LadderError::ForeignAccountOwner)]
    pub oracle_config: UncheckedAccount<'info>,

    /// CHECK: the boundary of the liquidity route (FR-021) — the vault knows
    /// only its address.
    #[account(address = vault.issuer_program)]
    pub issuer_program: UncheckedAccount<'info>,

    /// CHECK: an internal account of the route, which the route checks.
    #[account(owner = vault.issuer_program @ LadderError::ForeignAccountOwner)]
    pub issuer_config: UncheckedAccount<'info>,

    /// CHECK: the route's treasury, checked by the route itself.
    #[account(mut)]
    pub issuer_treasury: UncheckedAccount<'info>,

    /// CHECK: the route burns from it and checks it against the instrument.
    #[account(mut)]
    pub matured_mint: UncheckedAccount<'info>,

    #[account(mut)]
    pub matured_custody: Box<Account<'info, TokenAccount>>,

    /// CHECK: owned by the configured route and read by hand.
    pub next_instrument: UncheckedAccount<'info>,

    /// CHECK: owned by the configured oracle and read by hand.
    pub next_rating: UncheckedAccount<'info>,

    /// CHECK: the route mints from it and checks it against the instrument.
    #[account(mut)]
    pub next_mint: UncheckedAccount<'info>,

    #[account(mut)]
    pub next_custody: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}
