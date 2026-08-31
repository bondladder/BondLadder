import { RUNG_MONTHS, admitsRating, notchForLabel } from '@bondladder/shared'
import { describe, expect, it } from 'vitest'
import { type CatalogEntry, buildCatalog } from './seed-catalog'

const REFERENCE_TS = 1_772_000_000n

const catalog = buildCatalog(REFERENCE_TS)

function issuersAdmittedAt(rungMonths: number, profile: 'conservative' | 'balanced'): Set<string> {
  const admitted = new Set<string>()

  for (const entry of catalog) {
    const notch = notchForLabel(entry.ratingLabel)
    if (entry.rungMonths === rungMonths && notch !== null && admitsRating(profile, notch)) {
      admitted.add(entry.issuerId)
    }
  }

  return admitted
}

function isPrintableAscii(text: string): boolean {
  return [...text].every((character) => {
    const code = character.charCodeAt(0)
    return code >= 0x21 && code <= 0x7e
  })
}

describe('каталог інструментів', () => {
  it('віддає інструменти, які приймає register_instrument', () => {
    expect(catalog.length).toBeGreaterThan(0)

    for (const entry of catalog) {
      expect(entry.priceMicro).toBeGreaterThan(0n)
      expect(entry.maturityTs).toBeGreaterThan(REFERENCE_TS)
      expect(entry.couponBps).toBeGreaterThan(0)
      expect(entry.couponBps).toBeLessThanOrEqual(65_535)
    }
  })

  // Мітки на дроті звужені декодером з T015: [u8; 16] і [u8; 8] друкованого
  // ASCII. Каталог, який не декодується назад, не каталог.
  it('тримає мітки в межах полів на дроті', () => {
    for (const entry of catalog) {
      expect(entry.issuerId.length).toBeLessThanOrEqual(16)
      expect(entry.agencyCode.length).toBeLessThanOrEqual(8)
      expect(isPrintableAscii(entry.issuerId)).toBe(true)
      expect(isPrintableAscii(entry.agencyCode)).toBe(true)
    }
  })

  it('несе лише рейтинги, які знає шкала', () => {
    for (const entry of catalog) {
      expect(notchForLabel(entry.ratingLabel)).not.toBeNull()
    }
  })

  it('дає кожному емітенту рівно один інструмент на щабель', () => {
    const perIssuer = new Map<string, number[]>()

    for (const entry of catalog) {
      const rungs = perIssuer.get(entry.issuerId) ?? []
      rungs.push(entry.rungMonths)
      perIssuer.set(entry.issuerId, rungs)
    }

    expect(perIssuer.size).toBeGreaterThan(0)

    for (const [issuerId, rungs] of perIssuer) {
      expect([...rungs].sort((left, right) => left - right)).toEqual([...RUNG_MONTHS])
      expect(new Set(rungs).size, issuerId).toBe(RUNG_MONTHS.length)
    }
  })

  // FR-006 не допускає часткової лествиці, а консервативний ліміт 2000 bps
  // дорівнює одному щаблю — тобто п'ять щаблів вимагають п'ятьох різних
  // емітентів, придатних за рейтингом на кожному щаблі.
  it('дає консервативному профілю п’ятьох різних емітентів на кожному щаблі', () => {
    for (const rungMonths of RUNG_MONTHS) {
      expect(issuersAdmittedAt(rungMonths, 'conservative').size).toBeGreaterThanOrEqual(5)
    }
  })

  it('відкриває збалансованому профілю більше емітентів, ніж консервативному', () => {
    for (const rungMonths of RUNG_MONTHS) {
      const conservative = issuersAdmittedAt(rungMonths, 'conservative')
      const balanced = issuersAdmittedAt(rungMonths, 'balanced')

      expect(balanced.size).toBeGreaterThan(conservative.size)
      for (const issuerId of conservative) {
        expect(balanced.has(issuerId)).toBe(true)
      }
    }
  })

  it('містить інструменти, які відкидають обидва профілі', () => {
    const rejected = catalog.filter((entry: CatalogEntry) => {
      const notch = notchForLabel(entry.ratingLabel)
      return notch !== null && !admitsRating('balanced', notch)
    })

    expect(rejected.length).toBeGreaterThan(0)
  })

  // Без цього «найближче погашення» з FR-006 не має однозначної відповіді,
  // і підбір на T019 залежав би від порядку в масиві.
  it('не дає двом інструментам однакового строку на щаблі', () => {
    for (const rungMonths of RUNG_MONTHS) {
      const maturities = catalog
        .filter((entry: CatalogEntry) => entry.rungMonths === rungMonths)
        .map((entry: CatalogEntry) => entry.maturityTs)

      expect(new Set(maturities).size).toBe(maturities.length)
    }
  })

  it('ставить строк тим далі, чим довший щабель', () => {
    for (const entry of catalog) {
      const longer = catalog.find(
        (other: CatalogEntry) =>
          other.issuerId === entry.issuerId && other.rungMonths > entry.rungMonths,
      )

      if (longer !== undefined) {
        expect(longer.maturityTs).toBeGreaterThan(entry.maturityTs)
      }
    }
  })

  it('дисконтує ціну до номіналу тим глибше, чим далі погашення', () => {
    for (const entry of catalog) {
      expect(entry.priceMicro).toBeLessThan(1_000_000n)

      const longer = catalog.find(
        (other: CatalogEntry) =>
          other.issuerId === entry.issuerId && other.rungMonths > entry.rungMonths,
      )

      if (longer !== undefined) {
        expect(longer.priceMicro).toBeLessThan(entry.priceMicro)
      }
    }
  })

  it('повертає той самий каталог на той самий опорний час', () => {
    expect(buildCatalog(REFERENCE_TS)).toEqual(catalog)
  })

  it('зсуває строки разом з опорним часом', () => {
    const later = buildCatalog(REFERENCE_TS + 86_400n)

    expect(later.length).toBe(catalog.length)
    for (let index = 0; index < later.length; index += 1) {
      expect(later[index]?.maturityTs).toBe((catalog[index]?.maturityTs ?? 0n) + 86_400n)
    }
  })
})
