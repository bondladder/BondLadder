use anchor_lang::prelude::*;

use crate::scale::SCALE_VERSION;

#[account]
#[derive(InitSpace)]
pub struct OracleConfig {
    pub authority: Pubkey,
    pub max_age_secs: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct RatingRecord {
    pub instrument_mint: Pubkey,
    pub notch: u8,
    pub scale_version: u8,
    pub agency_code: [u8; 8],
    pub updated_at: i64,
    pub bump: u8,
}

impl OracleConfig {
    pub const SEED: &'static [u8] = b"oracle";
}

impl RatingRecord {
    pub const SEED: &'static [u8] = b"rating";

    pub fn is_fresh(&self, now: i64, max_age_secs: i64) -> bool {
        match now.checked_sub(self.updated_at) {
            Some(age) => age <= max_age_secs,
            None => false,
        }
    }

    /// Запис із чужої версії шкали трактується так само, як застарілий: та
    /// сама цифра під іншою таблицею означала б інший щабель (FR-003, FR-025).
    pub fn is_usable(&self, now: i64, max_age_secs: i64) -> bool {
        self.scale_version == SCALE_VERSION && self.is_fresh(now, max_age_secs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAX_AGE: i64 = 86_400;

    fn record_at(updated_at: i64, scale_version: u8) -> RatingRecord {
        RatingRecord {
            instrument_mint: Pubkey::default(),
            notch: 1,
            scale_version,
            agency_code: *b"MOODYS\0\0",
            updated_at,
            bump: 255,
        }
    }

    #[test]
    fn a_record_is_fresh_up_to_and_including_the_declared_age() {
        let record = record_at(1_000, crate::scale::SCALE_VERSION);

        assert!(record.is_fresh(1_000, MAX_AGE));
        assert!(record.is_fresh(1_000 + MAX_AGE, MAX_AGE));
        assert!(!record.is_fresh(1_000 + MAX_AGE + 1, MAX_AGE));
    }

    #[test]
    fn a_timestamp_from_the_future_is_not_stale() {
        let record = record_at(1_000, crate::scale::SCALE_VERSION);

        assert!(record.is_fresh(999, MAX_AGE));
    }

    #[test]
    fn an_unrepresentable_age_is_treated_as_stale() {
        let record = record_at(i64::MIN, crate::scale::SCALE_VERSION);

        assert!(!record.is_fresh(i64::MAX, MAX_AGE));
    }

    #[test]
    fn a_record_from_another_scale_is_unusable_even_while_fresh() {
        let foreign = record_at(1_000, crate::scale::SCALE_VERSION + 1);

        assert!(foreign.is_fresh(1_000, MAX_AGE));
        assert!(!foreign.is_usable(1_000, MAX_AGE));
    }

    #[test]
    fn a_record_is_usable_only_when_both_the_scale_and_the_age_hold() {
        let record = record_at(1_000, crate::scale::SCALE_VERSION);

        assert!(record.is_usable(1_000 + MAX_AGE, MAX_AGE));
        assert!(!record.is_usable(1_000 + MAX_AGE + 1, MAX_AGE));
    }
}
