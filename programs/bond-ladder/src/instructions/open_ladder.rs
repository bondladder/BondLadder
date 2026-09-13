use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};
use mock_issuer::state::Instrument;
use rating_oracle::state::{OracleConfig, RatingRecord};

use crate::errors::LadderError;
use crate::events::LadderOpened;
use crate::math;
use crate::profiles::{RiskProfile, RUNG_COUNT, RUNG_MONTHS};
use crate::route::{self, Venue};
use crate::selection::{verify_proposal, ProposedRung};
use crate::state::{Position, Rung, Vault};

/// Інструмент, рейтинг, мінт і кастодія — по одному щаблю.
const ACCOUNTS_PER_RUNG: usize = 4;

pub fn open_ladder<'info>(
    ctx: Context<'_, '_, '_, 'info, OpenLadder<'info>>,
    profile: RiskProfile,
    deposit_micro: u64,
) -> Result<()> {
    let vault_key = ctx.accounts.vault.key();
    let rating_oracle = ctx.accounts.vault.rating_oracle;
    let issuer_program = ctx.accounts.vault.issuer_program;

    require!(!ctx.accounts.vault.paused, LadderError::VaultPaused);
    require!(
        deposit_micro >= ctx.accounts.vault.min_deposit,
        LadderError::DepositBelowMinimum
    );
    require!(
        ctx.accounts
            .vault
            .total_principal_usdc
            .checked_add(deposit_micro)
            .ok_or_else(|| error!(LadderError::MathOverflow))?
            <= ctx.accounts.vault.capacity_usdc,
        LadderError::VaultCapacityExceeded
    );
    require!(
        ctx.remaining_accounts.len() == RUNG_COUNT * ACCOUNTS_PER_RUNG,
        LadderError::MissingRungAccounts
    );

    let now_ts = Clock::get()?.unix_timestamp;
    let oracle: OracleConfig = read_owned(
        &ctx.accounts.oracle_config,
        &rating_oracle,
        LadderError::RatingUnusable,
    )?;
    let shares = math::split_deposit(deposit_micro)?;
    let token_program = ctx.accounts.token_program.key();

    // Пропозиція перевіряється цілком до першого руху коштів: депозит
    // атомарний, часткової лествиці не буває (FR-008).
    let mut proposed = [ProposedRung {
        target_months: 0,
        issuer_id: [0u8; 16],
        maturity_ts: 0,
        notch: 0,
        amount_micro: 0,
    }; RUNG_COUNT];
    let mut entry_price = [0u64; RUNG_COUNT];

    for (index, chunk) in ctx
        .remaining_accounts
        .chunks_exact(ACCOUNTS_PER_RUNG)
        .enumerate()
    {
        let instrument: Instrument =
            read_owned(&chunk[0], &issuer_program, LadderError::ForeignAccountOwner)?;
        let record: RatingRecord =
            read_owned(&chunk[1], &rating_oracle, LadderError::RatingUnusable)?;
        let custody: TokenAccount = read_owned(
            &chunk[3],
            &token_program,
            LadderError::CustodyNotOwnedByVault,
        )?;

        require_keys_eq!(
            record.instrument_mint,
            instrument.mint,
            LadderError::RatingMintMismatch
        );
        require!(
            record.is_usable(now_ts, oracle.max_age_secs),
            LadderError::RatingUnusable
        );

        // Куплене має лягти під vault, інакше позиція лишилась би записом про
        // інструменти, яких у vault немає.
        require_keys_eq!(
            custody.owner,
            vault_key,
            LadderError::CustodyNotOwnedByVault
        );
        require_keys_eq!(
            custody.mint,
            instrument.mint,
            LadderError::CustodyNotOwnedByVault
        );

        proposed[index] = ProposedRung {
            target_months: RUNG_MONTHS[index],
            issuer_id: instrument.issuer_id,
            maturity_ts: instrument.maturity_ts,
            notch: record.notch,
            amount_micro: shares[index],
        };
        entry_price[index] = instrument.price_micro;
    }

    verify_proposal(profile, now_ts, deposit_micro, &proposed)?;

    let mut principal_usdc = 0u64;
    let mut rungs = [Rung::default(); RUNG_COUNT];

    for (index, chunk) in ctx
        .remaining_accounts
        .chunks_exact(ACCOUNTS_PER_RUNG)
        .enumerate()
    {
        let fill = route::buy_for_usdc(
            Venue {
                program: ctx.accounts.issuer_program.to_account_info(),
                config: ctx.accounts.issuer_config.to_account_info(),
                instrument: chunk[0].clone(),
                instrument_mint: chunk[2].clone(),
                payer_usdc: ctx.accounts.owner_usdc.to_account_info(),
                venue_usdc: ctx.accounts.issuer_treasury.to_account_info(),
                destination: chunk[3].clone(),
                authority: ctx.accounts.owner.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
            shares[index],
            &[],
        )?;

        principal_usdc = principal_usdc
            .checked_add(fill.spent_micro)
            .ok_or_else(|| error!(LadderError::MathOverflow))?;

        rungs[index] = Rung {
            target_months: RUNG_MONTHS[index],
            instrument: chunk[2].key(),
            amount: fill.units,
            entry_price_micro: entry_price[index],
            entry_notch: proposed[index].notch,
            maturity_ts: proposed[index].maturity_ts,
            flagged: false,
        };
    }

    let position = &mut ctx.accounts.position;
    position.owner = ctx.accounts.owner.key();
    position.profile = profile;
    position.rungs = rungs;
    position.principal_usdc = principal_usdc;
    position.fee_accrued = 0;
    position.last_fee_ts = now_ts;
    position.opened_at = now_ts;
    position.bump = ctx.bumps.position;

    let vault = &mut ctx.accounts.vault;
    vault.total_principal_usdc = vault
        .total_principal_usdc
        .checked_add(principal_usdc)
        .ok_or_else(|| error!(LadderError::MathOverflow))?;

    emit!(LadderOpened {
        owner: ctx.accounts.owner.key(),
        profile,
        deposit_micro,
        principal_usdc,
        rungs,
        opened_at: now_ts,
    });

    Ok(())
}

/// Акаунти пропозиції приходять у `remaining_accounts`, тож належність
/// програмі перевіряється тут, а не Anchor-обмеженням. Адреса програми
/// береться з vault (FR-002, FR-021), а не з `declare_id!` сусіда.
fn read_owned<T: AccountDeserialize>(
    info: &AccountInfo<'_>,
    owner: &Pubkey,
    malformed: LadderError,
) -> Result<T> {
    require_keys_eq!(*info.owner, *owner, LadderError::ForeignAccountOwner);

    let data = info.try_borrow_data()?;

    T::try_deserialize(&mut &data[..]).map_err(|_| error!(malformed))
}

#[derive(Accounts)]
#[instruction(profile: RiskProfile)]
pub struct OpenLadder<'info> {
    #[account(
        mut,
        seeds = [Vault::SEED],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        init,
        payer = owner,
        space = 8 + Position::INIT_SPACE,
        seeds = [Position::SEED, owner.key().as_ref(), &[profile.seed_byte()]],
        bump,
    )]
    pub position: Account<'info, Position>,

    #[account(mut)]
    pub owner: Signer<'info>,

    // Власник платить маршруту напряму: vault списує рівно те, що вкладає, і
    // неподільна решта з гаманця не йде взагалі (FR-032).
    #[account(
        mut,
        constraint = owner_usdc.mint == vault.usdc_mint @ LadderError::WrongUsdcMint,
    )]
    pub owner_usdc: Account<'info, TokenAccount>,

    /// CHECK: джерело рейтингів задається адресою (FR-002), тому тип тут не
    /// фіксується — перевіряється лише те, що конфіг належить налаштованій
    /// програмі, а вміст читається вручну.
    #[account(owner = vault.rating_oracle @ LadderError::ForeignAccountOwner)]
    pub oracle_config: UncheckedAccount<'info>,

    /// CHECK: межа маршруту ліквідності (FR-021) — vault знає лише адресу.
    #[account(address = vault.issuer_program)]
    pub issuer_program: UncheckedAccount<'info>,

    /// CHECK: внутрішній акаунт маршруту, який маршрут і перевіряє.
    #[account(owner = vault.issuer_program @ LadderError::ForeignAccountOwner)]
    pub issuer_config: UncheckedAccount<'info>,

    /// CHECK: скарбниця маршруту. Належність емітенту перевіряє сам маршрут —
    /// vault про його внутрішній устрій не знає.
    #[account(mut)]
    pub issuer_treasury: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,

    pub system_program: Program<'info, System>,
}
