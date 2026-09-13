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
}
