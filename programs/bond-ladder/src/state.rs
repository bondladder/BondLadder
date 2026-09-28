use anchor_lang::prelude::*;

use crate::errors::LadderError;
use crate::profiles::{RiskProfile, RUNG_COUNT};

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
