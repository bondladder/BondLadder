import { describe, expect, it } from 'vitest'
import fixture from '../../../fixtures/scale.json'
import {
  NOTCH_BEST,
  NOTCH_WORST,
  SCALE_VERSION,
  isValidNotch,
  labelForNotch,
  meetsThreshold,
  notchForLabel,
} from './scale'

describe('шкала рейтингів', () => {
  it('збігається зі спільним фікстуром', () => {
    expect(SCALE_VERSION).toBe(fixture.scaleVersion)
    expect(fixture.notches).toHaveLength(NOTCH_WORST)

    for (const { notch, label } of fixture.notches) {
      expect(notchForLabel(label)).toBe(notch)
      expect(labelForNotch(notch)).toBe(label)
    }
  })

  it('відкидає мітки, яких немає у фікстурі', () => {
    for (const label of fixture.rejectedLabels) {
      expect(notchForLabel(label)).toBeNull()
    }
  })

  it('має нерухомі якорі шкали', () => {
    expect(notchForLabel('AAA')).toBe(NOTCH_BEST)
    expect(notchForLabel('BBB-')).toBe(10)
    expect(notchForLabel('D')).toBe(NOTCH_WORST)
  })

  it('не дає мітки щаблям поза шкалою', () => {
    expect(labelForNotch(0)).toBeNull()
    expect(labelForNotch(NOTCH_WORST + 1)).toBeNull()
    expect(labelForNotch(-1)).toBeNull()

    expect(isValidNotch(NOTCH_BEST)).toBe(true)
    expect(isValidNotch(NOTCH_WORST)).toBe(true)
    expect(isValidNotch(0)).toBe(false)
    expect(isValidNotch(NOTCH_WORST + 1)).toBe(false)
  })

  it('не вважає щаблем те, що не є цілим числом', () => {
    for (const notch of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isValidNotch(notch)).toBe(false)
    }
  })

  it('порівнює з порогом за перевернутим порядком', () => {
    const aMinus = 7
    const bbbPlus = 8

    expect(notchForLabel('A-')).toBe(aMinus)
    expect(notchForLabel('BBB+')).toBe(bbbPlus)

    expect(meetsThreshold(NOTCH_BEST, aMinus)).toBe(true)
    expect(meetsThreshold(aMinus, aMinus)).toBe(true)
    expect(meetsThreshold(bbbPlus, aMinus)).toBe(false)
    expect(meetsThreshold(NOTCH_WORST, aMinus)).toBe(false)
  })
})
