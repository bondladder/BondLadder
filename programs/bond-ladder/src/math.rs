//! Арифметика комісії за управління (FR-020).

use anchor_lang::prelude::*;

use crate::errors::LadderError;
use crate::profiles::RUNG_COUNT;
use crate::state::BPS_DENOMINATOR;

/// Юліанський рік. Календарний рік дав би комісію, що стрибає у високосний
/// рік, а ставка оголошена річною, не «за 365 днів».
pub const SECONDS_PER_YEAR: u64 = 31_557_600;

pub const SECONDS_PER_DAY: u64 = 86_400;

/// Four julian years in whole days: 4 × 365.25 = 1461. The spread charges the
/// fee's year, not a calendar one — 31_557_600 / 86_400 is exactly 365.25 — and
/// a quarter of a day has no integer form, so both sides of the ratio are taken
/// over four years at once. The numerator carries the matching four.
pub const DAYS_PER_FOUR_YEARS: u64 = 1_461;

const YEARS_IN_DENOMINATOR: u128 = 4;

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

/// A rung as the exit quote sees it. The entry price has no place here: FR-013
/// quotes the exit off what the instruments are worth today, not off what the
/// route paid for them.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RungValue {
    pub units: u64,
    pub price_micro: u64,
    pub maturity_ts: i64,
}

fn days_to_maturity(maturity_ts: i64, now_ts: i64) -> u64 {
    let remaining = maturity_ts.saturating_sub(now_ts);
    if remaining <= 0 {
        return 0;
    }

    remaining.unsigned_abs() / SECONDS_PER_DAY
}

/// Value-weighted remaining duration of the position, in whole days (FR-013).
///
/// Each rung is floored to whole days before it is weighted, exactly as the
/// formula in docs/PLAN.md is written. Truncating first works against the vault,
/// and the exit screen prints this very number (FR-028) — a second convention
/// here would leave the program and the screen quoting different durations.
///
/// A rung worth nothing carries no weight, and a position worth nothing has no
/// duration to report: the spread on it is nothing either way.
pub fn weighted_remaining_days(rungs: &[RungValue; RUNG_COUNT], now_ts: i64) -> Result<u64> {
    let mut weighted = 0u128;
    let mut total_value = 0u128;

    for rung in rungs {
        let value = u128::from(rung.units)
            .checked_mul(u128::from(rung.price_micro))
            .ok_or_else(|| error!(LadderError::MathOverflow))?;

        weighted = value
            .checked_mul(u128::from(days_to_maturity(rung.maturity_ts, now_ts)))
            .and_then(|term| weighted.checked_add(term))
            .ok_or_else(|| error!(LadderError::MathOverflow))?;

        total_value = total_value
            .checked_add(value)
            .ok_or_else(|| error!(LadderError::MathOverflow))?;
    }

    if total_value == 0 {
        return Ok(0);
    }

    u64::try_from(weighted / total_value).map_err(|_| error!(LadderError::MathOverflow))
}

/// The spread withheld on an instant exit (FR-013).
///
/// The base is what the accrued fee leaves behind, not the gross value: FR-030
/// keeps the fee out of every figure in the exit quote, FR-028 counts the
/// current value among those figures, and FR-020 has this very operation settle
/// the fee. The caller hands over both parts rather than the base itself, so
/// the order of the two withholdings is not its to get wrong.
///
/// The coefficient is annual, and the position only asks the backstop to wait
/// `wrd_days` of that year — a position whose rungs have all but matured exits
/// almost free.
pub fn exit_spread(
    gross_value_micro: u64,
    fee_due_micro: u64,
    spread_coef_bps: u16,
    wrd_days: u64,
) -> Result<u64> {
    const DENOMINATOR: u128 = BPS_DENOMINATOR as u128 * DAYS_PER_FOUR_YEARS as u128;

    let numerator = u128::from(gross_value_micro.saturating_sub(fee_due_micro))
        .checked_mul(u128::from(spread_coef_bps))
        .and_then(|scaled| scaled.checked_mul(u128::from(wrd_days)))
        .and_then(|scaled| scaled.checked_mul(YEARS_IN_DENOMINATOR))
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
    const SPREAD_COEF_BPS: u16 = 200;
    const LONGEST_RUNG_DAYS: u64 = 548;

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
        assert_eq!(SECONDS_PER_DAY, wide(&fixture["secondsPerDay"]));
        assert_eq!(DAYS_PER_FOUR_YEARS, wide(&fixture["daysPerFourYears"]));
    }

    /// The spread's year and the fee's year are one year in two units. Dividing
    /// the spread by 365 days instead would have charged a different implied
    /// annual rate than the fee over the very same span, and the difference
    /// would appear only in a leap year.
    #[test]
    fn the_spread_divides_by_the_same_year_the_fee_charges() {
        assert_eq!(
            u128::from(DAYS_PER_FOUR_YEARS) * u128::from(SECONDS_PER_DAY),
            YEARS_IN_DENOMINATOR * u128::from(SECONDS_PER_YEAR)
        );
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

    fn stamp(value: &serde_json::Value) -> i64 {
        value
            .as_str()
            .expect("a timestamp is written as a string")
            .parse()
            .expect("a timestamp fits i64")
    }

    fn rungs_of(entry: &serde_json::Value) -> [RungValue; RUNG_COUNT] {
        let listed = entry["rungs"].as_array().expect("rungs is an array");
        assert_eq!(listed.len(), RUNG_COUNT, "{}", case_name(entry));

        let mut rungs = [RungValue::default(); RUNG_COUNT];
        for (slot, held) in rungs.iter_mut().zip(listed) {
            *slot = RungValue {
                units: wide(&held["units"]),
                price_micro: wide(&held["priceMicro"]),
                maturity_ts: stamp(&held["maturityTs"]),
            };
        }

        rungs
    }

    #[test]
    fn the_weighted_duration_matches_the_shared_fixture() {
        let fixture = fixture();
        let cases = fixture["weightedRemainingDays"]
            .as_array()
            .expect("weightedRemainingDays is an array");
        assert!(!cases.is_empty());

        for entry in cases {
            let wrd_days = weighted_remaining_days(&rungs_of(entry), stamp(&entry["nowTs"]))
                .expect("a fixture case does not overflow");

            assert_eq!(
                wrd_days,
                wide(&entry["expectedDays"]),
                "{}",
                case_name(entry)
            );
        }
    }

    /// A rung that has come due carries no duration, and one an hour short of a
    /// day carries none either: the day count floors on each rung before it is
    /// weighted, which is what keeps the figure on the exit screen and the
    /// figure in the program the same figure.
    #[test]
    fn a_rung_stops_counting_days_once_it_has_matured() {
        let now_ts = 1_700_000_000;

        assert_eq!(days_to_maturity(now_ts, now_ts), 0);
        assert_eq!(days_to_maturity(now_ts - 1, now_ts), 0);
        assert_eq!(days_to_maturity(i64::MIN, now_ts), 0);
        assert_eq!(days_to_maturity(now_ts + 86_399, now_ts), 0);
        assert_eq!(days_to_maturity(now_ts + 86_400, now_ts), 1);
        assert_eq!(days_to_maturity(now_ts + 172_801, now_ts), 2);
    }

    #[test]
    fn the_spread_matches_the_shared_fixture() {
        let fixture = fixture();
        let cases = fixture["spread"].as_array().expect("spread is an array");
        assert!(!cases.is_empty());

        for entry in cases {
            let withheld = exit_spread(
                wide(&entry["grossValueMicro"]),
                wide(&entry["feeDueMicro"]),
                bps(&entry["spreadCoefBps"]),
                wide(&entry["wrdDays"]),
            )
            .expect("a fixture case does not overflow");

            assert_eq!(
                withheld,
                wide(&entry["expectedMicro"]),
                "{}",
                case_name(entry)
            );
        }
    }

    #[test]
    fn spread_refusals_match_the_shared_fixture() {
        let fixture = fixture();
        let cases = fixture["spreadRefused"]
            .as_array()
            .expect("spreadRefused is an array");
        assert!(!cases.is_empty());

        for entry in cases {
            let refused = exit_spread(
                wide(&entry["grossValueMicro"]),
                wide(&entry["feeDueMicro"]),
                bps(&entry["spreadCoefBps"]),
                wide(&entry["wrdDays"]),
            );

            assert_eq!(
                error_code(refused),
                u32::from(LadderError::MathOverflow),
                "{}",
                case_name(entry)
            );
        }
    }

    /// FR-030 keeps the accrued fee out of every figure in the exit quote, and
    /// FR-020 has this very operation settle that fee, so the spread applies to
    /// what the fee leaves behind. The caller cannot get the base the other way
    /// round: it hands over the gross value and the fee separately, and the
    /// subtraction happens inside.
    #[test]
    fn the_spread_is_taken_off_what_the_fee_leaves_behind() {
        let fee_due = 5_000_000;

        let on_the_net = exit_spread(THOUSAND_USDC, fee_due, SPREAD_COEF_BPS, DAYS_PER_FOUR_YEARS)
            .expect("does not overflow");
        let on_the_gross = exit_spread(THOUSAND_USDC, 0, SPREAD_COEF_BPS, DAYS_PER_FOUR_YEARS)
            .expect("does not overflow");
        let on_the_difference = exit_spread(
            THOUSAND_USDC - fee_due,
            0,
            SPREAD_COEF_BPS,
            DAYS_PER_FOUR_YEARS,
        )
        .expect("does not overflow");

        assert_eq!(on_the_net, on_the_difference);
        assert!(on_the_net < on_the_gross);
    }

    /// Dropping the remainder works against the vault, not against the user:
    /// the spread is never above the exact figure, and never a whole micro-USDC
    /// below it either.
    #[test]
    fn the_spread_never_runs_ahead_of_the_exact_figure() {
        for wrd_days in [1, 29, 91, 365, LONGEST_RUNG_DAYS, DAYS_PER_FOUR_YEARS] {
            let withheld = u128::from(
                exit_spread(THOUSAND_USDC, 0, SPREAD_COEF_BPS, wrd_days)
                    .expect("does not overflow"),
            );
            let exact = u128::from(THOUSAND_USDC)
                * u128::from(SPREAD_COEF_BPS)
                * u128::from(wrd_days)
                * YEARS_IN_DENOMINATOR;
            let denominator = u128::from(BPS_DENOMINATOR) * u128::from(DAYS_PER_FOUR_YEARS);

            assert!(withheld * denominator <= exact, "{wrd_days} d");
            assert!(
                (withheld + 1) * denominator > exact,
                "a whole micro-USDC lost over {wrd_days} days"
            );
        }
    }

    #[test]
    fn the_spread_grows_with_remaining_duration() {
        let mut previous =
            exit_spread(THOUSAND_USDC, 0, SPREAD_COEF_BPS, 0).expect("does not overflow");
        assert_eq!(previous, 0);

        for wrd_days in [1, 91, 182, 365, LONGEST_RUNG_DAYS, DAYS_PER_FOUR_YEARS] {
            let current = exit_spread(THOUSAND_USDC, 0, SPREAD_COEF_BPS, wrd_days)
                .expect("does not overflow");

            assert!(current > previous, "{wrd_days} d");
            previous = current;
        }
    }

    /// A spread larger than the position is arithmetically reachable — a full
    /// rate over four years asks for four times the value — but the configured
    /// range never comes near it: at 200 bps the longest rung in the grid costs
    /// about a thirty-third of the value. Refusing the impossible quote belongs
    /// to the exit instruction; this is the evidence it is not this file's job.
    #[test]
    fn the_configured_spread_stays_far_under_the_position() {
        let mut rng = Rng(0x1D87_2E9F_3C5A_B741);
        let now_ts = 1_700_000_000i64;

        for position in 0..1_000u64 {
            let mut rungs = [RungValue::default(); RUNG_COUNT];
            let mut gross = 0u128;

            for slot in &mut rungs {
                let units = rng.between(50, 20_000);
                let price_micro = rng.between(900_000, 1_050_000);
                let days = rng.between(0, LONGEST_RUNG_DAYS + 1);

                *slot = RungValue {
                    units,
                    price_micro,
                    maturity_ts: now_ts
                        + i64::try_from(days * SECONDS_PER_DAY).expect("a rung inside the grid"),
                };
                gross += u128::from(units) * u128::from(price_micro);
            }

            let gross_micro = u64::try_from(gross).expect("a demo position fits u64");
            let wrd_days =
                weighted_remaining_days(&rungs, now_ts).expect("a demo position does not overflow");
            let withheld = exit_spread(gross_micro, 0, SPREAD_COEF_BPS, wrd_days)
                .expect("a demo position does not overflow");

            assert!(
                wrd_days <= LONGEST_RUNG_DAYS,
                "position {position}: duration {wrd_days} d runs past the longest rung"
            );
            // A bound alone would hold just as well over a thousand spreads of
            // nothing, so the sample has to witness that it charged something.
            assert!(
                withheld > 0,
                "position {position}: nothing withheld over {wrd_days} d"
            );
            assert!(
                u128::from(withheld) * 25 < gross,
                "position {position}: spread {withheld} takes more than a twenty-fifth of {gross_micro}"
            );
        }
    }
}
