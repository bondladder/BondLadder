//! Нормалізована порядкова шкала кредитних рейтингів (FR-003).

/// Версія таблиці нижче. Рейтинг, опублікований під іншою версією, не можна
/// порівнювати з порогом профілю: та сама цифра означала б інший щабель.
pub const SCALE_VERSION: u8 = 1;

pub const NOTCH_BEST: u8 = 1;
pub const NOTCH_WORST: u8 = 22;

const LABELS: [&str; NOTCH_WORST as usize] = [
    "AAA", "AA+", "AA", "AA-", "A+", "A", "A-", "BBB+", "BBB", "BBB-", "BB+", "BB", "BB-", "B+",
    "B", "B-", "CCC+", "CCC", "CCC-", "CC", "C", "D",
];

pub fn notch_for_label(label: &str) -> Option<u8> {
    LABELS
        .iter()
        .position(|known| *known == label)
        .map(|index| index as u8 + 1)
}

pub fn label_for_notch(notch: u8) -> Option<&'static str> {
    LABELS.get(usize::from(notch.checked_sub(1)?)).copied()
}

pub const fn is_valid_notch(notch: u8) -> bool {
    matches!(notch, NOTCH_BEST..=NOTCH_WORST)
}

/// Шкала перевернута — менше значення означає вищу якість, тому поріг
/// проходять щаблі, не більші за нього.
pub const fn meets_threshold(notch: u8, worst_allowed: u8) -> bool {
    notch <= worst_allowed
}

#[cfg(test)]
mod tests {
    use super::*;

    const PUBLISHED_ORDER: [&str; 22] = [
        "AAA", "AA+", "AA", "AA-", "A+", "A", "A-", "BBB+", "BBB", "BBB-", "BB+", "BB", "BB-",
        "B+", "B", "B-", "CCC+", "CCC", "CCC-", "CC", "C", "D",
    ];

    #[test]
    fn scale_matches_the_published_order() {
        for (index, label) in PUBLISHED_ORDER.iter().enumerate() {
            let notch = index as u8 + 1;
            assert_eq!(notch_for_label(label), Some(notch), "мітка {label}");
            assert_eq!(label_for_notch(notch), Some(*label), "щабель {notch}");
        }
    }

    #[test]
    fn scale_anchors_are_fixed() {
        assert_eq!(notch_for_label("AAA"), Some(NOTCH_BEST));
        assert_eq!(notch_for_label("BBB-"), Some(10));
        assert_eq!(notch_for_label("D"), Some(NOTCH_WORST));
        assert_eq!(NOTCH_WORST, PUBLISHED_ORDER.len() as u8);
    }

    #[test]
    fn labels_are_unique() {
        for left in NOTCH_BEST..NOTCH_WORST {
            for right in (left + 1)..=NOTCH_WORST {
                assert_ne!(label_for_notch(left), label_for_notch(right));
            }
        }
    }

    #[test]
    fn notches_outside_the_scale_have_no_label() {
        assert_eq!(label_for_notch(0), None);
        assert_eq!(label_for_notch(NOTCH_WORST + 1), None);
        assert_eq!(label_for_notch(u8::MAX), None);

        assert!(is_valid_notch(NOTCH_BEST));
        assert!(is_valid_notch(NOTCH_WORST));
        assert!(!is_valid_notch(0));
        assert!(!is_valid_notch(NOTCH_WORST + 1));
    }

    #[test]
    fn unknown_labels_are_rejected_rather_than_guessed() {
        for label in [
            "", "aaa", " AAA", "AAA ", "AAAA", "A++", "AA--", "DD", "1", "Aaa", "Baa1",
        ] {
            assert_eq!(notch_for_label(label), None, "мітка {label:?}");
        }
    }

    #[test]
    fn threshold_comparison_follows_the_inverted_order() {
        let a_minus = 7;
        let bbb_plus = 8;

        assert_eq!(notch_for_label("A-"), Some(a_minus));
        assert_eq!(notch_for_label("BBB+"), Some(bbb_plus));

        assert!(meets_threshold(NOTCH_BEST, a_minus));
        assert!(meets_threshold(a_minus, a_minus));
        assert!(!meets_threshold(bbb_plus, a_minus));
        assert!(!meets_threshold(NOTCH_WORST, a_minus));
    }
}
