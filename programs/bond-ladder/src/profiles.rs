//! Пороги профілів (FR-004) і сітка строків лествиці (FR-006).

use rating_oracle::scale;

/// Сітка строків до профілю не належить: профіль впливає на кредитну якість,
/// а не на дюрацію (FR-006).
pub const RUNG_MONTHS: [u8; 5] = [3, 6, 9, 12, 18];

pub const RUNG_COUNT: usize = RUNG_MONTHS.len();

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RiskProfile {
    Conservative,
    Balanced,
}

impl RiskProfile {
    pub const fn worst_allowed_notch(self) -> u8 {
        match self {
            Self::Conservative => 7,
            Self::Balanced => 10,
        }
    }

    /// Депозит ділиться на п'ять рівних часток (FR-032), тому частка одного
    /// емітента кратна 2000 bps: 2000 — п'ять різних емітентів, 4000 — не
    /// більше двох щаблів на емітента.
    pub const fn max_issuer_bps(self) -> u16 {
        match self {
            Self::Conservative => 2_000,
            Self::Balanced => 4_000,
        }
    }

    pub const fn admits_rating(self, notch: u8) -> bool {
        scale::is_valid_notch(notch) && scale::meets_threshold(notch, self.worst_allowed_notch())
    }

    /// FR-005 відкидає частку, вищу за ліміт, — рівно на ліміті емітент
    /// проходить.
    pub const fn admits_issuer_share(self, share_bps: u16) -> bool {
        share_bps <= self.max_issuer_bps()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Той самий файл читає packages/shared/src/profiles.test.ts.
    const SHARED_FIXTURE: &str = include_str!("../../../fixtures/profiles.json");

    fn fixture() -> serde_json::Value {
        serde_json::from_str(SHARED_FIXTURE).expect("fixtures/profiles.json — валідний JSON")
    }

    fn profile_named(name: &str) -> RiskProfile {
        match name {
            "conservative" => RiskProfile::Conservative,
            "balanced" => RiskProfile::Balanced,
            other => panic!("у фікстурі невідомий профіль {other}"),
        }
    }

    fn number(value: &serde_json::Value) -> u64 {
        value.as_u64().expect("очікувалось число")
    }

    #[test]
    fn profiles_match_the_shared_fixture() {
        let fixture = fixture();
        let profiles = fixture["profiles"].as_array().expect("profiles — масив");
        assert_eq!(profiles.len(), 2);

        for entry in profiles {
            let profile = profile_named(entry["profile"].as_str().expect("profile — рядок"));

            assert_eq!(
                u64::from(profile.worst_allowed_notch()),
                number(&entry["worstAllowedNotch"]),
                "{profile:?}"
            );
            assert_eq!(
                u64::from(profile.max_issuer_bps()),
                number(&entry["maxIssuerBps"]),
                "{profile:?}"
            );
        }
    }

    /// Поріг оголошений міткою агентства, а число — лише її щабель. Зміна
    /// таблиці шкали має ламати цей тест, а не тихо посунути поріг.
    #[test]
    fn thresholds_stay_pinned_to_agency_labels() {
        let fixture = fixture();

        for entry in fixture["profiles"].as_array().expect("profiles — масив") {
            let label = entry["worstAllowedLabel"]
                .as_str()
                .expect("worstAllowedLabel — рядок");

            assert_eq!(
                scale::notch_for_label(label).map(u64::from),
                Some(number(&entry["worstAllowedNotch"])),
                "мітка {label}"
            );
        }
    }

    #[test]
    fn a_rating_exactly_on_the_threshold_is_admitted_and_the_next_one_is_not() {
        for profile in [RiskProfile::Conservative, RiskProfile::Balanced] {
            let worst = profile.worst_allowed_notch();

            assert!(profile.admits_rating(scale::NOTCH_BEST), "{profile:?}");
            assert!(profile.admits_rating(worst), "{profile:?}");
            assert!(!profile.admits_rating(worst + 1), "{profile:?}");
            assert!(!profile.admits_rating(scale::NOTCH_WORST), "{profile:?}");
        }
    }

    #[test]
    fn a_notch_outside_the_scale_is_not_a_rating() {
        for profile in [RiskProfile::Conservative, RiskProfile::Balanced] {
            assert!(!profile.admits_rating(0), "{profile:?}");
            assert!(
                !profile.admits_rating(scale::NOTCH_WORST + 1),
                "{profile:?}"
            );
            assert!(!profile.admits_rating(u8::MAX), "{profile:?}");
        }
    }

    #[test]
    fn labels_below_investment_grade_are_refused_under_every_profile() {
        let fixture = fixture();

        for entry in fixture["rejectedLabels"]
            .as_array()
            .expect("rejectedLabels — масив")
        {
            let label = entry.as_str().expect("мітка — рядок");
            let notch = scale::notch_for_label(label).expect("мітка належить шкалі");

            assert!(!RiskProfile::Conservative.admits_rating(notch), "{label}");
            assert!(!RiskProfile::Balanced.admits_rating(notch), "{label}");
        }
    }

    #[test]
    fn an_issuer_exactly_on_the_limit_passes_and_the_next_share_does_not() {
        for profile in [RiskProfile::Conservative, RiskProfile::Balanced] {
            let limit = profile.max_issuer_bps();

            assert!(profile.admits_issuer_share(0), "{profile:?}");
            assert!(profile.admits_issuer_share(limit), "{profile:?}");
            assert!(!profile.admits_issuer_share(limit + 1), "{profile:?}");
        }
    }

    #[test]
    fn the_maturity_grid_is_shared_by_both_profiles() {
        let fixture = fixture();
        let months = fixture["rungMonths"]
            .as_array()
            .expect("rungMonths — масив");

        assert_eq!(months.len(), RUNG_COUNT);

        for (index, month) in months.iter().enumerate() {
            assert_eq!(u64::from(RUNG_MONTHS[index]), number(month));
        }
    }

    #[test]
    fn the_maturity_grid_rises_without_repeats() {
        for pair in RUNG_MONTHS.windows(2) {
            assert!(pair[1] > pair[0], "сітка строків не зростає: {pair:?}");
        }
    }
}
