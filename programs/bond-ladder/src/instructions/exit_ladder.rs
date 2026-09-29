use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Allocate, Assign, CreateAccount};
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use mock_issuer::state::Instrument;

use crate::errors::LadderError;
use crate::instructions::open_ladder::read_owned;
use crate::math::{self, RungValue};
use crate::profiles::RUNG_COUNT;
use crate::state::{BackstopHolding, Position, Rung, Vault, BPS_DENOMINATOR};

/// The instrument that prices the rung and the pool's holding of it.
const ACCOUNTS_PER_RUNG: usize = 2;

/// `min_payout_micro` is the quote less the tolerance the client declared
/// (FR-014). The fee keeps accruing and the remaining duration keeps
/// shrinking between the quote and the signature, so the payout is never
/// expected to match the quote exactly.
pub fn exit_ladder<'info>(
    ctx: Context<'_, '_, '_, 'info, ExitLadder<'info>>,
    share_bps: u16,
    min_payout_micro: u64,
) -> Result<()> {
    require!(
        ctx.remaining_accounts.len() == RUNG_COUNT * ACCOUNTS_PER_RUNG,
        LadderError::MissingRungAccounts
    );

    let now_ts = Clock::get()?.unix_timestamp;
    let issuer_program = ctx.accounts.vault.issuer_program;
    let held = ctx.accounts.position.rungs;

    let mut rungs = [RungValue::default(); RUNG_COUNT];
    for (index, chunk) in ctx
        .remaining_accounts
        .chunks_exact(ACCOUNTS_PER_RUNG)
        .enumerate()
    {
        let instrument: Instrument =
            read_owned(&chunk[0], &issuer_program, LadderError::ForeignAccountOwner)?;
        require_keys_eq!(
            instrument.mint,
            held[index].instrument,
            LadderError::RungInstrumentMismatch
        );

        rungs[index] = RungValue {
            units: held[index].amount,
            price_micro: instrument.price_micro,
            maturity_ts: held[index].maturity_ts,
        };
    }

    let position = &ctx.accounts.position;
    let elapsed = now_ts
        .saturating_sub(position.last_fee_ts)
        .max(0)
        .unsigned_abs();
    let fee_due = math::accrue_fee(
        math::gross_value(&rungs)?,
        ctx.accounts.vault.fee_bps,
        elapsed,
    )?
    .checked_add(position.fee_accrued)
    .ok_or_else(|| error!(LadderError::MathOverflow))?;
    let settled = math::settle_exit(
        &rungs,
        position.principal_usdc,
        fee_due,
        share_bps,
        ctx.accounts.vault.spread_coef_bps,
        now_ts,
    )?;
    require_gte!(
        settled.payout_micro,
        min_payout_micro,
        LadderError::QuoteDrift
    );

    // A pool short of the payout refuses the exit whole rather than paying
    // what it has: a smaller exit is one the owner has to choose (FR-015).
    ctx.accounts.vault.take_exit(
        settled.payout_micro,
        settled.principal_micro,
        settled.gross_value_micro,
    )?;

    for (index, chunk) in ctx
        .remaining_accounts
        .chunks_exact(ACCOUNTS_PER_RUNG)
        .enumerate()
    {
        if settled.units[index] > 0 {
            credit_holding(
                &chunk[1],
                &held[index],
                settled.units[index],
                &ctx.accounts.owner,
                &ctx.accounts.system_program,
            )?;
        }
    }

    let bump = [ctx.accounts.vault.bump];
    let vault_seeds: &[&[u8]] = &[Vault::SEED, &bump];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.backstop_usdc.to_account_info(),
                to: ctx.accounts.owner_usdc.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &[vault_seeds],
        ),
        settled.payout_micro,
    )?;

    if share_bps == BPS_DENOMINATOR {
        return ctx
            .accounts
            .position
            .close(ctx.accounts.owner.to_account_info());
    }

    let position = &mut ctx.accounts.position;
    for (rung, taken) in position.rungs.iter_mut().zip(settled.units) {
        rung.amount = rung
            .amount
            .checked_sub(taken)
            .ok_or_else(|| error!(LadderError::MathOverflow))?;
    }
    position.principal_usdc = position
        .principal_usdc
        .checked_sub(settled.principal_micro)
        .ok_or_else(|| error!(LadderError::MathOverflow))?;
    position.fee_accrued = settled.fee_carried_micro;
    position.last_fee_ts = now_ts;

    Ok(())
}

/// Holdings arrive in `remaining_accounts`, so the address is checked here
/// rather than by a seeds constraint, and the first exit through an
/// instrument creates its holding.
fn credit_holding<'info>(
    holding: &AccountInfo<'info>,
    rung: &Rung,
    units: u64,
    payer: &Signer<'info>,
    system_program: &Program<'info, System>,
) -> Result<()> {
    let (address, bump) = Pubkey::find_program_address(
        &[BackstopHolding::SEED, rung.instrument.as_ref()],
        &crate::ID,
    );
    require_keys_eq!(holding.key(), address, ErrorCode::ConstraintSeeds);

    if holding.owner == &crate::ID {
        let mut stored = BackstopHolding::try_deserialize(&mut &holding.try_borrow_data()?[..])?;
        stored.amount = stored
            .amount
            .checked_add(units)
            .ok_or_else(|| error!(LadderError::MathOverflow))?;
        return stored.try_serialize(&mut &mut holding.try_borrow_mut_data()?[..]);
    }

    create_holding(holding, bump, &rung.instrument, payer, system_program)?;
    BackstopHolding {
        instrument: rung.instrument,
        amount: units,
        maturity_ts: rung.maturity_ts,
        bump,
    }
    .try_serialize(&mut &mut holding.try_borrow_mut_data()?[..])
}

/// Anyone can send lamports to the address before the first exit, and
/// `create_account` refuses an address that has any. Topping up, allocating
/// and assigning instead keeps such a transfer from blocking every exit
/// through the instrument.
fn create_holding<'info>(
    holding: &AccountInfo<'info>,
    bump: u8,
    instrument: &Pubkey,
    payer: &Signer<'info>,
    system_program: &Program<'info, System>,
) -> Result<()> {
    let space = 8 + BackstopHolding::INIT_SPACE;
    let rent = Rent::get()?.minimum_balance(space);
    let bump = [bump];
    let seeds: &[&[u8]] = &[BackstopHolding::SEED, instrument.as_ref(), &bump];
    let program = system_program.to_account_info();

    if holding.lamports() == 0 {
        return system_program::create_account(
            CpiContext::new_with_signer(
                program,
                CreateAccount {
                    from: payer.to_account_info(),
                    to: holding.clone(),
                },
                &[seeds],
            ),
            rent,
            space as u64,
            &crate::ID,
        );
    }

    let shortfall = rent.saturating_sub(holding.lamports());
    if shortfall > 0 {
        system_program::transfer(
            CpiContext::new(
                program.clone(),
                system_program::Transfer {
                    from: payer.to_account_info(),
                    to: holding.clone(),
                },
            ),
            shortfall,
        )?;
    }
    system_program::allocate(
        CpiContext::new_with_signer(
            program.clone(),
            Allocate {
                account_to_allocate: holding.clone(),
            },
            &[seeds],
        ),
        space as u64,
    )?;
    system_program::assign(
        CpiContext::new_with_signer(
            program,
            Assign {
                account_to_assign: holding.clone(),
            },
            &[seeds],
        ),
        &crate::ID,
    )
}

/// No pause guard: the pause stops deposits and maintenance, never an exit
/// (FR-023).
#[derive(Accounts)]
pub struct ExitLadder<'info> {
    #[account(
        mut,
        seeds = [Vault::SEED],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        seeds = [Position::SEED, owner.key().as_ref(), &[position.profile.seed_byte()]],
        bump = position.bump,
    )]
    pub position: Account<'info, Position>,

    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        constraint = owner_usdc.mint == vault.usdc_mint @ LadderError::WrongUsdcMint,
    )]
    pub owner_usdc: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = vault.usdc_mint,
        associated_token::authority = vault,
    )]
    pub backstop_usdc: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,

    pub system_program: Program<'info, System>,
}
