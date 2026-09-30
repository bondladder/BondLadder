import { describe, expect, it } from 'vitest'
import { DeployError, MICRO_PER_USDC } from './deploy'
import { BACKSTOP_TARGET_MICRO, backstopTopUp, parseTargetMicro } from './fund-backstop'

const THOUSAND_USDC = 1_000n * MICRO_PER_USDC

describe('backstopTopUp', () => {
  it('funds only the gap between the free backstop and the target', () => {
    expect(backstopTopUp(30n * THOUSAND_USDC, 100n * THOUSAND_USDC)).toBe(70n * THOUSAND_USDC)
  })

  it('funds the whole target into an empty pool', () => {
    expect(backstopTopUp(0n, BACKSTOP_TARGET_MICRO)).toBe(BACKSTOP_TARGET_MICRO)
  })

  it('funds nothing once the target is reached', () => {
    expect(backstopTopUp(BACKSTOP_TARGET_MICRO, BACKSTOP_TARGET_MICRO)).toBe(0n)
  })

  it('funds nothing and withdraws nothing when the pool is above the target', () => {
    expect(backstopTopUp(BACKSTOP_TARGET_MICRO + 1n, BACKSTOP_TARGET_MICRO)).toBe(0n)
  })
})

describe('parseTargetMicro', () => {
  it('defaults to 100 000 USDC, enough for a hundred minimum-deposit exits', () => {
    expect(parseTargetMicro(undefined)).toBe(100n * THOUSAND_USDC)
    expect(BACKSTOP_TARGET_MICRO).toBe(100n * THOUSAND_USDC)
  })

  it('reads a whole number of USDC', () => {
    expect(parseTargetMicro('250000')).toBe(250n * THOUSAND_USDC)
  })

  it.each(['', '0', '-5', '1.5', '1e6', 'abc', ' 100'])('refuses «%s»', (raw) => {
    expect(() => parseTargetMicro(raw)).toThrow(DeployError)
  })

  it('refuses a target that does not fit the u64 counter', () => {
    expect(() => parseTargetMicro('18446744073710')).toThrow(DeployError)
  })
})
