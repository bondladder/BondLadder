import { exitQuote, type Position, positionSchema, SECONDS_PER_YEAR } from '@bondladder/shared'
import { describe, expect, it } from 'vitest'
import { MeasureError } from './measure-us1'
import {
  DEPOSIT_COUNT,
  depositSizes,
  driftPpm,
  EXIT_SHARES_BPS,
  judgeQuotes,
  payoutFloor,
  quoteShare,
  withinQuoteBudget,
} from './measure-us2'

const MIN_DEPOSIT = 1_000_000_000n
const NOW = 1_790_000_000n
const DAY = 86_400n
const MINTS = [
  'So11111111111111111111111111111111111111112',
  'EX1tNj2MLTacJPfAVzbBW8ejFsnSp7AsnZvnRLmDy3vK',
  'EWhJjvNVb5mh1Jb9DTzvTwk7BeS9qdZdK7a6vdneQPa9',
  'HftEWpSw9jNCrBiX9CKD8GG1AFTVBSvDgbu1FbNTK4tz',
  '8dd8kVyShvfPXs4XFipTWSYL1PzH35kfr3KNc6qpVtdP',
] as const
const UNITS = [41n, 40n, 39n, 40n, 42n] as const
const PRICES = [4_870_000n, 4_910_000n, 5_020_000n, 4_960_000n, 4_880_000n] as const
const MONTHS = [3, 6, 9, 12, 18] as const

function position(lastFeeTs: bigint): Position {
  return positionSchema.parse({
    owner: 'D1bBmUA4Yc8viAwjwLR2fz14r7JSoxC6b5HWr2artfQS',
    profile: 'conservative',
    rungs: MINTS.map((mint, index) => ({
      targetMonths: MONTHS[index],
      instrument: mint,
      amount: UNITS[index],
      entryPriceMicro: PRICES[index],
      entryNotch: 18,
      maturityTs: NOW + BigInt(MONTHS[index] ?? 0) * 30n * DAY,
      flagged: false,
    })),
    principalUsdc: 997_540_000n,
    feeAccrued: 1_234n,
    lastFeeTs,
    openedAt: NOW - 10n * DAY,
    bump: 255,
  })
}

const PRICE_BY_MINT: ReadonlyMap<string, bigint> = new Map(
  MINTS.map((mint, index) => [mint, PRICES[index] ?? 0n]),
)
const GROSS = UNITS.reduce((sum, units, index) => sum + units * (PRICES[index] ?? 0n), 0n)
const VAULT = { feeBps: 50, spreadCoefBps: 200 }

describe('the exit plan', () => {
  it('adds up to the hundred exits SC-006 asks for', () => {
    expect(DEPOSIT_COUNT * EXIT_SHARES_BPS.length).toBe(100)
  })

  // Every round has to close the position, or the next deposit would find the
  // PDA taken and the run would stop at round two.
  it('ends every round with a full exit', () => {
    expect(EXIT_SHARES_BPS[EXIT_SHARES_BPS.length - 1]).toBe(10_000)
  })

  it('starts at the vault minimum and never repeats a size', () => {
    const sizes = depositSizes(MIN_DEPOSIT)

    expect(sizes).toHaveLength(DEPOSIT_COUNT)
    expect(sizes[0]).toBe(MIN_DEPOSIT)
    for (let index = 1; index < sizes.length; index += 1) {
      expect(sizes[index]).toBeGreaterThan(sizes[index - 1] ?? 0n)
    }
  })

  it('leaves amounts that are not whole USDC, so rounding is exercised', () => {
    expect(depositSizes(MIN_DEPOSIT).some((size) => size % 1_000_000n !== 0n)).toBe(true)
  })

  it('fits the pool the devnet backstop holds today', () => {
    const total = depositSizes(MIN_DEPOSIT).reduce((sum, size) => sum + size, 0n)

    expect(total).toBeLessThan(99_016_003_113n)
  })
})

describe('quoteShare', () => {
  const lastFeeTs = NOW - 3n * DAY
  const feeDue = 1_234n + (GROSS * 50n * 3n * DAY) / (10_000n * SECONDS_PER_YEAR)

  it('quotes a full exit exactly as the shared exit quote does', () => {
    const settlement = quoteShare({
      position: position(lastFeeTs),
      prices: PRICE_BY_MINT,
      ...VAULT,
      shareBps: 10_000,
      nowTs: NOW,
    })
    const reference = exitQuote({
      rungs: MINTS.map((_, index) => ({
        units: UNITS[index] ?? 0n,
        priceMicro: PRICES[index] ?? 0n,
        maturityTs: NOW + BigInt(MONTHS[index] ?? 0) * 30n * DAY,
      })),
      nowTs: NOW,
      feeDueMicro: feeDue,
      spreadCoefBps: 200,
    })

    expect(settlement.feeChargedMicro).toBe(feeDue)
    expect(settlement.payoutMicro).toBe(reference.payoutMicro)
  })

  it('charges the whole fee due against a partial slice', () => {
    const settlement = quoteShare({
      position: position(lastFeeTs),
      prices: PRICE_BY_MINT,
      ...VAULT,
      shareBps: 2_500,
      nowTs: NOW,
    })

    expect(settlement.units).toEqual(UNITS.map((units) => (units * 2_500n) / 10_000n))
    expect(settlement.feeChargedMicro).toBe(feeDue)
  })

  it('accrues nothing when the clock reads earlier than the last charge', () => {
    const settlement = quoteShare({
      position: position(NOW + 60n),
      prices: PRICE_BY_MINT,
      ...VAULT,
      shareBps: 10_000,
      nowTs: NOW,
    })

    expect(settlement.feeChargedMicro).toBe(1_234n)
  })

  it('refuses to quote a rung whose price was not read', () => {
    const prices = new Map(PRICE_BY_MINT)
    prices.delete(MINTS[2])

    expect(() =>
      quoteShare({ position: position(lastFeeTs), prices, ...VAULT, shareBps: 10_000, nowTs: NOW }),
    ).toThrow(MeasureError)
  })
})

describe('payoutFloor', () => {
  it('signs the same floor the exit screen signs, rounded in the owner’s favour', () => {
    expect(payoutFloor(490_567_373n)).toBe(490_076_805n)
  })
})

describe('the quote budget', () => {
  it('holds at exactly 0.1% either way', () => {
    expect(withinQuoteBudget(1_000_000n, 999_000n)).toBe(true)
    expect(withinQuoteBudget(1_000_000n, 1_001_000n)).toBe(true)
  })

  it('breaks one micro-USDC past 0.1%', () => {
    expect(withinQuoteBudget(1_000_000n, 998_999n)).toBe(false)
    expect(withinQuoteBudget(1_000_000n, 1_001_001n)).toBe(false)
  })

  it('keeps the sign of the drift', () => {
    expect(driftPpm(1_000_000n, 999_000n)).toBe(-1_000n)
    expect(driftPpm(1_000_000n, 1_000_001n)).toBe(1n)
  })
})

describe('judgeQuotes', () => {
  it('reports the drift furthest from zero, whichever way it went', () => {
    const verdict = judgeQuotes([
      { quotedMicro: 1_000_000n, receivedMicro: 999_999n },
      { quotedMicro: 1_000_000n, receivedMicro: 1_000_400n },
      { quotedMicro: 1_000_000n, receivedMicro: 1_000_000n },
    ])

    expect(verdict).toMatchObject({
      count: 3,
      refused: 0,
      worstGapMicro: 400n,
      worstPpm: 400n,
      withinBudget: true,
    })
  })

  it('fails on a single exit past the budget', () => {
    const verdict = judgeQuotes([
      { quotedMicro: 1_000_000n, receivedMicro: 1_000_000n },
      { quotedMicro: 1_000_000n, receivedMicro: 998_000n },
    ])

    expect(verdict.withinBudget).toBe(false)
    expect(verdict.worstPpm).toBe(-2_000n)
  })

  // Six micro-USDC on 190 USDC is 0.03 ppm: real, inside the budget, and
  // invisible once rounded to whole ppm.
  it('keeps a drift smaller than one ppm visible in micro-USDC', () => {
    const verdict = judgeQuotes([{ quotedMicro: 190_135_608n, receivedMicro: 190_135_602n }])

    expect(verdict).toMatchObject({ worstGapMicro: -6n, worstPpm: 0n, withinBudget: true })
  })

  it('ranks drift by size relative to the exit, not in absolute micro-USDC', () => {
    const verdict = judgeQuotes([
      { quotedMicro: 5_000_000_000n, receivedMicro: 4_999_999_990n },
      { quotedMicro: 100_000_000n, receivedMicro: 99_999_997n },
    ])

    expect(verdict.worstGapMicro).toBe(-3n)
  })

  // A QuoteDrift refusal is the program saying the payout fell below the
  // floor, i.e. past the budget; dropping it would hide the failure.
  it('counts a refused exit against the budget', () => {
    const verdict = judgeQuotes([
      { quotedMicro: 1_000_000n, receivedMicro: 1_000_000n },
      { quotedMicro: 1_000_000n, receivedMicro: null },
    ])

    expect(verdict).toMatchObject({ count: 2, refused: 1, withinBudget: false })
  })

  it('has nothing to judge without a sample', () => {
    expect(() => judgeQuotes([])).toThrow(MeasureError)
  })
})
