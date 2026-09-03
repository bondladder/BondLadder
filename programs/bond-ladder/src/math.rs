//! Арифметика комісії за управління (FR-020).

use anchor_lang::prelude::*;

use crate::errors::LadderError;
use crate::state::BPS_DENOMINATOR;

/// Юліанський рік. Календарний рік дав би комісію, що стрибає у високосний
/// рік, а ставка оголошена річною, не «за 365 днів».
pub const SECONDS_PER_YEAR: u64 = 31_557_600;

/// Комісія, нарахована за `elapsed_seconds` утримання позиції вартістю
/// `value_micro`. Ділення з відкиданням залишку: vault не бере більше, ніж
/// заробив, і нарахування ніколи не перевищує точного (docs/PLAN.md).
pub fn accrue_fee(value_micro: u64, fee_bps: u16, elapsed_seconds: u64) -> Result<u64> {
    const DENOMINATOR: u128 = BPS_DENOMINATOR as u128 * SECONDS_PER_YEAR as u128;

    let numerator = u128::from(value_micro)
        .checked_mul(u128::from(fee_bps))
        .and_then(|scaled| scaled.checked_mul(u128::from(elapsed_seconds)))
        .ok_or_else(|| error!(LadderError::MathOverflow))?;

    u64::try_from(numerator / DENOMINATOR).map_err(|_| error!(LadderError::MathOverflow))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Той самий файл читає packages/shared/src/math.test.ts. Розбіжність між
    /// показаною і списаною сумою — це SC-006, тому вона має бути червоним
    /// тестом, а не знахідкою на показі.
    const SHARED_FIXTURE: &str = include_str!("../../../fixtures/math.json");

    const THOUSAND_USDC: u64 = 1_000_000_000;
    const FEE_BPS: u16 = 50;

    fn fixture() -> serde_json::Value {
        serde_json::from_str(SHARED_FIXTURE).expect("fixtures/math.json — валідний JSON")
    }

    /// Величини в u64 записані рядками: u64::MAX не переживає числа JSON.
    fn wide(value: &serde_json::Value) -> u64 {
        value
            .as_str()
            .expect("очікувався рядок")
            .parse()
            .expect("очікувалось число в межах u64")
    }

    fn bps(value: &serde_json::Value) -> u16 {
        u16::try_from(value.as_u64().expect("очікувалось число")).expect("ставка вміщається в u16")
    }

    fn case_name(entry: &serde_json::Value) -> &str {
        entry["case"].as_str().expect("case — рядок")
    }

    fn error_code(result: Result<u64>) -> u32 {
        match result.expect_err("очікувалась помилка") {
            Error::AnchorError(err) => err.error_code_number,
            Error::ProgramError(_) => panic!("очікувалась іменована помилка"),
        }
    }

    #[test]
    fn the_constants_match_the_shared_fixture() {
        let fixture = fixture();

        assert_eq!(SECONDS_PER_YEAR, wide(&fixture["secondsPerYear"]));
        assert_eq!(BPS_DENOMINATOR, bps(&fixture["bpsDenominator"]));
    }

    #[test]
    fn accrual_matches_the_shared_fixture() {
        let fixture = fixture();
        let cases = fixture["accrual"].as_array().expect("accrual — масив");
        assert!(!cases.is_empty());

        for entry in cases {
            let charged = accrue_fee(
                wide(&entry["valueMicro"]),
                bps(&entry["feeBps"]),
                wide(&entry["elapsedSeconds"]),
            )
            .expect("випадок фікстури не переповнюється");

            assert_eq!(
                charged,
                wide(&entry["expectedMicro"]),
                "{}",
                case_name(entry)
            );
        }
    }

    #[test]
    fn refusals_match_the_shared_fixture() {
        let fixture = fixture();
        let cases = fixture["refused"].as_array().expect("refused — масив");
        assert!(!cases.is_empty());

        for entry in cases {
            let refused = accrue_fee(
                wide(&entry["valueMicro"]),
                bps(&entry["feeBps"]),
                wide(&entry["elapsedSeconds"]),
            );

            assert_eq!(
                error_code(refused),
                u32::from(LadderError::MathOverflow),
                "{}",
                case_name(entry)
            );
        }
    }

    /// Ділення з відкиданням залишку працює проти vault, не проти користувача:
    /// нарахування ніколи не більше за точне, але й цілого мікро-USDC не губить.
    #[test]
    fn accrual_never_runs_ahead_of_the_exact_figure() {
        for seconds in [1, 7, 3_601, 86_401, 3_888_013, SECONDS_PER_YEAR - 1] {
            let charged =
                u128::from(accrue_fee(THOUSAND_USDC, FEE_BPS, seconds).expect("не переповнюється"));
            let exact = u128::from(THOUSAND_USDC) * u128::from(FEE_BPS) * u128::from(seconds);
            let denominator = u128::from(BPS_DENOMINATOR) * u128::from(SECONDS_PER_YEAR);

            assert!(charged * denominator <= exact, "{seconds} с");
            assert!(
                (charged + 1) * denominator > exact,
                "втрачено цілий мікро-USDC на {seconds} с"
            );
        }
    }

    #[test]
    fn accrual_grows_with_time_held() {
        let mut previous = accrue_fee(THOUSAND_USDC, FEE_BPS, 0).expect("не переповнюється");

        for seconds in [1, 86_400, 3_888_000, 8_035_200, SECONDS_PER_YEAR] {
            let current = accrue_fee(THOUSAND_USDC, FEE_BPS, seconds).expect("не переповнюється");

            assert!(current >= previous, "{seconds} с");
            previous = current;
        }
    }
}
