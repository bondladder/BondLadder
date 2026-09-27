// Дзеркало programs/bond-ladder/src/math.rs. Дублювання свідоме: нараховану
// комісію треба показати окремим рядком до підпису (FR-030), а програма
// списує її насправді. Обидві сторони звіряються з fixtures/math.json, тому
// розбіжність дає червоний тест, а не розходження котирування з фактом.

export class MathOverflowError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MathOverflowError'
  }
}

/// Юліанський рік — той самий, що в math.rs.
export const SECONDS_PER_YEAR = 31_557_600n

export const BPS_DENOMINATOR = 10_000n

const DENOMINATOR = BPS_DENOMINATOR * SECONDS_PER_YEAR

// bigint не має ширини, а u64 і u128 у програмі мають. Межі перевіряються
// тут явно, інакше дзеркало показало б суму, яку програма відмовиться списати.
const U16_MAX = 65_535
const U64_MAX = 2n ** 64n - 1n
const U128_MAX = 2n ** 128n - 1n

function requireWidth(fits: boolean, reason: string): void {
  if (!fits) {
    throw new MathOverflowError(reason)
  }
}

export function accrueFee(valueMicro: bigint, feeBps: number, elapsedSeconds: bigint): bigint {
  requireWidth(valueMicro >= 0n && valueMicro <= U64_MAX, 'вартість позиції не вміщається в u64')
  requireWidth(
    Number.isInteger(feeBps) && feeBps >= 0 && feeBps <= U16_MAX,
    'ставка не вміщається в u16',
  )
  requireWidth(elapsedSeconds >= 0n && elapsedSeconds <= U64_MAX, 'проміжок не вміщається в u64')

  const numerator = valueMicro * BigInt(feeBps) * elapsedSeconds
  requireWidth(numerator <= U128_MAX, 'добуток не вміщається в u128')

  const accrued = numerator / DENOMINATOR
  requireWidth(accrued <= U64_MAX, 'нарахування не вміщається в u64')

  return accrued
}

export const SECONDS_PER_DAY = 86_400n

/// Four julian years in whole days — the fee's year again, since a quarter of
/// a day has no integer form. The spread numerator carries the matching four.
export const DAYS_PER_FOUR_YEARS = 1_461n

const YEARS_IN_DENOMINATOR = 4n

const SPREAD_DENOMINATOR = BPS_DENOMINATOR * DAYS_PER_FOUR_YEARS

const I64_MIN = -(2n ** 63n)
const I64_MAX = 2n ** 63n - 1n

function fitsU64(value: bigint): boolean {
  return value >= 0n && value <= U64_MAX
}

function fitsI64(value: bigint): boolean {
  return value >= I64_MIN && value <= I64_MAX
}

function fitsU16(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= U16_MAX
}

/** A rung as the exit quote sees it: today's price, not the entry price (FR-013). */
export interface RungValue {
  readonly units: bigint
  readonly priceMicro: bigint
  readonly maturityTs: bigint
}

function daysToMaturity(maturityTs: bigint, nowTs: bigint): bigint {
  // The program subtracts in i64 with saturation; bigint would not stop.
  const remaining = maturityTs - nowTs
  if (remaining <= 0n) {
    return 0n
  }

  return (remaining > I64_MAX ? I64_MAX : remaining) / SECONDS_PER_DAY
}

/**
 * Value-weighted remaining duration in whole days, each rung floored before it
 * is weighted — the figure the exit quote prints (FR-028). The dashboard's
 * `averageRemainingSeconds` weighs seconds and floors once, and stays a
 * different number on purpose.
 */
export function weightedRemainingDays(rungs: readonly RungValue[], nowTs: bigint): bigint {
  requireWidth(fitsI64(nowTs), 'the clock does not fit i64')

  let weighted = 0n
  let totalValue = 0n

  for (const rung of rungs) {
    requireWidth(fitsU64(rung.units), 'rung units do not fit u64')
    requireWidth(fitsU64(rung.priceMicro), 'rung price does not fit u64')
    requireWidth(fitsI64(rung.maturityTs), 'rung maturity does not fit i64')

    const value = rung.units * rung.priceMicro
    weighted += value * daysToMaturity(rung.maturityTs, nowTs)
    totalValue += value
    requireWidth(
      weighted <= U128_MAX && totalValue <= U128_MAX,
      'weighted duration does not fit u128',
    )
  }

  if (totalValue === 0n) {
    return 0n
  }

  return weighted / totalValue
}

/**
 * The spread withheld on an instant exit (FR-013), taken off what the accrued
 * fee leaves behind (FR-030). Gross value and fee travel separately so the
 * order of the two withholdings is fixed here, as in the program.
 */
export function exitSpread(
  grossValueMicro: bigint,
  feeDueMicro: bigint,
  spreadCoefBps: number,
  wrdDays: bigint,
): bigint {
  requireWidth(fitsU64(grossValueMicro), 'position value does not fit u64')
  requireWidth(fitsU64(feeDueMicro), 'fee due does not fit u64')
  requireWidth(fitsU16(spreadCoefBps), 'spread coefficient does not fit u16')
  requireWidth(fitsU64(wrdDays), 'duration does not fit u64')

  const netValueMicro = grossValueMicro > feeDueMicro ? grossValueMicro - feeDueMicro : 0n
  const numerator = netValueMicro * BigInt(spreadCoefBps) * wrdDays * YEARS_IN_DENOMINATOR
  requireWidth(numerator <= U128_MAX, 'spread product does not fit u128')

  const spread = numerator / SPREAD_DENOMINATOR
  requireWidth(spread <= U64_MAX, 'spread does not fit u64')

  return spread
}

export interface ExitQuoteInput {
  readonly rungs: readonly RungValue[]
  readonly nowTs: bigint
  readonly feeDueMicro: bigint
  readonly spreadCoefBps: number
}

/** The breakdown shown before signing (FR-028), every figure net of the fee (FR-030). */
export interface ExitQuote {
  readonly grossValueMicro: bigint
  readonly netValueMicro: bigint
  readonly wrdDays: bigint
  readonly spreadMicro: bigint
  readonly payoutMicro: bigint
}

export function exitQuote(input: ExitQuoteInput): ExitQuote {
  const wrdDays = weightedRemainingDays(input.rungs, input.nowTs)
  const grossValueMicro = input.rungs.reduce((sum, rung) => sum + rung.units * rung.priceMicro, 0n)
  requireWidth(fitsU64(grossValueMicro), 'position value does not fit u64')

  const spreadMicro = exitSpread(grossValueMicro, input.feeDueMicro, input.spreadCoefBps, wrdDays)
  const netValueMicro =
    grossValueMicro > input.feeDueMicro ? grossValueMicro - input.feeDueMicro : 0n
  // Unreachable at the configured coefficient, but a payout below zero is a
  // quote no transaction could settle, so it is refused rather than shown.
  requireWidth(spreadMicro <= netValueMicro, 'spread exceeds what the position is worth')

  return {
    grossValueMicro,
    netValueMicro,
    wrdDays,
    spreadMicro,
    payoutMicro: netValueMicro - spreadMicro,
  }
}
