import { describe, expect, it } from 'vitest'
import fixture from '../../../fixtures/math.json'
import {
  accrueFee,
  BPS_DENOMINATOR,
  DAYS_PER_FOUR_YEARS,
  ExitRefusedError,
  exitQuote,
  exitSpread,
  MathOverflowError,
  type RungValue,
  SECONDS_PER_DAY,
  SECONDS_PER_YEAR,
  settleExit,
  weightedRemainingDays,
} from './math'

const THOUSAND_USDC = 1_000_000_000n
const FEE_BPS = 50
const SPREAD_COEF_BPS = 200
const LONGEST_RUNG_DAYS = 548n
const NOW_TS = 1_700_000_000n
const U64_MAX = 2n ** 64n - 1n
const I64_MAX = 2n ** 63n - 1n
const I64_MIN = -(2n ** 63n)

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

interface FixtureRung {
  readonly units: string
  readonly priceMicro: string
  readonly maturityTs: string
}

function rungsOf(listed: readonly FixtureRung[]): RungValue[] {
  return listed.map((held) => ({
    units: BigInt(held.units),
    priceMicro: BigInt(held.priceMicro),
    maturityTs: BigInt(held.maturityTs),
  }))
}

function oneRungDueIn(seconds: bigint): RungValue[] {
  return [
    { units: 1n, priceMicro: 1_000_000n, maturityTs: NOW_TS + seconds },
    ...Array.from({ length: 4 }, () => ({ units: 0n, priceMicro: 1_000_000n, maturityTs: NOW_TS })),
  ]
}

const GRID_POSITION = rungsOf(fixture.weightedRemainingDays[0]?.rungs ?? [])

describe('weighted remaining duration', () => {
  it('has the same constants as the shared fixture', () => {
    expect(SECONDS_PER_DAY).toBe(BigInt(fixture.secondsPerDay))
    expect(DAYS_PER_FOUR_YEARS).toBe(BigInt(fixture.daysPerFourYears))
  })

  // The spread's year and the fee's year are one julian year in two units.
  it('divides the spread by the same year the fee charges', () => {
    expect(DAYS_PER_FOUR_YEARS * SECONDS_PER_DAY).toBe(4n * SECONDS_PER_YEAR)
  })

  it('weighs exactly what the shared fixture records', () => {
    expect(fixture.weightedRemainingDays).toHaveLength(6)

    for (const entry of fixture.weightedRemainingDays) {
      expect(weightedRemainingDays(rungsOf(entry.rungs), BigInt(entry.nowTs)), entry.case).toBe(
        BigInt(entry.expectedDays),
      )
    }
  })

  // Floored per rung before weighting, as the program does; weighting the
  // seconds instead is the dashboard's figure, not the quote's.
  it('stops counting a rung once it has matured and floors each rung to whole days', () => {
    expect(weightedRemainingDays(oneRungDueIn(0n), NOW_TS)).toBe(0n)
    expect(weightedRemainingDays(oneRungDueIn(-1n), NOW_TS)).toBe(0n)
    expect(weightedRemainingDays(oneRungDueIn(86_399n), NOW_TS)).toBe(0n)
    expect(weightedRemainingDays(oneRungDueIn(86_400n), NOW_TS)).toBe(1n)
    expect(weightedRemainingDays(oneRungDueIn(172_801n), NOW_TS)).toBe(2n)
  })

  // i64 subtraction saturates in the program; bigint would not.
  it('saturates the remaining time where the program does', () => {
    const farthest = oneRungDueIn(0n).map((rung, index) =>
      index === 0 ? { ...rung, maturityTs: I64_MAX } : rung,
    )
    const earliest = oneRungDueIn(0n).map((rung, index) =>
      index === 0 ? { ...rung, maturityTs: I64_MIN } : rung,
    )

    expect(weightedRemainingDays(farthest, I64_MIN)).toBe(I64_MAX / SECONDS_PER_DAY)
    expect(weightedRemainingDays(earliest, NOW_TS)).toBe(0n)
  })

  it('refuses a weighted sum that does not fit u128', () => {
    const heaviest = GRID_POSITION.map((rung) => ({ ...rung, units: U64_MAX, priceMicro: U64_MAX }))

    expect(() => weightedRemainingDays(heaviest, NOW_TS)).toThrow(MathOverflowError)
  })

  it('rejects input that does not fit the width of the program', () => {
    const withFirst = (patch: Partial<RungValue>): RungValue[] =>
      GRID_POSITION.map((rung, index) => (index === 0 ? { ...rung, ...patch } : rung))

    expect(() => weightedRemainingDays(withFirst({ units: -1n }), NOW_TS)).toThrow(
      MathOverflowError,
    )
    expect(() => weightedRemainingDays(withFirst({ units: 2n ** 64n }), NOW_TS)).toThrow(
      MathOverflowError,
    )
    expect(() => weightedRemainingDays(withFirst({ priceMicro: 2n ** 64n }), NOW_TS)).toThrow(
      MathOverflowError,
    )
    expect(() => weightedRemainingDays(withFirst({ maturityTs: I64_MAX + 1n }), NOW_TS)).toThrow(
      MathOverflowError,
    )
    expect(() => weightedRemainingDays(GRID_POSITION, I64_MIN - 1n)).toThrow(MathOverflowError)
  })
})

describe('exit spread', () => {
  it('withholds exactly what the shared fixture records', () => {
    expect(fixture.spread).toHaveLength(12)

    for (const entry of fixture.spread) {
      expect(
        exitSpread(
          BigInt(entry.grossValueMicro),
          BigInt(entry.feeDueMicro),
          entry.spreadCoefBps,
          BigInt(entry.wrdDays),
        ),
        entry.case,
      ).toBe(BigInt(entry.expectedMicro))
    }
  })

  it('refuses where the program refuses', () => {
    expect(fixture.spreadRefused).toHaveLength(2)

    for (const entry of fixture.spreadRefused) {
      expect(
        () =>
          exitSpread(
            BigInt(entry.grossValueMicro),
            BigInt(entry.feeDueMicro),
            entry.spreadCoefBps,
            BigInt(entry.wrdDays),
          ),
        entry.case,
      ).toThrow(MathOverflowError)
    }
  })

  it('is taken off what the accrued fee leaves behind', () => {
    const feeDue = 5_000_000n

    const onTheNet = exitSpread(THOUSAND_USDC, feeDue, SPREAD_COEF_BPS, DAYS_PER_FOUR_YEARS)
    const onTheGross = exitSpread(THOUSAND_USDC, 0n, SPREAD_COEF_BPS, DAYS_PER_FOUR_YEARS)

    expect(onTheNet).toBe(
      exitSpread(THOUSAND_USDC - feeDue, 0n, SPREAD_COEF_BPS, DAYS_PER_FOUR_YEARS),
    )
    expect(onTheNet).toBeLessThan(onTheGross)
  })

  it('never runs ahead of the exact figure and never loses a whole micro-USDC', () => {
    for (const wrdDays of [1n, 29n, 91n, 365n, LONGEST_RUNG_DAYS, DAYS_PER_FOUR_YEARS]) {
      const withheld = exitSpread(THOUSAND_USDC, 0n, SPREAD_COEF_BPS, wrdDays)
      const exact = THOUSAND_USDC * BigInt(SPREAD_COEF_BPS) * wrdDays * 4n
      const denominator = BPS_DENOMINATOR * DAYS_PER_FOUR_YEARS

      expect(withheld * denominator, `${wrdDays} d`).toBeLessThanOrEqual(exact)
      expect((withheld + 1n) * denominator, `${wrdDays} d`).toBeGreaterThan(exact)
    }
  })

  it('grows with the remaining duration', () => {
    let previous = exitSpread(THOUSAND_USDC, 0n, SPREAD_COEF_BPS, 0n)
    expect(previous).toBe(0n)

    for (const wrdDays of [1n, 91n, 182n, 365n, LONGEST_RUNG_DAYS, DAYS_PER_FOUR_YEARS]) {
      const current = exitSpread(THOUSAND_USDC, 0n, SPREAD_COEF_BPS, wrdDays)
      expect(current, `${wrdDays} d`).toBeGreaterThan(previous)
      previous = current
    }
  })

  it('rejects input that does not fit the width of the program', () => {
    expect(() => exitSpread(-1n, 0n, SPREAD_COEF_BPS, 1n)).toThrow(MathOverflowError)
    expect(() => exitSpread(2n ** 64n, 0n, SPREAD_COEF_BPS, 1n)).toThrow(MathOverflowError)
    expect(() => exitSpread(THOUSAND_USDC, -1n, SPREAD_COEF_BPS, 1n)).toThrow(MathOverflowError)
    expect(() => exitSpread(THOUSAND_USDC, 2n ** 64n, SPREAD_COEF_BPS, 1n)).toThrow(
      MathOverflowError,
    )
    expect(() => exitSpread(THOUSAND_USDC, 0n, -1, 1n)).toThrow(MathOverflowError)
    expect(() => exitSpread(THOUSAND_USDC, 0n, 65_536, 1n)).toThrow(MathOverflowError)
    expect(() => exitSpread(THOUSAND_USDC, 0n, 0.5, 1n)).toThrow(MathOverflowError)
    expect(() => exitSpread(THOUSAND_USDC, 0n, SPREAD_COEF_BPS, -1n)).toThrow(MathOverflowError)
    expect(() => exitSpread(THOUSAND_USDC, 0n, SPREAD_COEF_BPS, 2n ** 64n)).toThrow(
      MathOverflowError,
    )
  })
})

describe('exit quote breakdown', () => {
  // Expected figures come from a Fraction over 365.25 days, not from the
  // integer path under test.
  it('walks from the current value through the duration and the spread to the payout', () => {
    const quote = exitQuote({
      rungs: GRID_POSITION,
      nowTs: NOW_TS,
      feeDueMicro: 12_345_678n,
      spreadCoefBps: SPREAD_COEF_BPS,
    })

    expect(quote).toEqual({
      grossValueMicro: 5_000_000_000n,
      netValueMicro: 4_987_654_322n,
      wrdDays: 290n,
      spreadMicro: 79_201_629n,
      payoutMicro: 4_908_452_693n,
    })
  })

  it('accounts for every micro-USDC of the position', () => {
    for (const feeDueMicro of [0n, 1n, 5_000_000n, 4_999_999_999n]) {
      const quote = exitQuote({
        rungs: GRID_POSITION,
        nowTs: NOW_TS,
        feeDueMicro,
        spreadCoefBps: SPREAD_COEF_BPS,
      })

      expect(quote.payoutMicro + quote.spreadMicro + feeDueMicro, `${feeDueMicro}`).toBe(
        quote.grossValueMicro,
      )
    }
  })

  it('prints the same duration and spread the program withholds', () => {
    for (const entry of fixture.weightedRemainingDays) {
      const quote = exitQuote({
        rungs: rungsOf(entry.rungs),
        nowTs: BigInt(entry.nowTs),
        feeDueMicro: 0n,
        spreadCoefBps: SPREAD_COEF_BPS,
      })

      expect(quote.wrdDays, entry.case).toBe(BigInt(entry.expectedDays))
      expect(quote.spreadMicro, entry.case).toBe(
        exitSpread(quote.grossValueMicro, 0n, SPREAD_COEF_BPS, quote.wrdDays),
      )
    }
  })

  it('pays nothing and withholds nothing once the fee has eaten the position', () => {
    const quote = exitQuote({
      rungs: GRID_POSITION,
      nowTs: NOW_TS,
      feeDueMicro: 6_000_000_000n,
      spreadCoefBps: SPREAD_COEF_BPS,
    })

    expect(quote.grossValueMicro).toBe(5_000_000_000n)
    expect(quote.netValueMicro).toBe(0n)
    expect(quote.spreadMicro).toBe(0n)
    expect(quote.payoutMicro).toBe(0n)
  })

  // Reachable only far outside the configured coefficient: a negative payout
  // is a quote no transaction could settle.
  it('refuses a spread larger than what the position is worth', () => {
    const fourYearsOut = GRID_POSITION.map((rung) => ({
      ...rung,
      maturityTs: NOW_TS + DAYS_PER_FOUR_YEARS * SECONDS_PER_DAY,
    }))

    expect(() =>
      exitQuote({ rungs: fourYearsOut, nowTs: NOW_TS, feeDueMicro: 0n, spreadCoefBps: 10_000 }),
    ).toThrow(MathOverflowError)
  })

  it('refuses a position value that does not fit u64', () => {
    const tooRich = GRID_POSITION.map((rung) => ({ ...rung, units: 2n ** 62n }))

    expect(() =>
      exitQuote({ rungs: tooRich, nowTs: NOW_TS, feeDueMicro: 0n, spreadCoefBps: SPREAD_COEF_BPS }),
    ).toThrow(MathOverflowError)
  })
})

function settleInputOf(
  entry: (typeof fixture.settle)[number] | (typeof fixture.settleRefused)[number],
) {
  return {
    rungs: rungsOf(entry.rungs),
    principalMicro: BigInt(entry.principalMicro),
    feeDueMicro: BigInt(entry.feeDueMicro),
    shareBps: entry.shareBps,
    spreadCoefBps: entry.spreadCoefBps,
    nowTs: BigInt(entry.nowTs),
  }
}

describe('exit settlement', () => {
  it('settles every case of the shared fixture as the program does', () => {
    expect(fixture.settle).toHaveLength(8)

    for (const entry of fixture.settle) {
      const { expected } = entry

      expect(settleExit(settleInputOf(entry)), entry.case).toEqual({
        units: expected.units.map(BigInt),
        grossValueMicro: BigInt(expected.grossValueMicro),
        wrdDays: BigInt(expected.wrdDays),
        feeChargedMicro: BigInt(expected.feeChargedMicro),
        feeCarriedMicro: BigInt(expected.feeCarriedMicro),
        spreadMicro: BigInt(expected.spreadMicro),
        payoutMicro: BigInt(expected.payoutMicro),
        principalMicro: BigInt(expected.principalMicro),
      })
    }
  })

  it('refuses every case the program refuses, under the same name', () => {
    expect(fixture.settleRefused).toHaveLength(4)

    for (const entry of fixture.settleRefused) {
      let refusal: unknown = null
      try {
        settleExit(settleInputOf(entry))
      } catch (error) {
        refusal = error
      }

      expect(refusal, entry.case).toBeInstanceOf(ExitRefusedError)
      expect((refusal as ExitRefusedError).reason, entry.case).toBe(entry.refusal)
    }
  })

  it('prices a full exit exactly as the quote of the whole position', () => {
    for (const feeDueMicro of [0n, 12_345_678n, 6_000_000_000n]) {
      const settled = settleExit({
        rungs: GRID_POSITION,
        principalMicro: 5_000_000_000n,
        feeDueMicro,
        shareBps: 10_000,
        spreadCoefBps: SPREAD_COEF_BPS,
        nowTs: NOW_TS,
      })
      const quote = exitQuote({
        rungs: GRID_POSITION,
        nowTs: NOW_TS,
        feeDueMicro,
        spreadCoefBps: SPREAD_COEF_BPS,
      })

      expect(settled.payoutMicro, `${feeDueMicro}`).toBe(quote.payoutMicro)
      expect(settled.spreadMicro, `${feeDueMicro}`).toBe(quote.spreadMicro)
      expect(settled.wrdDays, `${feeDueMicro}`).toBe(quote.wrdDays)
    }
  })

  it('accounts for every micro-USDC of the slice and of the fee', () => {
    for (const shareBps of [2_500, 5_000, 9_999, 10_000]) {
      for (const feeDueMicro of [0n, 7n, 300_000_000n, 9_000_000_000n]) {
        const settled = settleExit({
          rungs: GRID_POSITION,
          principalMicro: 5_000_000_000n,
          feeDueMicro,
          shareBps,
          spreadCoefBps: SPREAD_COEF_BPS,
          nowTs: NOW_TS,
        })
        const label = `${shareBps} bps, fee ${feeDueMicro}`

        expect(settled.payoutMicro + settled.spreadMicro + settled.feeChargedMicro, label).toBe(
          settled.grossValueMicro,
        )
        expect(settled.feeChargedMicro + settled.feeCarriedMicro, label).toBe(feeDueMicro)
      }
    }
  })

  it('refuses a principal that does not fit u64', () => {
    expect(() =>
      settleExit({
        rungs: GRID_POSITION,
        principalMicro: U64_MAX + 1n,
        feeDueMicro: 0n,
        shareBps: 10_000,
        spreadCoefBps: SPREAD_COEF_BPS,
        nowTs: NOW_TS,
      }),
    ).toThrow(MathOverflowError)
  })
})
