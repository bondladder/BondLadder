import { describe, expect, it } from 'vitest'
import { MeasureError, report, summarise } from './measure-us1'

describe('summarise', () => {
  it('reports the spread of what it saw', () => {
    expect(summarise([310, 290, 370], 3_000)).toMatchObject({
      minMs: 290,
      medianMs: 310,
      maxMs: 370,
      count: 3,
    })
  })

  it('takes the median between the two middle samples on an even count', () => {
    expect(summarise([100, 200, 300, 400], 3_000).medianMs).toBe(250)
  })

  it('does not care what order the samples arrived in', () => {
    expect(summarise([370, 290, 310], 3_000)).toEqual(summarise([290, 310, 370], 3_000))
  })

  // Критерій обіцяє межу відвідувачу, а не в середньому по відвідувачах:
  // один прогін за бюджетом — це прогін, який хтось побачив.
  it('judges by the worst sample, not the median', () => {
    const spiky = summarise([120, 140, 4_100], 3_000)

    expect(spiky.medianMs).toBeLessThan(3_000)
    expect(spiky.withinBudget).toBe(false)
  })

  it('passes only when every sample fits', () => {
    expect(summarise([2_999, 1_000], 3_000).withinBudget).toBe(true)
  })

  // Рівно на межі критерій ще виконаний: «менше 3 секунд» міряється в
  // мілісекундах, і 3000 з них — це не більше за бюджет.
  it('lets a sample exactly on the budget through', () => {
    expect(summarise([3_000], 3_000).withinBudget).toBe(true)
  })

  it('refuses to summarise nothing', () => {
    expect(() => summarise([], 3_000)).toThrow(MeasureError)
  })
})

describe('report', () => {
  it('prints the verdict beside the figure', () => {
    const line = report('SC-001', 3_000, summarise([310, 290, 370], 3_000))

    expect(line).toContain('SC-001')
    expect(line).toContain('370')
    expect(line).toContain('< 3000')
    expect(line).toMatch(/✅|PASS|проходить/)
  })

  it('says so when the budget is missed', () => {
    const line = report('SC-008', 2_000, summarise([2_400], 2_000))

    expect(line).toMatch(/❌|FAIL|не проходить/)
  })
})
