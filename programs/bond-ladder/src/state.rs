use anchor_lang::prelude::*;

use crate::errors::LadderError;
use crate::profiles::{RiskProfile, RUNG_COUNT, RUNG_MONTHS};

pub const BPS_DENOMINATOR: u16 = 10_000;

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub admin: Pubkey,
    pub usdc_mint: Pubkey,
    pub rating_oracle: Pubkey,
    pub issuer_program: Pubkey,
    pub fee_bps: u16,
    pub spread_coef_bps: u16,
    pub crank_reward_bps: u16,
    pub min_deposit: u64,
    pub capacity_usdc: u64,
    pub total_principal_usdc: u64,
    pub backstop_free_usdc: u64,
    pub backstop_locked_value: u64,
    pub paused: bool,
    pub bump: u8,
}

impl Vault {
    pub const SEED: &'static [u8] = b"vault";

    pub fn fund_backstop(&mut self, amount: u64) -> Result<()> {
        require!(amount > 0, LadderError::ZeroBackstopAmount);

        self.backstop_free_usdc = self
            .backstop_free_usdc
            .checked_add(amount)
            .ok_or_else(|| error!(LadderError::MathOverflow))?;

        Ok(())
    }

    /// The floor is the principal of every open position (FR-027): an empty
    /// pool refuses every exit (FR-015), and that would let the admin block
    /// exits, which FR-023 forbids. Only free USDC counts toward it — the
    /// instruments the pool bought back pay out at maturity, not today.
    pub fn withdraw_backstop(&mut self, amount: u64) -> Result<()> {
        require!(amount > 0, LadderError::ZeroBackstopAmount);

        let remaining = self
            .backstop_free_usdc
            .checked_sub(amount)
            .ok_or_else(|| error!(LadderError::BackstopInsufficient))?;
        require!(
            remaining >= self.total_principal_usdc,
            LadderError::BackstopBelowObligations
        );

        self.backstop_free_usdc = remaining;

        Ok(())
    }

    /// The pool pays the exit out of free USDC and takes on the instruments
    /// at today's value (FR-031), and the principal leaving the vault stops
    /// holding up the withdrawal floor. All three move or none does.
    pub fn take_exit(
        &mut self,
        payout_micro: u64,
        principal_micro: u64,
        instruments_value_micro: u64,
    ) -> Result<()> {
        let free = self
            .backstop_free_usdc
            .checked_sub(payout_micro)
            .ok_or_else(|| error!(LadderError::BackstopInsufficient))?;
        let principal = self
            .total_principal_usdc
            .checked_sub(principal_micro)
            .ok_or_else(|| error!(LadderError::MathOverflow))?;
        let locked = self
            .backstop_locked_value
            .checked_add(instruments_value_micro)
            .ok_or_else(|| error!(LadderError::MathOverflow))?;

        self.backstop_free_usdc = free;
        self.total_principal_usdc = principal;
        self.backstop_locked_value = locked;

        Ok(())
    }
}

/// Один щабель лествиці: скільки одиниць інструмента лежить у кастодії vault
/// і за яких умов вони туди потрапили. Ціна і рейтинг записані на момент
/// входу (FR-022) — пізніші зміни їх не переписують.
#[derive(
    AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug, Default, PartialEq, Eq,
)]
pub struct Rung {
    pub target_months: u8,
    pub instrument: Pubkey,
    pub amount: u64,
    pub entry_price_micro: u64,
    pub entry_notch: u8,
    pub maturity_ts: i64,
    pub flagged: bool,
}

/// Позиція користувача (FR-010): запис, закріплений за гаманцем, а не
/// переносимий токен. Кастодія інструментів пулова, тож саме цей запис і є
/// персональним обліком.
#[account]
#[derive(InitSpace)]
pub struct Position {
    pub owner: Pubkey,
    pub profile: RiskProfile,
    pub rungs: [Rung; RUNG_COUNT],
    /// Фактично вкладене, а не внесене: неподільна решта депозиту лишається
    /// власнику і в позицію не потрапляє (FR-032).
    pub principal_usdc: u64,
    pub fee_accrued: u64,
    pub last_fee_ts: i64,
    pub opened_at: i64,
    pub bump: u8,
}

impl Position {
    pub const SEED: &'static [u8] = b"position";

    /// Replaces the rung at `index` with `next` and returns the one it
    /// replaced. The ladder stays ordered by maturity, and every slot is
    /// relabelled with its place on the grid: after a roll the old 6-month
    /// rung is the one maturing next, and the dashboard reads it as such.
    pub fn roll(&mut self, index: usize, next: Rung) -> Result<Rung> {
        require!(index < RUNG_COUNT, LadderError::RungOutOfGrid);

        let matured = self.rungs[index];
        let mut rungs = [Rung::default(); RUNG_COUNT];
        let mut staying = self
            .rungs
            .iter()
            .enumerate()
            .filter(|(slot, _)| *slot != index)
            .map(|(_, rung)| *rung)
            .peekable();
        let mut placed = false;

        for (slot, months) in rungs.iter_mut().zip(RUNG_MONTHS) {
            let take_next = !placed
                && staying
                    .peek()
                    .is_none_or(|rung| rung.maturity_ts > next.maturity_ts);
            *slot = if take_next {
                placed = true;
                next
            } else {
                staying
                    .next()
                    .ok_or_else(|| error!(LadderError::RungOutOfGrid))?
            };
            slot.target_months = months;
        }

        self.rungs = rungs;

        Ok(matured)
    }

    /// Flags every rung rated below the profile floor (FR-019) and returns
    /// how many were flagged now. `None` is a rating the oracle cannot vouch
    /// for (FR-025) and gives no verdict either way. A flag is a decision to
    /// withdraw, not a mirror of the rating, so a recovery never clears it:
    /// only the rung leaving the ladder at maturity does.
    pub fn flag_breaches(&mut self, notches: &[Option<u8>; RUNG_COUNT]) -> usize {
        let profile = self.profile;
        let mut flagged = 0;
        for (rung, notch) in self.rungs.iter_mut().zip(notches) {
            let breached = notch.is_some_and(|notch| !profile.admits_rating(notch));
            if breached && rung.amount > 0 && !rung.flagged {
                rung.flagged = true;
                flagged += 1;
            }
        }

        flagged
    }

    /// Whether a rung other than `except` holds `instrument` under a flag:
    /// new money must not go into it (FR-019), even once its rating is back.
    pub fn holds_flagged(&self, instrument: &Pubkey, except: usize) -> bool {
        self.rungs
            .iter()
            .enumerate()
            .any(|(slot, rung)| slot != except && rung.flagged && rung.instrument == *instrument)
    }
}

/// Units of one instrument the backstop pool has bought back on exits and
/// holds until maturity (FR-031). The instruments themselves never move: the
/// vault's custody is pooled, so taking them over is a transfer of the record.
#[account]
#[derive(InitSpace)]
pub struct BackstopHolding {
    pub instrument: Pubkey,
    pub amount: u64,
    pub maturity_ts: i64,
    pub bump: u8,
}

impl BackstopHolding {
    pub const SEED: &'static [u8] = b"backstop";
}

/// Налаштування, з якими vault створюється. Окремою структурою, бо межі
/// депозиту перевіряються тільки разом: місткість нижча за мінімум не
/// відхиляє депозит, а робить vault непридатним (FR-009).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct VaultParams {
    pub fee_bps: u16,
    pub spread_coef_bps: u16,
    pub crank_reward_bps: u16,
    pub min_deposit: u64,
    pub capacity_usdc: u64,
}

impl VaultParams {
    pub fn validate(&self) -> Result<()> {
        require!(self.fee_bps <= BPS_DENOMINATOR, LadderError::InvalidBps);
        require!(
            self.spread_coef_bps <= BPS_DENOMINATOR,
            LadderError::InvalidBps
        );
        require!(
            self.crank_reward_bps <= BPS_DENOMINATOR,
            LadderError::InvalidBps
        );
        require!(self.min_deposit > 0, LadderError::InvalidDepositBounds);
        require!(
            self.capacity_usdc >= self.min_deposit,
            LadderError::InvalidDepositBounds
        );

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> VaultParams {
        VaultParams {
            fee_bps: 50,
            spread_coef_bps: 200,
            crank_reward_bps: 10,
            min_deposit: 100_000_000,
            capacity_usdc: 10_000_000_000,
        }
    }

    fn error_code(result: Result<()>) -> u32 {
        match result.expect_err("очікувалась помилка") {
            Error::AnchorError(err) => err.error_code_number,
            Error::ProgramError(_) => panic!("очікувалась іменована помилка"),
        }
    }

    #[test]
    fn the_demo_configuration_passes() {
        assert!(params().validate().is_ok());
    }

    #[test]
    fn a_rate_of_exactly_one_hundred_percent_is_still_a_rate() {
        let at_the_edge = VaultParams {
            fee_bps: BPS_DENOMINATOR,
            spread_coef_bps: BPS_DENOMINATOR,
            crank_reward_bps: BPS_DENOMINATOR,
            ..params()
        };

        assert!(at_the_edge.validate().is_ok());
    }

    #[test]
    fn every_rate_is_capped_on_its_own() {
        for over_the_edge in [
            VaultParams {
                fee_bps: BPS_DENOMINATOR + 1,
                ..params()
            },
            VaultParams {
                spread_coef_bps: BPS_DENOMINATOR + 1,
                ..params()
            },
            VaultParams {
                crank_reward_bps: BPS_DENOMINATOR + 1,
                ..params()
            },
        ] {
            assert_eq!(
                error_code(over_the_edge.validate()),
                u32::from(LadderError::InvalidBps)
            );
        }
    }

    #[test]
    fn a_vault_without_a_minimum_deposit_is_refused() {
        let no_minimum = VaultParams {
            min_deposit: 0,
            ..params()
        };

        assert_eq!(
            error_code(no_minimum.validate()),
            u32::from(LadderError::InvalidDepositBounds)
        );
    }

    #[test]
    fn capacity_below_the_minimum_deposit_is_refused() {
        let too_small = VaultParams {
            capacity_usdc: 99_999_999,
            min_deposit: 100_000_000,
            ..params()
        };

        assert_eq!(
            error_code(too_small.validate()),
            u32::from(LadderError::InvalidDepositBounds)
        );
    }

    #[test]
    fn capacity_equal_to_the_minimum_deposit_admits_exactly_one_deposit() {
        let exact = VaultParams {
            capacity_usdc: 100_000_000,
            min_deposit: 100_000_000,
            ..params()
        };

        assert!(exact.validate().is_ok());
    }

    const THOUSAND_USDC: u64 = 1_000_000_000;

    fn vault(backstop_free_usdc: u64, total_principal_usdc: u64) -> Vault {
        Vault {
            admin: Pubkey::default(),
            usdc_mint: Pubkey::default(),
            rating_oracle: Pubkey::default(),
            issuer_program: Pubkey::default(),
            fee_bps: 50,
            spread_coef_bps: 200,
            crank_reward_bps: 10,
            min_deposit: 100_000_000,
            capacity_usdc: 10_000_000_000,
            total_principal_usdc,
            backstop_free_usdc,
            backstop_locked_value: 7,
            paused: false,
            bump: 255,
        }
    }

    #[test]
    fn funding_adds_to_the_free_backstop_and_nothing_else() {
        let mut funded = vault(THOUSAND_USDC, 3 * THOUSAND_USDC);

        funded
            .fund_backstop(2 * THOUSAND_USDC)
            .expect("funding succeeds");

        assert_eq!(funded.backstop_free_usdc, 3 * THOUSAND_USDC);
        assert_eq!(funded.total_principal_usdc, 3 * THOUSAND_USDC);
        assert_eq!(funded.backstop_locked_value, 7);
    }

    #[test]
    fn funding_that_overflows_the_counter_is_refused() {
        let mut full = vault(u64::MAX, 0);

        assert_eq!(
            error_code(full.fund_backstop(1)),
            u32::from(LadderError::MathOverflow)
        );
        assert_eq!(full.backstop_free_usdc, u64::MAX);
    }

    /// FR-027 keeps the admin above the obligations of the open positions:
    /// an empty pool refuses every exit (FR-015), and blocking exits is the one
    /// thing the admin must not be able to do (FR-023).
    #[test]
    fn the_admin_withdraws_down_to_the_open_principal_and_not_a_unit_further() {
        let mut surplus = vault(5 * THOUSAND_USDC, 3 * THOUSAND_USDC);

        surplus
            .withdraw_backstop(2 * THOUSAND_USDC)
            .expect("the surplus is the admin's");
        assert_eq!(surplus.backstop_free_usdc, 3 * THOUSAND_USDC);

        assert_eq!(
            error_code(surplus.withdraw_backstop(1)),
            u32::from(LadderError::BackstopBelowObligations)
        );
        assert_eq!(surplus.backstop_free_usdc, 3 * THOUSAND_USDC);
    }

    #[test]
    fn a_pool_with_no_open_positions_can_be_emptied() {
        let mut idle = vault(THOUSAND_USDC, 0);

        idle.withdraw_backstop(THOUSAND_USDC)
            .expect("nothing is owed");

        assert_eq!(idle.backstop_free_usdc, 0);
    }

    /// Instruments the pool bought back mature into USDC only later, so they
    /// cover no exit today: the floor is held by free USDC alone.
    #[test]
    fn instruments_held_by_the_pool_do_not_count_toward_the_floor() {
        let mut underfunded = vault(THOUSAND_USDC, THOUSAND_USDC);
        underfunded.backstop_locked_value = 10 * THOUSAND_USDC;

        assert_eq!(
            error_code(underfunded.withdraw_backstop(1)),
            u32::from(LadderError::BackstopBelowObligations)
        );
    }

    #[test]
    fn more_than_the_pool_holds_is_refused_as_insufficient() {
        let mut short = vault(THOUSAND_USDC, 0);

        assert_eq!(
            error_code(short.withdraw_backstop(THOUSAND_USDC + 1)),
            u32::from(LadderError::BackstopInsufficient)
        );
        assert_eq!(short.backstop_free_usdc, THOUSAND_USDC);
    }

    #[test]
    fn a_transfer_of_nothing_is_refused_both_ways() {
        let mut pool = vault(THOUSAND_USDC, 0);

        assert_eq!(
            error_code(pool.fund_backstop(0)),
            u32::from(LadderError::ZeroBackstopAmount)
        );
        assert_eq!(
            error_code(pool.withdraw_backstop(0)),
            u32::from(LadderError::ZeroBackstopAmount)
        );
    }

    /// FR-031: the pool pays out free USDC and takes on the instruments, and
    /// the principal leaving the vault stops counting toward the floor, or the
    /// floor would outlive the positions it protects (FR-027).
    #[test]
    fn an_exit_moves_all_three_pool_counters_at_once() {
        let mut pool = vault(5 * THOUSAND_USDC, 3 * THOUSAND_USDC);

        pool.take_exit(980_000_000, THOUSAND_USDC, 1_010_000_000)
            .expect("the pool covers the exit");

        assert_eq!(pool.backstop_free_usdc, 5 * THOUSAND_USDC - 980_000_000);
        assert_eq!(pool.total_principal_usdc, 2 * THOUSAND_USDC);
        assert_eq!(pool.backstop_locked_value, 7 + 1_010_000_000);
    }

    #[test]
    fn an_exit_the_pool_cannot_cover_changes_nothing() {
        let mut short = vault(THOUSAND_USDC, 3 * THOUSAND_USDC);

        assert_eq!(
            error_code(short.take_exit(THOUSAND_USDC + 1, THOUSAND_USDC, THOUSAND_USDC)),
            u32::from(LadderError::BackstopInsufficient)
        );
        assert_eq!(short.backstop_free_usdc, THOUSAND_USDC);
        assert_eq!(short.total_principal_usdc, 3 * THOUSAND_USDC);
        assert_eq!(short.backstop_locked_value, 7);
    }

    const DAY: i64 = 86_400;
    const OPENED_AT: i64 = 1_800_000_000;
    const DAYS: [i64; RUNG_COUNT] = [91, 183, 274, 365, 548];

    fn rung(tag: u8, months: u8, maturity_ts: i64) -> Rung {
        Rung {
            target_months: months,
            instrument: Pubkey::new_from_array([tag; 32]),
            amount: 200 + u64::from(tag),
            entry_price_micro: 990_000 - u64::from(tag),
            entry_notch: tag,
            maturity_ts,
            flagged: false,
        }
    }

    fn ladder() -> Position {
        let mut rungs = [Rung::default(); RUNG_COUNT];
        for (index, slot) in rungs.iter_mut().enumerate() {
            *slot = rung(
                index as u8 + 1,
                RUNG_MONTHS[index],
                OPENED_AT + DAYS[index] * DAY,
            );
        }

        Position {
            owner: Pubkey::default(),
            profile: RiskProfile::Balanced,
            rungs,
            principal_usdc: 1_000_000_000,
            fee_accrued: 0,
            last_fee_ts: OPENED_AT,
            opened_at: OPENED_AT,
            bump: 254,
        }
    }

    fn labels(position: &Position) -> [u8; RUNG_COUNT] {
        position.rungs.map(|rung| rung.target_months)
    }

    fn tags(position: &Position) -> [u8; RUNG_COUNT] {
        position.rungs.map(|rung| rung.instrument.to_bytes()[0])
    }

    /// The ladder after a roll reads as it did after the deposit: nearest
    /// maturity first, every slot labelled with its place on the grid.
    #[test]
    fn rolling_the_nearest_rung_shifts_the_rest_down_and_appends_the_new_one() {
        let mut position = ladder();
        let before = position.rungs;
        let rolled_at = OPENED_AT + DAYS[0] * DAY;
        let next = rung(9, 18, rolled_at + 548 * DAY);

        let matured = position.roll(0, next).expect("the rung is in the ladder");

        assert_eq!(matured, before[0]);
        assert_eq!(tags(&position), [2, 3, 4, 5, 9]);
        assert_eq!(labels(&position), RUNG_MONTHS);
        for (slot, shifted) in position.rungs[..RUNG_COUNT - 1].iter().enumerate() {
            assert_eq!(
                Rung {
                    target_months: before[slot + 1].target_months,
                    ..*shifted
                },
                before[slot + 1],
                "only the label of a shifted rung changes"
            );
        }
        assert_eq!(
            position.rungs[RUNG_COUNT - 1],
            Rung {
                target_months: 18,
                ..next
            }
        );
    }

    /// The 18-month window is wide enough for the new instrument to mature
    /// before the old longest rung does; the ladder stays ordered anyway.
    #[test]
    fn a_new_rung_shorter_than_the_old_longest_takes_its_place_by_maturity() {
        let mut position = ladder();
        let next = rung(9, 18, OPENED_AT + DAYS[4] * DAY - 1);

        position.roll(0, next).expect("the rung is in the ladder");

        assert_eq!(tags(&position), [2, 3, 4, 9, 5]);
        assert_eq!(labels(&position), RUNG_MONTHS);
    }

    #[test]
    fn a_new_rung_maturing_with_the_old_longest_goes_after_it() {
        let mut position = ladder();
        let next = rung(9, 18, OPENED_AT + DAYS[4] * DAY);

        position.roll(0, next).expect("the rung is in the ladder");

        assert_eq!(tags(&position), [2, 3, 4, 5, 9]);
    }

    /// A keeper that was down for months finds a later rung matured first,
    /// as can a rung of the same maturity listed further down.
    #[test]
    fn a_rung_other_than_the_nearest_can_be_rolled() {
        let mut position = ladder();
        let before = position.rungs;
        let next = rung(9, 18, OPENED_AT + 700 * DAY);

        let matured = position.roll(2, next).expect("the rung is in the ladder");

        assert_eq!(matured, before[2]);
        assert_eq!(tags(&position), [1, 2, 4, 5, 9]);
        assert_eq!(labels(&position), RUNG_MONTHS);
    }

    #[test]
    fn an_index_outside_the_ladder_changes_nothing() {
        let mut position = ladder();
        let before = position.rungs;

        assert_eq!(
            error_code(
                position
                    .roll(RUNG_COUNT, rung(9, 18, OPENED_AT))
                    .map(|_| ())
            ),
            u32::from(LadderError::RungOutOfGrid)
        );
        assert_eq!(position.rungs, before);
    }

    fn floor() -> u8 {
        RiskProfile::Balanced.worst_allowed_notch()
    }

    fn flags(position: &Position) -> [bool; RUNG_COUNT] {
        position.rungs.map(|rung| rung.flagged)
    }

    #[test]
    fn a_rung_rated_below_the_profile_floor_is_flagged() {
        let mut position = ladder();
        let mut notches = [Some(floor()); RUNG_COUNT];
        notches[2] = Some(floor() + 1);

        assert_eq!(position.flag_breaches(&notches), 1);
        assert_eq!(flags(&position), [false, false, true, false, false]);
    }

    #[test]
    fn a_rating_exactly_on_the_floor_flags_nothing() {
        let mut position = ladder();

        assert_eq!(position.flag_breaches(&[Some(floor()); RUNG_COUNT]), 0);
        assert_eq!(flags(&position), [false; RUNG_COUNT]);
    }

    /// An oracle that has lapsed says nothing about the rung, and a verdict
    /// drawn from silence would flag every position of the vault at once.
    #[test]
    fn a_rung_without_a_usable_rating_is_left_as_it_is() {
        let mut position = ladder();
        position.rungs[1].flagged = true;

        assert_eq!(position.flag_breaches(&[None; RUNG_COUNT]), 0);
        assert_eq!(flags(&position), [false, true, false, false, false]);
    }

    #[test]
    fn a_rung_already_flagged_is_not_counted_again() {
        let mut position = ladder();
        position.rungs[3].flagged = true;
        let notches = [Some(floor() + 1); RUNG_COUNT];

        assert_eq!(position.flag_breaches(&notches), 4);
        assert_eq!(flags(&position), [true; RUNG_COUNT]);
    }

    #[test]
    fn a_recovered_rating_does_not_clear_the_flag() {
        let mut position = ladder();
        position.rungs[0].flagged = true;

        assert_eq!(position.flag_breaches(&[Some(1); RUNG_COUNT]), 0);
        assert!(position.rungs[0].flagged);
    }

    /// An exit can whittle a rung down to nothing; there is no money left in
    /// it to withdraw, so flagging it would be maintenance of nothing.
    #[test]
    fn an_emptied_rung_is_not_flagged() {
        let mut position = ladder();
        position.rungs[4].amount = 0;

        assert_eq!(
            position.flag_breaches(&[Some(floor() + 1); RUNG_COUNT]),
            RUNG_COUNT - 1
        );
        assert!(!position.rungs[4].flagged);
    }

    #[test]
    fn an_instrument_flagged_on_a_staying_rung_is_found() {
        let mut position = ladder();
        position.rungs[4].flagged = true;
        let instrument = position.rungs[4].instrument;

        assert!(position.holds_flagged(&instrument, 0));
        assert!(!position.holds_flagged(&position.rungs[3].instrument, 0));
    }

    /// The rung being rolled leaves the ladder in the same transaction, so its
    /// own flag does not hold the instrument it is rolled out of.
    #[test]
    fn the_flag_of_the_rung_being_rolled_does_not_count() {
        let mut position = ladder();
        position.rungs[0].flagged = true;
        let instrument = position.rungs[0].instrument;

        assert!(!position.holds_flagged(&instrument, 0));
        assert!(position.holds_flagged(&instrument, 1));
    }

    #[test]
    fn an_exit_of_more_principal_than_the_vault_holds_changes_nothing() {
        let mut pool = vault(5 * THOUSAND_USDC, THOUSAND_USDC);

        assert_eq!(
            error_code(pool.take_exit(1, THOUSAND_USDC + 1, 1)),
            u32::from(LadderError::MathOverflow)
        );
        assert_eq!(pool.backstop_free_usdc, 5 * THOUSAND_USDC);
        assert_eq!(pool.total_principal_usdc, THOUSAND_USDC);
        assert_eq!(pool.backstop_locked_value, 7);
    }
}
