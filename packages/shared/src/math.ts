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
