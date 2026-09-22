import { describe, expect, it } from 'vitest'
import fixture from '../../../fixtures/math.json'
import { accrueFee, BPS_DENOMINATOR, MathOverflowError, SECONDS_PER_YEAR } from './math'

const THOUSAND_USDC = 1_000_000_000n
const FEE_BPS = 50

describe('комісія за управління', () => {
  it('має ті самі константи, що й фікстур', () => {
    expect(SECONDS_PER_YEAR).toBe(BigInt(fixture.secondsPerYear))
    expect(BPS_DENOMINATOR).toBe(BigInt(fixture.bpsDenominator))
  })

  it('нараховує рівно те, що записано у спільному фікстурі', () => {
    for (const entry of fixture.accrual) {
      expect(
        accrueFee(BigInt(entry.valueMicro), entry.feeBps, BigInt(entry.elapsedSeconds)),
        entry.case,
      ).toBe(BigInt(entry.expectedMicro))
    }
  })

  it('відмовляє там, де відмовляє програма', () => {
    for (const entry of fixture.refused) {
      expect(
        () => accrueFee(BigInt(entry.valueMicro), entry.feeBps, BigInt(entry.elapsedSeconds)),
        entry.case,
      ).toThrow(MathOverflowError)
    }
  })

  // Дзеркало property-тесту з math.rs: залишок ділення завжди лишається
  // користувачу, але цілого мікро-USDC vault не втрачає.
  it('ніколи не забігає поперед точної суми і не втрачає цілої одиниці', () => {
    for (const seconds of [1n, 7n, 3_601n, 86_401n, 3_888_013n, SECONDS_PER_YEAR - 1n]) {
      const charged = accrueFee(THOUSAND_USDC, FEE_BPS, seconds)
      const exact = THOUSAND_USDC * BigInt(FEE_BPS) * seconds
      const denominator = BPS_DENOMINATOR * SECONDS_PER_YEAR

      expect(charged * denominator, `${seconds} с`).toBeLessThanOrEqual(exact)
      expect((charged + 1n) * denominator, `${seconds} с`).toBeGreaterThan(exact)
    }
  })

  it('росте з часом утримання і ніколи не спадає', () => {
    let previous = accrueFee(THOUSAND_USDC, FEE_BPS, 0n)

    for (const seconds of [1n, 86_400n, 3_888_000n, 8_035_200n, SECONDS_PER_YEAR]) {
      const current = accrueFee(THOUSAND_USDC, FEE_BPS, seconds)
      expect(current, `${seconds} с`).toBeGreaterThanOrEqual(previous)
      previous = current
    }
  })

  // bigint приймає те, чого u64 не приймає, тож межу тримає дзеркало.
  it('відкидає вхід, який не вміщається в ширину програми', () => {
    expect(() => accrueFee(-1n, FEE_BPS, 1n)).toThrow(MathOverflowError)
    expect(() => accrueFee(2n ** 64n, FEE_BPS, 1n)).toThrow(MathOverflowError)
    expect(() => accrueFee(THOUSAND_USDC, -1, 1n)).toThrow(MathOverflowError)
    expect(() => accrueFee(THOUSAND_USDC, 65_536, 1n)).toThrow(MathOverflowError)
    expect(() => accrueFee(THOUSAND_USDC, FEE_BPS, -1n)).toThrow(MathOverflowError)
  })
})
