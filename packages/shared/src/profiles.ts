// Дзеркало programs/bond-ladder/src/profiles.rs. Обидві сторони тестуються
// проти fixtures/profiles.json — розбіжність дає червоний тест.

import { isValidNotch, meetsThreshold } from './scale'

export type RiskProfile = 'conservative' | 'balanced'

// Сітка строків до профілю не належить: профіль впливає на кредитну якість,
// а не на дюрацію (FR-006).
export const RUNG_MONTHS: readonly number[] = [3, 6, 9, 12, 18]

export const RUNG_COUNT = RUNG_MONTHS.length

const RULES: Record<RiskProfile, { worstAllowedNotch: number; maxIssuerBps: number }> = {
  conservative: { worstAllowedNotch: 7, maxIssuerBps: 2000 },
  balanced: { worstAllowedNotch: 10, maxIssuerBps: 4000 },
}

export function worstAllowedNotch(profile: RiskProfile): number {
  return RULES[profile].worstAllowedNotch
}

export function maxIssuerBps(profile: RiskProfile): number {
  return RULES[profile].maxIssuerBps
}

export function admitsRating(profile: RiskProfile, notch: number): boolean {
  return isValidNotch(notch) && meetsThreshold(notch, worstAllowedNotch(profile))
}

// FR-005 відкидає частку, вищу за ліміт, — рівно на ліміті емітент проходить.
export function admitsIssuerShare(profile: RiskProfile, shareBps: number): boolean {
  return shareBps <= maxIssuerBps(profile)
}
