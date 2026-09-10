//! Перевірка пропозиції клієнта (FR-005, FR-006).
//!
//! Підбору тут немає: розкладку рахує клієнт, щоб показати її до підпису
//! (FR-007), а програма не приймає жодного її рядка на віру і перевіряє кожне
//! обмеження заново. `SC-004` доводиться цією перевіркою, а не тим, що клієнт
//! добре порахував.
//!
//! Свіжості рейтингу тут немає навмисно (FR-025): вона є властивістю
//! прочитаного акаунта, а не пропозиції, і живе там, де читається
//! `RatingRecord`.

use anchor_lang::prelude::*;

use crate::errors::LadderError;
use crate::profiles::{RiskProfile, RUNG_COUNT, RUNG_MONTHS};
use crate::state::BPS_DENOMINATOR;

const SECONDS_PER_DAY: i64 = 86_400;
const DAYS_PER_YEAR: i64 = 365;
const MONTHS_PER_YEAR: i64 = 12;

/// Один щабель пропозиції — те, що програма прочитала з акаунтів інструмента
/// і рейтингу, зведене до полів, від яких залежить перевірка.
#[derive(Clone, Copy, Debug)]
pub struct ProposedRung {
    pub target_months: u8,
    pub issuer_id: [u8; 16],
    pub maturity_ts: i64,
    pub notch: u8,
    pub amount_micro: u64,
}

/// Допуск щабля за FR-006.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RungWindow {
    pub target_ts: i64,
    /// Включна.
    pub from_ts: i64,
    /// Виключна: інструмент рівно на межі належить коротшому щаблю.
    pub to_ts: i64,
}

/// Ті самі дні, що в каталозі й у `packages/shared/src/ladder.ts`:
/// round(міс × 365 / 12), половина вгору.
pub fn rung_target_ts(now_ts: i64, rung_months: u8) -> Result<i64> {
    let days = (i64::from(rung_months) * DAYS_PER_YEAR + MONTHS_PER_YEAR / 2) / MONTHS_PER_YEAR;

    days.checked_mul(SECONDS_PER_DAY)
        .and_then(|offset| now_ts.checked_add(offset))
        .ok_or_else(|| error!(LadderError::MathOverflow))
}

/// Допуск виводиться із сітки, а не задається окремим числом: половина
/// відстані до сусіднього щабля з кожного боку, у крайніх — до єдиного
/// сусіда. Розсинхронити його з клієнтом немає чим, а межі пінить
/// `fixtures/ladder.json`.
pub fn rung_window(now_ts: i64, rung_months: u8) -> Result<RungWindow> {
    let index = RUNG_MONTHS
        .iter()
        .position(|months| *months == rung_months)
        .ok_or_else(|| error!(LadderError::RungOutOfGrid))?;

    let target_ts = rung_target_ts(now_ts, rung_months)?;
    let gap_down = match index.checked_sub(1) {
        Some(previous) => Some(half_gap(now_ts, RUNG_MONTHS[previous], rung_months)?),
        None => None,
    };
    let gap_up = match RUNG_MONTHS.get(index + 1) {
        Some(next) => Some(half_gap(now_ts, rung_months, *next)?),
        None => None,
    };

    // Сітка коротша за два щаблі не існує (RUNG_MONTHS), тож нуль тут
    // недосяжний — він лише закриває тип.
    let down = gap_down.or(gap_up).unwrap_or(0);
    let up = gap_up.or(gap_down).unwrap_or(0);

    Ok(RungWindow {
        target_ts,
        from_ts: target_ts
            .checked_sub(down)
            .ok_or_else(|| error!(LadderError::MathOverflow))?,
        to_ts: target_ts
            .checked_add(up)
            .ok_or_else(|| error!(LadderError::MathOverflow))?,
    })
}

fn half_gap(now_ts: i64, from_months: u8, to_months: u8) -> Result<i64> {
    let from_ts = rung_target_ts(now_ts, from_months)?;
    let to_ts = rung_target_ts(now_ts, to_months)?;

    to_ts
        .checked_sub(from_ts)
        .map(|gap| gap / 2)
        .ok_or_else(|| error!(LadderError::MathOverflow))
}

/// Вниз, як і решта арифметики: неподільний залишок робить найдовший щабель
/// більшим за рівну частку на кілька мікро-USDC, і ceil відмовляв би другому
/// щаблю того самого емітента лише через те, що депозит не поділився на п'ять.
pub fn issuer_share_bps(issuer_micro: u64, deposit_micro: u64) -> Result<u16> {
    require!(deposit_micro > 0, LadderError::ZeroDeposit);

    let share = u128::from(issuer_micro)
        .checked_mul(u128::from(BPS_DENOMINATOR))
        .ok_or_else(|| error!(LadderError::MathOverflow))?
        / u128::from(deposit_micro);

    u16::try_from(share).map_err(|_| error!(LadderError::MathOverflow))
}

/// Пропозиція приймається, лише якщо кожен щабель стоїть на своєму місці
/// сітки, рейтинг не нижчий за поріг профілю, дата погашення лежить у допуску
/// щабля, а частка жодного емітента не перевищує ліміт профілю.
pub fn verify_proposal(
    profile: RiskProfile,
    now_ts: i64,
    deposit_micro: u64,
    rungs: &[ProposedRung; RUNG_COUNT],
) -> Result<()> {
    require!(deposit_micro > 0, LadderError::ZeroDeposit);

    // Частка емітента рахується від депозиту, тож перевіряти її має сенс лише
    // після того, як частки зійшлися в депозит. Рівність часток між собою —
    // FR-032, і її тримає open_ladder, який ці частки й рахує.
    let allocated = rungs
        .iter()
        .try_fold(0u64, |sum, rung| sum.checked_add(rung.amount_micro))
        .ok_or_else(|| error!(LadderError::MathOverflow))?;
    require!(
        allocated == deposit_micro,
        LadderError::AllocationSumMismatch
    );

    for (index, rung) in rungs.iter().enumerate() {
        require!(
            rung.target_months == RUNG_MONTHS[index],
            LadderError::RungOutOfGrid
        );
        require!(
            profile.admits_rating(rung.notch),
            LadderError::RatingBelowFloor
        );

        let window = rung_window(now_ts, rung.target_months)?;
        require!(
            rung.maturity_ts >= window.from_ts && rung.maturity_ts < window.to_ts,
            LadderError::MaturityOutsideWindow
        );

        // Емітент може тримати кілька щаблів, тож його частка — це сума по
        // всій пропозиції, а не сума цього щабля.
        let held = rungs
            .iter()
            .filter(|other| other.issuer_id == rung.issuer_id)
            .try_fold(0u64, |sum, other| sum.checked_add(other.amount_micro))
            .ok_or_else(|| error!(LadderError::MathOverflow))?;
        require!(
            profile.admits_issuer_share(issuer_share_bps(held, deposit_micro)?),
            LadderError::IssuerLimitExceeded
        );
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Той самий файл читає packages/shared/src/ladder.test.ts: клієнт показує
    /// розкладку, програма її приймає, і межі допуску мусять збігтися до
    /// секунди.
    const SHARED_FIXTURE: &str = include_str!("../../../fixtures/ladder.json");

    const NOW: i64 = 1_772_000_000;
    const DEPOSIT: u64 = 1_000_000_000;

    fn fixture() -> serde_json::Value {
        serde_json::from_str(SHARED_FIXTURE).expect("fixtures/ladder.json — валідний JSON")
    }

    /// Мітки часу записані рядками: фікстур спільний з TS, а там це bigint.
    fn stamp(value: &serde_json::Value) -> i64 {
        value
            .as_str()
            .expect("очікувався рядок")
            .parse()
            .expect("очікувалась мітка часу в межах i64")
    }

    fn error_code<T: std::fmt::Debug>(result: Result<T>) -> u32 {
        match result.expect_err("очікувалась помилка") {
            Error::AnchorError(err) => err.error_code_number,
            Error::ProgramError(_) => panic!("очікувалась іменована помилка"),
        }
    }

    fn issuer(tag: u8) -> [u8; 16] {
        let mut id = [0u8; 16];
        id[0] = b'I';
        id[1] = tag;
        id
    }

    fn shares(deposit_micro: u64) -> [u64; RUNG_COUNT] {
        let share = deposit_micro / RUNG_COUNT as u64;
        let mut amounts = [share; RUNG_COUNT];
        amounts[RUNG_COUNT - 1] = deposit_micro - share * (RUNG_COUNT as u64 - 1);
        amounts
    }

    /// П'ять різних емітентів, рейтинг рівно на порозі, строк рівно в цілі.
    fn proposal(
        profile: RiskProfile,
        now_ts: i64,
        deposit_micro: u64,
    ) -> [ProposedRung; RUNG_COUNT] {
        let amounts = shares(deposit_micro);
        let mut rungs = [ProposedRung {
            target_months: 0,
            issuer_id: [0u8; 16],
            maturity_ts: 0,
            notch: 0,
            amount_micro: 0,
        }; RUNG_COUNT];

        for (index, rung) in rungs.iter_mut().enumerate() {
            let months = RUNG_MONTHS[index];
            *rung = ProposedRung {
                target_months: months,
                issuer_id: issuer(index as u8),
                maturity_ts: rung_target_ts(now_ts, months).expect("ціль щабля рахується"),
                notch: profile.worst_allowed_notch(),
                amount_micro: amounts[index],
            };
        }

        rungs
    }

    #[test]
    fn the_window_matches_the_shared_fixture() {
        let fixture = fixture();
        let reference_ts = stamp(&fixture["windowReferenceTs"]);
        let windows = fixture["windows"].as_array().expect("windows — масив");
        assert_eq!(windows.len(), RUNG_COUNT);

        for entry in windows {
            let months = u8::try_from(entry["rungMonths"].as_u64().expect("rungMonths — число"))
                .expect("u8");
            let window = rung_window(reference_ts, months).expect("щабель належить сітці");

            assert_eq!(window.target_ts, stamp(&entry["targetTs"]), "{months} міс");
            assert_eq!(window.from_ts, stamp(&entry["fromTs"]), "{months} міс");
            assert_eq!(window.to_ts, stamp(&entry["toTs"]), "{months} міс");
        }
    }

    #[test]
    fn the_grid_is_partitioned_without_gaps_or_overlap() {
        let mut previous: Option<RungWindow> = None;

        for months in RUNG_MONTHS {
            let window = rung_window(NOW, months).expect("щабель належить сітці");

            assert!(window.from_ts < window.target_ts, "{months} міс");
            assert!(window.target_ts < window.to_ts, "{months} міс");
            if let Some(previous) = previous {
                assert_eq!(previous.to_ts, window.from_ts, "{months} міс");
            }
            previous = Some(window);
        }
    }

    #[test]
    fn outer_rungs_get_a_symmetric_window() {
        for months in [RUNG_MONTHS[0], RUNG_MONTHS[RUNG_COUNT - 1]] {
            let window = rung_window(NOW, months).expect("щабель належить сітці");

            assert_eq!(
                window.target_ts - window.from_ts,
                window.to_ts - window.target_ts,
                "{months} міс"
            );
        }
    }

    /// Погашене не потрапляє в жодне вікно, тож окремої перевірки «строк ще не
    /// настав» не існує.
    #[test]
    fn no_window_opens_before_the_deposit() {
        assert!(rung_window(NOW, RUNG_MONTHS[0]).expect("сітка").from_ts > NOW);
    }

    #[test]
    fn a_month_outside_the_grid_is_not_a_rung() {
        for months in [0, 1, 7, 24, u8::MAX] {
            assert_eq!(
                error_code(rung_window(NOW, months)),
                u32::from(LadderError::RungOutOfGrid),
                "{months} міс"
            );
        }
    }

    #[test]
    fn the_issuer_share_is_rounded_down() {
        assert_eq!(
            issuer_share_bps(200_000_000, DEPOSIT).expect("рахується"),
            2_000
        );
        assert_eq!(
            issuer_share_bps(400_000_003, DEPOSIT + 3).expect("рахується"),
            4_000
        );
        assert_eq!(
            issuer_share_bps(DEPOSIT, DEPOSIT).expect("рахується"),
            10_000
        );
        assert_eq!(issuer_share_bps(0, DEPOSIT).expect("рахується"), 0);
    }

    #[test]
    fn a_proposal_within_every_constraint_passes() {
        for profile in [RiskProfile::Conservative, RiskProfile::Balanced] {
            let rungs = proposal(profile, NOW, DEPOSIT);

            verify_proposal(profile, NOW, DEPOSIT, &rungs).expect("пропозиція без порушень");
        }
    }

    #[test]
    fn a_rating_below_the_floor_is_refused() {
        for profile in [RiskProfile::Conservative, RiskProfile::Balanced] {
            for index in 0..RUNG_COUNT {
                let mut rungs = proposal(profile, NOW, DEPOSIT);
                rungs[index].notch = profile.worst_allowed_notch() + 1;

                assert_eq!(
                    error_code(verify_proposal(profile, NOW, DEPOSIT, &rungs)),
                    u32::from(LadderError::RatingBelowFloor),
                    "{profile:?} щабель {index}"
                );
            }
        }
    }

    #[test]
    fn a_maturity_on_the_lower_edge_passes_and_on_the_upper_edge_does_not() {
        let profile = RiskProfile::Conservative;

        for index in 0..RUNG_COUNT {
            let window = rung_window(NOW, RUNG_MONTHS[index]).expect("сітка");

            let mut inside = proposal(profile, NOW, DEPOSIT);
            inside[index].maturity_ts = window.from_ts;
            verify_proposal(profile, NOW, DEPOSIT, &inside).expect("нижня межа включна");

            let mut outside = proposal(profile, NOW, DEPOSIT);
            outside[index].maturity_ts = window.to_ts;
            assert_eq!(
                error_code(verify_proposal(profile, NOW, DEPOSIT, &outside)),
                u32::from(LadderError::MaturityOutsideWindow),
                "щабель {index}"
            );
        }
    }

    #[test]
    fn a_maturity_of_a_neighbouring_rung_is_refused() {
        let profile = RiskProfile::Conservative;
        let mut rungs = proposal(profile, NOW, DEPOSIT);
        rungs[0].maturity_ts = rung_target_ts(NOW, RUNG_MONTHS[1]).expect("ціль сусіда");

        assert_eq!(
            error_code(verify_proposal(profile, NOW, DEPOSIT, &rungs)),
            u32::from(LadderError::MaturityOutsideWindow)
        );
    }

    #[test]
    fn the_issuer_limit_admits_two_rungs_for_balanced_and_none_for_conservative() {
        let mut conservative = proposal(RiskProfile::Conservative, NOW, DEPOSIT);
        conservative[1].issuer_id = conservative[0].issuer_id;

        assert_eq!(
            error_code(verify_proposal(
                RiskProfile::Conservative,
                NOW,
                DEPOSIT,
                &conservative
            )),
            u32::from(LadderError::IssuerLimitExceeded)
        );

        let mut balanced = proposal(RiskProfile::Balanced, NOW, DEPOSIT);
        balanced[1].issuer_id = balanced[0].issuer_id;
        verify_proposal(RiskProfile::Balanced, NOW, DEPOSIT, &balanced)
            .expect("4000 bps — рівно ліміт збалансованого");

        balanced[2].issuer_id = balanced[0].issuer_id;
        assert_eq!(
            error_code(verify_proposal(
                RiskProfile::Balanced,
                NOW,
                DEPOSIT,
                &balanced
            )),
            u32::from(LadderError::IssuerLimitExceeded)
        );
    }

    #[test]
    fn rungs_out_of_the_grid_order_are_refused() {
        let profile = RiskProfile::Conservative;
        let mut rungs = proposal(profile, NOW, DEPOSIT);
        rungs.swap(0, 1);

        assert_eq!(
            error_code(verify_proposal(profile, NOW, DEPOSIT, &rungs)),
            u32::from(LadderError::RungOutOfGrid)
        );
    }

    /// Частка емітента рахується від депозиту, тож перевіряти її має сенс лише
    /// тоді, коли частки справді складаються в депозит.
    #[test]
    fn allocations_that_do_not_add_up_to_the_deposit_are_refused() {
        let profile = RiskProfile::Conservative;

        for delta in [-1i64, 1] {
            let mut rungs = proposal(profile, NOW, DEPOSIT);
            rungs[RUNG_COUNT - 1].amount_micro = rungs[RUNG_COUNT - 1]
                .amount_micro
                .wrapping_add_signed(delta);

            assert_eq!(
                error_code(verify_proposal(profile, NOW, DEPOSIT, &rungs)),
                u32::from(LadderError::AllocationSumMismatch),
                "{delta}"
            );
        }
    }

    #[test]
    fn a_zero_deposit_is_refused_before_any_division() {
        let profile = RiskProfile::Conservative;
        let rungs = proposal(profile, NOW, 0);

        assert_eq!(
            error_code(verify_proposal(profile, NOW, 0, &rungs)),
            u32::from(LadderError::ZeroDeposit)
        );
    }

    /// Детермінований xorshift: каталоги мають бути однакові на кожному
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

        fn below(&mut self, bound: u64) -> u64 {
            self.next() % bound
        }
    }

    /// SC-004 на 200 згенерованих каталогах: жодна сходинка з порушенням не
    /// проходить перевірку, і — щоб критерій не був порожнім — сходинка без
    /// порушень проходить.
    #[test]
    fn no_ladder_with_a_violation_passes_on_two_hundred_generated_catalogs() {
        let mut refused = 0usize;

        for catalog in 0..200u64 {
            let mut rng = Rng(0x9E37_79B9_7F4A_7C15 ^ (catalog + 1));

            for profile in [RiskProfile::Conservative, RiskProfile::Balanced] {
                let now_ts = NOW + rng.below(10_000_000) as i64;
                let deposit_micro = DEPOSIT + rng.below(5);
                let amounts = shares(deposit_micro);
                let mut rungs = proposal(profile, now_ts, deposit_micro);

                for (index, rung) in rungs.iter_mut().enumerate() {
                    let window = rung_window(now_ts, RUNG_MONTHS[index]).expect("сітка");
                    let span = (window.to_ts - window.from_ts) as u64;

                    rung.notch = 1 + rng.below(u64::from(profile.worst_allowed_notch())) as u8;
                    rung.maturity_ts = window.from_ts + rng.below(span) as i64;
                    rung.amount_micro = amounts[index];
                }

                verify_proposal(profile, now_ts, deposit_micro, &rungs)
                    .expect("каталог зібрано в межах кожного обмеження");

                let index = rng.below(RUNG_COUNT as u64) as usize;

                let mut below_floor = rungs;
                below_floor[index].notch = profile.worst_allowed_notch() + 1;
                assert_eq!(
                    error_code(verify_proposal(
                        profile,
                        now_ts,
                        deposit_micro,
                        &below_floor
                    )),
                    u32::from(LadderError::RatingBelowFloor),
                    "каталог {catalog}, щабель {index}"
                );

                let mut outside = rungs;
                outside[index].maturity_ts = rung_window(now_ts, RUNG_MONTHS[index])
                    .expect("сітка")
                    .to_ts;
                assert_eq!(
                    error_code(verify_proposal(profile, now_ts, deposit_micro, &outside)),
                    u32::from(LadderError::MaturityOutsideWindow),
                    "каталог {catalog}, щабель {index}"
                );

                // Скільки щаблів одному емітенту забагато, залежить від
                // профілю: 2000 bps проти 4000.
                let mut concentrated = rungs;
                let allowed = usize::from(profile.max_issuer_bps() / 2_000);
                for offset in 0..=allowed {
                    concentrated[(index + offset) % RUNG_COUNT].issuer_id = issuer(0xFF);
                }
                assert_eq!(
                    error_code(verify_proposal(
                        profile,
                        now_ts,
                        deposit_micro,
                        &concentrated
                    )),
                    u32::from(LadderError::IssuerLimitExceeded),
                    "каталог {catalog}, щабель {index}"
                );

                refused += 3;
            }
        }

        assert_eq!(refused, 200 * 2 * 3);
    }
}
