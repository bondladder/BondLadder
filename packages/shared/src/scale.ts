// Дзеркало programs/rating-oracle/src/scale.rs. Дублювання свідоме: розкладку
// треба показати до підпису (FR-007), а симуляція транзакції на кожен рух
// повзунка не вкладається в SC-001. Обидві сторони тестуються проти
// fixtures/scale.json, тому розбіжність дає червоний тест, а не сюрприз.

export const SCALE_VERSION = 1

export const NOTCH_BEST = 1
export const NOTCH_WORST = 22

const LABELS: readonly string[] = [
  'AAA',
  'AA+',
  'AA',
  'AA-',
  'A+',
  'A',
  'A-',
  'BBB+',
  'BBB',
  'BBB-',
  'BB+',
  'BB',
  'BB-',
  'B+',
  'B',
  'B-',
  'CCC+',
  'CCC',
  'CCC-',
  'CC',
  'C',
  'D',
]

export function notchForLabel(label: string): number | null {
  const index = LABELS.indexOf(label)
  return index === -1 ? null : index + 1
}

export function labelForNotch(notch: number): string | null {
  return LABELS[notch - 1] ?? null
}

export function isValidNotch(notch: number): boolean {
  return Number.isInteger(notch) && notch >= NOTCH_BEST && notch <= NOTCH_WORST
}

// Шкала перевернута — менше значення означає вищу якість, тому поріг
// проходять щаблі, не більші за нього.
export function meetsThreshold(notch: number, worstAllowed: number): boolean {
  return notch <= worstAllowed
}
