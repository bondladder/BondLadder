import { describe, expect, it } from 'vitest'
import { MICRO_PER_USDC } from './deploy'
import { PAR_MICRO, redeemableMicro, treasuryTopUp } from './fund-treasury'

describe('redeemableMicro', () => {
  it('owes one USDC of face value for every unit in circulation', () => {
    expect(PAR_MICRO).toBe(MICRO_PER_USDC)
    expect(redeemableMicro([200n, 0n, 1_010n])).toBe(1_210n * MICRO_PER_USDC)
  })

  it('owes nothing when no instrument was bought', () => {
    expect(redeemableMicro([])).toBe(0n)
    expect(redeemableMicro([0n, 0n])).toBe(0n)
  })
})

describe('treasuryTopUp', () => {
  it('funds only the gap between what the treasury holds and the face value owed', () => {
    expect(treasuryTopUp(950n * MICRO_PER_USDC, 1_000n * MICRO_PER_USDC)).toBe(50n * MICRO_PER_USDC)
  })

  it('funds nothing once the face value is covered', () => {
    expect(treasuryTopUp(1_000n * MICRO_PER_USDC, 1_000n * MICRO_PER_USDC)).toBe(0n)
  })

  it('funds nothing and withdraws nothing when the treasury holds more', () => {
    expect(treasuryTopUp(1_000n * MICRO_PER_USDC + 1n, 1_000n * MICRO_PER_USDC)).toBe(0n)
  })
})
