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
}
