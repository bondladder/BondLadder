//! Межа маршруту ліквідності (FR-021).
//!
//! Вище цього модуля vault не знає, хто виконує обмін: він видає бюджет у USDC
//! і отримує назад `RouteFill`. У демо за межею стоїть `mock_issuer`
//! (FR-026), і саме тому арифметика обміну тут не повторюється — маршрут сам
//! звітує, скільки одиниць видав і скільки за них узяв.
//!
//! Звіт маршруту так само не приймається на віру, як і пропозиція клієнта:
//! бюджет — це стеля, а щабель без жодної одиниці щаблем не є.

use anchor_lang::prelude::*;
use anchor_spl::token::TokenAccount;

use crate::errors::LadderError;

/// Результат обміну так, як його бачить vault.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RouteFill {
    pub units: u64,
    pub spent_micro: u64,
}

/// Акаунти обміну в термінах vault. Хто з них чим є для конкретного
/// маршруту — знає тільки `buy_for_usdc`.
pub struct Venue<'info> {
    pub program: AccountInfo<'info>,
    pub config: AccountInfo<'info>,
    pub instrument: AccountInfo<'info>,
    pub instrument_mint: AccountInfo<'info>,
    pub payer_usdc: AccountInfo<'info>,
    pub venue_usdc: AccountInfo<'info>,
    pub destination: AccountInfo<'info>,
    pub authority: AccountInfo<'info>,
    pub token_program: AccountInfo<'info>,
}

pub fn buy_for_usdc(
    venue: Venue<'_>,
    budget_micro: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<RouteFill> {
    let fill = mock_issuer::cpi::mint_for_usdc(
        CpiContext::new_with_signer(
            venue.program,
            mock_issuer::cpi::accounts::MintForUsdc {
                config: venue.config,
                instrument: venue.instrument,
                mint: venue.instrument_mint,
                buyer_usdc: venue.payer_usdc,
                treasury: venue.venue_usdc,
                buyer_instrument: venue.destination,
                buyer: venue.authority,
                token_program: venue.token_program,
            },
            signer_seeds,
        ),
        budget_micro,
    )?
    .get();

    accept_fill(fill.units, fill.spent_micro, budget_micro)
}

/// The accounts of a redemption in the vault's terms: the holder gives up
/// instrument units and is paid USDC.
pub struct RedemptionVenue<'info> {
    pub program: AccountInfo<'info>,
    pub config: AccountInfo<'info>,
    pub instrument: AccountInfo<'info>,
    pub instrument_mint: AccountInfo<'info>,
    pub holder_instrument: AccountInfo<'info>,
    pub holder_usdc: AccountInfo<'info>,
    pub venue_usdc: AccountInfo<'info>,
    pub authority: AccountInfo<'info>,
    pub token_program: AccountInfo<'info>,
}

/// Redeems matured units and returns the USDC that actually reached the
/// holder, read off its balance rather than taken from the route's report.
pub fn redeem_at_maturity(
    venue: RedemptionVenue<'_>,
    units: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<u64> {
    let holder_usdc = venue.holder_usdc.clone();
    let before = usdc_balance(&holder_usdc)?;

    let redemption = mock_issuer::cpi::redeem_at_maturity(
        CpiContext::new_with_signer(
            venue.program,
            mock_issuer::cpi::accounts::RedeemAtMaturity {
                config: venue.config,
                instrument: venue.instrument,
                mint: venue.instrument_mint,
                holder_instrument: venue.holder_instrument,
                holder_usdc: venue.holder_usdc,
                treasury: venue.venue_usdc,
                holder: venue.authority,
                token_program: venue.token_program,
            },
            signer_seeds,
        ),
        units,
    )?
    .get();

    let received = usdc_balance(&holder_usdc)?
        .checked_sub(before)
        .ok_or_else(|| error!(LadderError::RedemptionMisreported))?;

    accept_redemption(units, redemption.units, redemption.paid_micro, received)
}

/// What the route pays for matured units (FR-026).
pub fn face_value(units: u64) -> Result<u64> {
    u128::from(units)
        .checked_mul(u128::from(mock_issuer::state::Instrument::PAR_MICRO))
        .and_then(|face| u64::try_from(face).ok())
        .ok_or_else(|| error!(LadderError::MathOverflow))
}

fn usdc_balance(account: &AccountInfo<'_>) -> Result<u64> {
    let data = account.try_borrow_data()?;

    Ok(TokenAccount::try_deserialize(&mut &data[..])?.amount)
}

pub fn accept_redemption(
    requested_units: u64,
    reported_units: u64,
    reported_paid_micro: u64,
    received_micro: u64,
) -> Result<u64> {
    require!(
        reported_units == requested_units
            && reported_paid_micro == received_micro
            && received_micro > 0,
        LadderError::RedemptionMisreported
    );

    Ok(received_micro)
}

pub fn accept_fill(units: u64, spent_micro: u64, budget_micro: u64) -> Result<RouteFill> {
    require!(spent_micro <= budget_micro, LadderError::RouteOverspent);
    require!(units > 0, LadderError::RouteFilledNothing);

    Ok(RouteFill { units, spent_micro })
}

#[cfg(test)]
mod tests {
    use super::*;

    const BUDGET: u64 = 1_000_000_000;

    fn error_code(result: Result<RouteFill>) -> u32 {
        match result.expect_err("очікувалась помилка") {
            Error::AnchorError(err) => err.error_code_number,
            Error::ProgramError(_) => panic!("очікувалась іменована помилка"),
        }
    }

    #[test]
    fn a_fill_inside_the_budget_passes_through() {
        let fill = accept_fill(1010, 999_900_000, BUDGET).expect("маршрут відпрацював");

        assert_eq!(
            fill,
            RouteFill {
                units: 1010,
                spent_micro: 999_900_000,
            }
        );
    }

    /// Маршрут має право витратити бюджет до копійки — це не перевитрата.
    #[test]
    fn a_fill_that_spends_the_whole_budget_is_accepted() {
        let fill = accept_fill(1000, BUDGET, BUDGET).expect("маршрут відпрацював");

        assert_eq!(fill.spent_micro, BUDGET);
    }

    #[test]
    fn a_route_that_overspent_the_budget_is_refused() {
        assert_eq!(
            error_code(accept_fill(1000, BUDGET + 1, BUDGET)),
            u32::from(LadderError::RouteOverspent)
        );
    }

    #[test]
    fn a_route_that_filled_nothing_is_refused() {
        assert_eq!(
            error_code(accept_fill(0, 0, BUDGET)),
            u32::from(LadderError::RouteFilledNothing)
        );
    }

    fn redemption_error(result: Result<u64>) -> u32 {
        match result.expect_err("expected a refusal") {
            Error::AnchorError(err) => err.error_code_number,
            Error::ProgramError(_) => panic!("expected a named error"),
        }
    }

    #[test]
    fn a_redemption_paid_as_reported_passes_the_payout_through() {
        assert_eq!(
            accept_redemption(200, 200, 200_000_000, 200_000_000).expect("the route paid"),
            200_000_000
        );
    }

    /// The vault spends what arrived, not what the route says arrived: a
    /// payout short of the report would be made up from the pool's USDC.
    #[test]
    fn a_redemption_that_paid_less_than_reported_is_refused() {
        assert_eq!(
            redemption_error(accept_redemption(200, 200, 200_000_000, 199_999_999)),
            u32::from(LadderError::RedemptionMisreported)
        );
    }

    #[test]
    fn a_redemption_of_other_units_than_requested_is_refused() {
        assert_eq!(
            redemption_error(accept_redemption(200, 199, 199_000_000, 199_000_000)),
            u32::from(LadderError::RedemptionMisreported)
        );
    }

    #[test]
    fn a_redemption_that_paid_nothing_is_refused() {
        assert_eq!(
            redemption_error(accept_redemption(200, 200, 0, 0)),
            u32::from(LadderError::RedemptionMisreported)
        );
    }

    #[test]
    fn the_face_value_is_one_usdc_a_unit() {
        assert_eq!(face_value(250).expect("fits"), 250_000_000);
        assert_eq!(face_value(0).expect("fits"), 0);
    }

    #[test]
    fn a_face_value_beyond_u64_is_refused() {
        assert_eq!(
            redemption_error(face_value(u64::MAX)),
            u32::from(LadderError::MathOverflow)
        );
    }
}
