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

/// An instrument and its rating record for every rung, in ladder order.
const ACCOUNTS_PER_RUNG: usize = 2;

/// Maintains a position (FR-018): every call checks the rating of each rung
/// against the profile and flags the ones that fell below it (FR-019), and a
/// call naming a matured rung also rolls it into the 18-month rung (FR-017).
/// The caller is paid a share of what the call serviced, and a call that
/// does neither is refused, so the reward cannot be milked (FR-029).
pub fn maintain<'info>(
    ctx: Context<'_, '_, '_, 'info, Maintain<'info>>,
    rung_index: u8,
) -> Result<()> {
    require!(!ctx.accounts.vault.paused, LadderError::VaultPaused);
    require!(
        ctx.remaining_accounts.len() == ACCOUNTS_PER_RUNG * RUNG_COUNT,
        LadderError::MissingRungAccounts
    );

    let index = usize::from(rung_index);
    require!(index < RUNG_COUNT, LadderError::RungOutOfGrid);

    let now_ts = Clock::get()?.unix_timestamp;
    let issuer_program = ctx.accounts.vault.issuer_program;
    let rating_oracle = ctx.accounts.vault.rating_oracle;
    let held = ctx.accounts.position.rungs;

    let oracle: OracleConfig = read_owned(
        &ctx.accounts.oracle_config,
        &rating_oracle,
        LadderError::RatingUnusable,
    )?;

    let mut values = [RungValue::default(); RUNG_COUNT];
    let mut issuers = [[0u8; 16]; RUNG_COUNT];
    let mut notches = [None; RUNG_COUNT];
    for (slot, rung_accounts) in ctx
        .remaining_accounts
        .chunks_exact(ACCOUNTS_PER_RUNG)
        .enumerate()
    {
        let instrument: Instrument = read_owned(
            &rung_accounts[0],
            &issuer_program,
            LadderError::ForeignAccountOwner,
        )?;
        require_keys_eq!(
            instrument.mint,
            held[slot].instrument,
            LadderError::RungInstrumentMismatch
        );

        // The oracle keeps one record per mint and never closes it, so a
        // caller cannot hand in another, staler one to keep a rung unflagged.
        let record: RatingRecord = read_owned(
            &rung_accounts[1],
            &rating_oracle,
            LadderError::RatingUnusable,
        )?;
        require_keys_eq!(
            record.instrument_mint,
            held[slot].instrument,
            LadderError::RatingMintMismatch
        );

        values[slot] = RungValue {
            units: held[slot].amount,
            price_micro: instrument.price_micro,
            maturity_ts: held[slot].maturity_ts,
        };
        issuers[slot] = instrument.issuer_id;
        notches[slot] = record
            .is_usable(now_ts, oracle.max_age_secs)
            .then_some(record.notch);
    }

    let newly_flagged = ctx.accounts.position.flag_breaches(&notches);

    // A rung an exit has whittled down to nothing has no face value to roll.
    let matured = held[index];
    let rolling = matured.amount > 0 && now_ts >= matured.maturity_ts;

    // A rung flagged on its way out is paid for by its face value.
    let mut flagged_values = [RungValue::default(); RUNG_COUNT];
    for (slot, flagged_value) in flagged_values.iter_mut().enumerate() {
        let flagged_now = !held[slot].flagged && ctx.accounts.position.rungs[slot].flagged;
        if flagged_now && !(rolling && slot == index) {
            *flagged_value = values[slot];
        }
    }
    let mut serviced = math::gross_value(&flagged_values)?;

    if rolling {
        let proceeds = roll(
            ctx.accounts,
            &ctx.remaining_accounts[index * ACCOUNTS_PER_RUNG],
            index,
            now_ts,
            &oracle,
            &values,
            &issuers,
        )?;
        serviced = serviced
            .checked_add(proceeds)
            .ok_or_else(|| error!(LadderError::MathOverflow))?;
    } else {
        require!(newly_flagged > 0, LadderError::NothingToMaintain);
    }

    pay_crank_reward(ctx.accounts, serviced)
}

/// The pool pays the reward, so the owner's cost stays the management fee
/// alone (FR-020). It pays what it has free rather than refuse: a pool spent
/// on exits must not stall the ladder.
fn pay_crank_reward(accounts: &mut Maintain, serviced_micro: u64) -> Result<()> {
    let due = math::crank_reward(serviced_micro, accounts.vault.crank_reward_bps)?;
    let reward = due.min(accounts.vault.backstop_free_usdc);
    if reward == 0 {
        return Ok(());
    }

    let bump = [accounts.vault.bump];
    let vault_seeds: &[&[u8]] = &[Vault::SEED, &bump];
    token::transfer(
        CpiContext::new_with_signer(
            accounts.token_program.to_account_info(),
            Transfer {
                from: accounts.vault_usdc.to_account_info(),
                to: accounts.caller_usdc.to_account_info(),
                authority: accounts.vault.to_account_info(),
            },
            &[vault_seeds],
        ),
        reward,
    )?;

    accounts.vault.backstop_free_usdc -= reward;

    Ok(())
}

/// The new instrument is the caller's proposal and is held to the deposit's
/// own constraints, so no caller can steer the position below its profile
/// (SC-004).
///
/// The face value pays the fee due first (FR-020), the rest buys whole units,
/// and the change below one unit's price goes back to the owner in the same
/// transaction, as it does on the deposit (FR-032). Returns the face value
/// redeemed, which is what the roll serviced.
fn roll<'info>(
    accounts: &mut Maintain<'info>,
    matured_instrument: &AccountInfo<'info>,
    index: usize,
    now_ts: i64,
    oracle: &OracleConfig,
    values: &[RungValue; RUNG_COUNT],
    issuers: &[[u8; 16]; RUNG_COUNT],
) -> Result<u64> {
    let missing = || error!(LadderError::MissingRollAccounts);
    let owner_usdc = accounts.owner_usdc.as_ref().ok_or_else(missing)?;
    let vault_usdc = &accounts.vault_usdc;
    let issuer_program = accounts.issuer_program.as_ref().ok_or_else(missing)?;
    let issuer_config = accounts.issuer_config.as_ref().ok_or_else(missing)?;
    let issuer_treasury = accounts.issuer_treasury.as_ref().ok_or_else(missing)?;
    let matured_mint = accounts.matured_mint.as_ref().ok_or_else(missing)?;
    let matured_custody = accounts.matured_custody.as_ref().ok_or_else(missing)?;
    let next_instrument = accounts.next_instrument.as_ref().ok_or_else(missing)?;
    let next_rating = accounts.next_rating.as_ref().ok_or_else(missing)?;
    let next_mint = accounts.next_mint.as_ref().ok_or_else(missing)?;
    let next_custody = accounts.next_custody.as_ref().ok_or_else(missing)?;
    let token_program = &accounts.token_program;

    let vault_key = accounts.vault.key();
    let matured = accounts.position.rungs[index];

    require_keys_eq!(
        matured_custody.owner,
        vault_key,
        LadderError::CustodyNotOwnedByVault
    );
    require_keys_eq!(
        matured_custody.mint,
        matured.instrument,
        LadderError::CustodyNotOwnedByVault
    );

    let next: Instrument = read_owned(
        next_instrument,
        &accounts.vault.issuer_program,
        LadderError::ForeignAccountOwner,
    )?;
    let record: RatingRecord = read_owned(
        next_rating,
        &accounts.vault.rating_oracle,
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
    require!(
        !accounts.position.holds_flagged(&next.mint, index),
        LadderError::InstrumentFlagged
    );
    require_keys_eq!(
        next_custody.owner,
        vault_key,
        LadderError::CustodyNotOwnedByVault
    );
    require_keys_eq!(
        next_custody.mint,
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
        accounts.position.profile,
        now_ts,
        &RollCandidate {
            issuer_id: next.issuer_id,
            maturity_ts: next.maturity_ts,
            notch: record.notch,
        },
        &staying,
    )?;

    let elapsed = now_ts
        .saturating_sub(accounts.position.last_fee_ts)
        .max(0)
        .unsigned_abs();
    let fee_due = math::accrue_fee(math::gross_value(values)?, accounts.vault.fee_bps, elapsed)?
        .checked_add(accounts.position.fee_accrued)
        .ok_or_else(|| error!(LadderError::MathOverflow))?;

    let bump = [accounts.vault.bump];
    let vault_seeds: &[&[u8]] = &[Vault::SEED, &bump];

    let proceeds = route::redeem_at_maturity(
        RedemptionVenue {
            program: issuer_program.to_account_info(),
            config: issuer_config.to_account_info(),
            instrument: matured_instrument.clone(),
            instrument_mint: matured_mint.to_account_info(),
            holder_instrument: matured_custody.to_account_info(),
            holder_usdc: vault_usdc.to_account_info(),
            venue_usdc: issuer_treasury.to_account_info(),
            authority: accounts.vault.to_account_info(),
            token_program: token_program.to_account_info(),
        },
        matured.amount,
        &[vault_seeds],
    )?;

    // What the face value cannot cover stays owed, as on a thin partial exit.
    let fee_charged = fee_due.min(proceeds);
    let budget = proceeds - fee_charged;

    let fill = route::buy_for_usdc(
        Venue {
            program: issuer_program.to_account_info(),
            config: issuer_config.to_account_info(),
            instrument: next_instrument.to_account_info(),
            instrument_mint: next_mint.to_account_info(),
            payer_usdc: vault_usdc.to_account_info(),
            venue_usdc: issuer_treasury.to_account_info(),
            destination: next_custody.to_account_info(),
            authority: accounts.vault.to_account_info(),
            token_program: token_program.to_account_info(),
        },
        budget,
        &[vault_seeds],
    )?;

    let change = budget - fill.spent_micro;
    if change > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                token_program.to_account_info(),
                Transfer {
                    from: vault_usdc.to_account_info(),
                    to: owner_usdc.to_account_info(),
                    authority: accounts.vault.to_account_info(),
                },
                &[vault_seeds],
            ),
            change,
        )?;
    }

    // The fee is protocol income and stays in the pool, as it does on an exit.
    let vault = &mut accounts.vault;
    vault.backstop_free_usdc = vault
        .backstop_free_usdc
        .checked_add(fee_charged)
        .ok_or_else(|| error!(LadderError::MathOverflow))?;

    let position = &mut accounts.position;
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

    Ok(proceeds)
}

/// No signer: anyone may maintain a position (FR-018), and every account that
/// moves money is pinned to the vault or to the position's owner, except the
/// one the reward goes to. Only the roll moves the owner's money, so a rating
/// check leaves its accounts out. The large accounts are boxed: six of them on
/// the stack overrun the SBF frame.
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
    pub owner_usdc: Option<Box<Account<'info, TokenAccount>>>,

    /// The pool's account: the face value lands here, and the purchase, the
    /// change, the fee and the reward are settled out of it within the
    /// transaction.
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
    pub issuer_program: Option<UncheckedAccount<'info>>,

    /// CHECK: an internal account of the route, which the route checks.
    #[account(owner = vault.issuer_program @ LadderError::ForeignAccountOwner)]
    pub issuer_config: Option<UncheckedAccount<'info>>,

    /// CHECK: the route's treasury, checked by the route itself.
    #[account(mut)]
    pub issuer_treasury: Option<UncheckedAccount<'info>>,

    /// CHECK: the route burns from it and checks it against the instrument.
    #[account(mut)]
    pub matured_mint: Option<UncheckedAccount<'info>>,

    #[account(mut)]
    pub matured_custody: Option<Box<Account<'info, TokenAccount>>>,

    /// CHECK: owned by the configured route and read by hand.
    pub next_instrument: Option<UncheckedAccount<'info>>,

    /// CHECK: owned by the configured oracle and read by hand.
    pub next_rating: Option<UncheckedAccount<'info>>,

    /// CHECK: the route mints from it and checks it against the instrument.
    #[account(mut)]
    pub next_mint: Option<UncheckedAccount<'info>>,

    #[account(mut)]
    pub next_custody: Option<Box<Account<'info, TokenAccount>>>,

    pub token_program: Program<'info, Token>,

    /// Anyone may call, so the reward may go to any USDC account but the
    /// pool's own.
    #[account(
        mut,
        token::mint = vault.usdc_mint,
        constraint = caller_usdc.key() != vault_usdc.key() @ LadderError::RewardIntoPool,
    )]
    pub caller_usdc: Box<Account<'info, TokenAccount>>,
}
