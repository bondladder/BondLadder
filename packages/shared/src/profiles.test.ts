import { describe, expect, it } from 'vitest'
import fixture from '../../../fixtures/profiles.json'
import {
  RUNG_COUNT,
  RUNG_MONTHS,
  type RiskProfile,
  admitsIssuerShare,
  admitsRating,
  maxIssuerBps,
  worstAllowedNotch,
} from './profiles'
import { NOTCH_BEST, NOTCH_WORST, notchForLabel } from './scale'

describe('профілі ризику', () => {
  it('збігаються зі спільним фікстуром', () => {
    for (const profile of fixture.profiles) {
      const name = profile.profile as RiskProfile

      expect(worstAllowedNotch(name)).toBe(profile.worstAllowedNotch)
      expect(maxIssuerBps(name)).toBe(profile.maxIssuerBps)
    }
  })

  it('тримає пороги прив’язаними до міток агентства, а не до чисел', () => {
    for (const profile of fixture.profiles) {
      expect(notchForLabel(profile.worstAllowedLabel)).toBe(profile.worstAllowedNotch)
    }
  })

  it('приймає рейтинг рівно на порозі і відкидає наступний за ним', () => {
    for (const { profile, worstAllowedNotch: worst } of fixture.profiles) {
      const name = profile as RiskProfile

      expect(admitsRating(name, NOTCH_BEST)).toBe(true)
      expect(admitsRating(name, worst)).toBe(true)
      expect(admitsRating(name, worst + 1)).toBe(false)
      expect(admitsRating(name, NOTCH_WORST)).toBe(false)
    }
  })

  it('не приймає за рейтинг те, чого немає на шкалі', () => {
    for (const notch of [0, NOTCH_WORST + 1, -1, 1.5, Number.NaN]) {
      expect(admitsRating('balanced', notch)).toBe(false)
    }
  })

  it('відкидає мітки нижче investment grade за будь-якого профілю', () => {
    for (const label of fixture.rejectedLabels) {
      const notch = notchForLabel(label)
      expect(notch).not.toBeNull()

      expect(admitsRating('conservative', notch as number)).toBe(false)
      expect(admitsRating('balanced', notch as number)).toBe(false)
    }
  })

  it('пускає емітента рівно на ліміті і відсікає наступну частку', () => {
    for (const { profile, maxIssuerBps: limit } of fixture.profiles) {
      const name = profile as RiskProfile

      expect(admitsIssuerShare(name, limit)).toBe(true)
      expect(admitsIssuerShare(name, limit + 1)).toBe(false)
      expect(admitsIssuerShare(name, 0)).toBe(true)
    }
  })

  it('тримає сітку строків спільною для обох профілів', () => {
    expect([...RUNG_MONTHS]).toEqual(fixture.rungMonths)
    expect(RUNG_COUNT).toBe(fixture.rungMonths.length)
  })

  it('має сітку строків, що зростає без повторів', () => {
    for (let index = 1; index < RUNG_MONTHS.length; index += 1) {
      expect(RUNG_MONTHS[index]).toBeGreaterThan(RUNG_MONTHS[index - 1] as number)
    }
  })
})
