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

/// Довжина мітки на дроті. Найдовші мітки шкали — "CCC+" і "BBB-".
pub const LABEL_LEN: usize = 4;

/// Мітка в інструкції приходить фіксованим масивом, вирівняним ліворуч і
/// добитим нулями: у Borsh це дешевше за String і не дає змінної довжини.
pub fn notch_for_encoded_label(encoded: &[u8; LABEL_LEN]) -> Option<u8> {
    let end = encoded
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(LABEL_LEN);

    // Байти після нуля мусять бути нулями — інакше це не наше кодування, а
    // сміття, яке не можна мовчки обрізати до валідної мітки.
    if encoded[end..].iter().any(|byte| *byte != 0) {
        return None;
    }

    notch_for_label(core::str::from_utf8(&encoded[..end]).ok()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Той самий файл читає packages/shared/src/scale.test.ts. include_str!
    /// навмисно: пропалий фікстур має ламати збірку тестів, а не мовчки
    /// пропускати перевірку.
    const SHARED_FIXTURE: &str = include_str!("../../../fixtures/scale.json");

    #[test]
    fn scale_matches_the_shared_fixture() {
        let fixture: serde_json::Value =
            serde_json::from_str(SHARED_FIXTURE).expect("fixtures/scale.json — валідний JSON");

        assert_eq!(
            fixture["scaleVersion"].as_u64(),
            Some(u64::from(SCALE_VERSION))
        );

        let notches = fixture["notches"].as_array().expect("notches — масив");
        assert_eq!(notches.len(), usize::from(NOTCH_WORST));

        for entry in notches {
            let notch = u8::try_from(entry["notch"].as_u64().expect("notch — число"))
                .expect("notch не виходить за u8");
            let label = entry["label"].as_str().expect("label — рядок");

            assert_eq!(notch_for_label(label), Some(notch), "мітка {label}");
            assert_eq!(label_for_notch(notch), Some(label), "щабель {notch}");
        }

        let rejected = fixture["rejectedLabels"]
            .as_array()
            .expect("rejectedLabels — масив");

        for entry in rejected {
            let label = entry.as_str().expect("мітка — рядок");
            assert_eq!(notch_for_label(label), None, "мітка {label:?}");
        }
    }

    fn encoded(label: &str) -> [u8; LABEL_LEN] {
        let mut buffer = [0u8; LABEL_LEN];
        buffer[..label.len()].copy_from_slice(label.as_bytes());
        buffer
    }

    #[test]
    fn every_fixture_label_survives_the_wire_encoding() {
        let fixture: serde_json::Value =
            serde_json::from_str(SHARED_FIXTURE).expect("fixtures/scale.json — валідний JSON");

        for entry in fixture["notches"].as_array().expect("notches — масив") {
            let label = entry["label"].as_str().expect("label — рядок");
            assert!(
                label.len() <= LABEL_LEN,
                "мітка {label} не влазить у LABEL_LEN"
            );
            assert_eq!(
                notch_for_encoded_label(&encoded(label)),
                notch_for_label(label),
                "мітка {label}"
            );
        }
    }

    #[test]
    fn encoded_labels_that_are_not_ours_are_rejected() {
        assert_eq!(notch_for_encoded_label(&[0, 0, 0, 0]), None);
        assert_eq!(notch_for_encoded_label(&encoded("AAAA")), None);
        assert_eq!(notch_for_encoded_label(&[b'A', 0, b'A', 0]), None);
        assert_eq!(notch_for_encoded_label(&[0xFF, 0, 0, 0]), None);
        assert_eq!(notch_for_encoded_label(b" AAA"), None);
    }

    #[test]
    fn scale_anchors_are_fixed() {
        assert_eq!(notch_for_label("AAA"), Some(NOTCH_BEST));
        assert_eq!(notch_for_label("BBB-"), Some(10));
        assert_eq!(notch_for_label("D"), Some(NOTCH_WORST));
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
