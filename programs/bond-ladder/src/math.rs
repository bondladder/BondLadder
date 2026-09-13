//! Арифметика комісії за управління (FR-020).

use anchor_lang::prelude::*;

use crate::errors::LadderError;
use crate::profiles::RUNG_COUNT;
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

/// Депозит ділиться на п'ять рівних часток, а неподільний залишок додається до
/// щабля 18 місяців (FR-032). Рахує це програма, а не клієнт: `verify_proposal`
/// звіряє лише суму часток, тож рівність між собою тримається саме тут.
pub fn split_deposit(deposit_micro: u64) -> Result<[u64; RUNG_COUNT]> {
    require!(deposit_micro > 0, LadderError::ZeroDeposit);

    let share = deposit_micro / RUNG_COUNT as u64;
    let mut amounts = [share; RUNG_COUNT];
    // share × 4 ≤ deposit за побудовою, тож ані множення, ані віднімання за
    // u64 вийти не можуть — переповненню тут просто немає звідки взятись.
    amounts[RUNG_COUNT - 1] = deposit_micro - share * (RUNG_COUNT as u64 - 1);

    Ok(amounts)
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

    fn error_code<T: std::fmt::Debug>(result: Result<T>) -> u32 {
        match result.expect_err("очікувалась помилка") {
            Error::AnchorError(err) => err.error_code_number,
            Error::ProgramError(_) => panic!("очікувалась іменована помилка"),
        }
    }

    /// Той самий поділ рахує packages/shared/src/ladder.ts: клієнт показує
    /// частки до підпису, програма рахує їх заново і від клієнта не бере.
    const LADDER_FIXTURE: &str = include_str!("../../../fixtures/ladder.json");

    fn ladder_fixture() -> serde_json::Value {
        serde_json::from_str(LADDER_FIXTURE).expect("fixtures/ladder.json — валідний JSON")
    }

    /// Детермінований xorshift: набір депозитів має бути однаковий на кожному
    /// прогоні, інакше червоний тест не відтворюється.
    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            let mut state = self.0;
            state ^= state >> 12;
            state ^= state << 25;
            state ^= state >> 27;
            self.0 = state;
            state.wrapping_mul(0x2545_F491_4F6C_DD1D)
        }

        fn between(&mut self, from: u64, to: u64) -> u64 {
            from + self.next() % (to - from)
        }
    }

    #[test]
    fn the_split_matches_the_shared_fixture() {
        let fixture = ladder_fixture();
        let cases = fixture["split"].as_array().expect("split — масив");
        assert!(!cases.is_empty());

        for entry in cases {
            let expected: Vec<u64> = entry["amountsMicro"]
                .as_array()
                .expect("amountsMicro — масив")
                .iter()
                .map(wide)
                .collect();

            let split =
                split_deposit(wide(&entry["depositMicro"])).expect("випадок фікстури ділиться");

            assert_eq!(split.to_vec(), expected, "{}", case_name(entry));
        }
    }

    #[test]
    fn a_deposit_of_nothing_has_nothing_to_split() {
        assert_eq!(
            error_code(split_deposit(0)),
            u32::from(LadderError::ZeroDeposit)
        );
    }

    /// SC-005, обидві умови. Перша: п'ять часток дають депозит точно. Друга:
    /// витрачене на щаблях плюс неподільна решта, що лишається власнику, теж
    /// дає депозит точно — жодного мікро-USDC поза обліком.
    #[test]
    fn no_micro_usdc_escapes_accounting_on_a_thousand_deposits() {
        let mut rng = Rng(0x9E37_79B9_7F4A_7C15);

        for deposit in 0..1_000u64 {
            let deposit_micro = rng.between(100_000_000, 50_000_000_000);
            let split = split_deposit(deposit_micro).expect("депозит ділиться");

            assert_eq!(
                split.iter().sum::<u64>(),
                deposit_micro,
                "депозит {deposit}: частки не дають депозиту"
            );

            let mut spent_total = 0u64;
            let mut left_total = 0u64;
            let mut units_value = 0u64;
            let mut price_total = 0u64;

            for share in split {
                let price_micro = rng.between(900_000, 1_050_000);
                let spent_micro = share - share % price_micro;

                spent_total += spent_micro;
                left_total += share - spent_micro;
                units_value += (spent_micro / price_micro) * price_micro;
                price_total += price_micro;
            }

            assert_eq!(
                spent_total + left_total,
                deposit_micro,
                "депозит {deposit}: витрачене і решта не дають депозиту"
            );
            assert_eq!(
                units_value, spent_total,
                "депозит {deposit}: одиниці не покривають витраченого"
            );
            assert!(
                left_total < price_total,
                "депозит {deposit}: решта доросла до цілої одиниці"
            );
        }
    }

    /// Неподільний залишок іде у щабель 18 місяців, а не в перший (FR-032).
    #[test]
    fn the_indivisible_remainder_lands_on_the_longest_rung() {
        let split = split_deposit(1_000_000_003).expect("депозит ділиться");

        for shorter in &split[..RUNG_COUNT - 1] {
            assert_eq!(*shorter, split[0]);
        }
        assert_eq!(split[RUNG_COUNT - 1], split[0] + 3);
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
