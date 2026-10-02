import { describe, expect, it } from 'vitest'
import rawFixture from '../../../fixtures/instructions.json'
import {
  ACCOUNTS_PER_RUNG,
  EXIT_ACCOUNTS_PER_RUNG,
  EXIT_LADDER_ACCOUNTS,
  EXIT_LADDER_DISCRIMINATOR,
  exitLadderData,
  InstructionEncodeError,
  OPEN_LADDER_ACCOUNTS,
  OPEN_LADDER_DISCRIMINATOR,
  openLadderData,
  profileSeedByte,
  SEED_BACKSTOP,
  SEED_INSTRUMENT,
  SEED_ISSUER,
  SEED_ORACLE,
  SEED_POSITION,
  SEED_RATING,
  SEED_VAULT,
} from './instructions'
import type { RiskProfile } from './profiles'

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

const openLadder = rawFixture.openLadder

describe('open_ladder на дроті', () => {
  it('кодує кожен випадок зі спільного фікстура', () => {
    expect(openLadder.cases.length).toBe(2)

    for (const entry of openLadder.cases) {
      const encoded = openLadderData(entry.profile as RiskProfile, BigInt(entry.depositMicro))

      expect(hex(encoded)).toBe(entry.data)
    }
  })

  it('починає дані дискримінатором інструкції', () => {
    expect(hex(OPEN_LADDER_DISCRIMINATOR)).toBe(openLadder.discriminator)
    expect(hex(openLadderData('conservative', 0n)).startsWith(openLadder.discriminator)).toBe(true)
  })

  it('тримає порядок і права акаунтів такими, як їх читає програма', () => {
    expect(OPEN_LADDER_ACCOUNTS).toEqual(openLadder.accounts)
  })

  it('відмовляє на депозиті поза шириною u64', () => {
    expect(() => openLadderData('conservative', 2n ** 64n)).toThrow(InstructionEncodeError)
    expect(() => openLadderData('conservative', -1n)).toThrow(InstructionEncodeError)
  })

  it('лишає межу u64 придатною', () => {
    expect(() => openLadderData('balanced', 2n ** 64n - 1n)).not.toThrow()
  })

  it('очікує чотири акаунти на щабель', () => {
    expect(ACCOUNTS_PER_RUNG).toBe(4)
  })
})

const exitLadder = rawFixture.exitLadder

describe('exit_ladder on the wire', () => {
  it('encodes every case of the shared fixture', () => {
    expect(exitLadder.cases.length).toBe(2)

    for (const entry of exitLadder.cases) {
      const encoded = exitLadderData(entry.shareBps, BigInt(entry.minPayoutMicro))

      expect(hex(encoded), entry.case).toBe(entry.data)
    }
  })

  it('starts the data with the instruction discriminator', () => {
    expect(hex(EXIT_LADDER_DISCRIMINATOR)).toBe(exitLadder.discriminator)
  })

  it('keeps the accounts in the order and with the rights the program reads them', () => {
    expect(EXIT_LADDER_ACCOUNTS).toEqual(exitLadder.accounts)
    expect(EXIT_ACCOUNTS_PER_RUNG).toBe(exitLadder.accountsPerRung)
  })

  it('refuses a share or a floor outside their widths', () => {
    expect(() => exitLadderData(65_536, 0n)).toThrow(InstructionEncodeError)
    expect(() => exitLadderData(-1, 0n)).toThrow(InstructionEncodeError)
    expect(() => exitLadderData(1.5, 0n)).toThrow(InstructionEncodeError)
    expect(() => exitLadderData(10_000, 2n ** 64n)).toThrow(InstructionEncodeError)
    expect(() => exitLadderData(10_000, -1n)).toThrow(InstructionEncodeError)
  })
})

describe('сіди й байт профілю', () => {
  it('збігаються зі спільним фікстуром', () => {
    expect(text(SEED_VAULT)).toBe(rawFixture.seeds.vault)
    expect(text(SEED_POSITION)).toBe(rawFixture.seeds.position)
    expect(text(SEED_ORACLE)).toBe(rawFixture.seeds.oracle)
    expect(text(SEED_ISSUER)).toBe(rawFixture.seeds.issuer)
    expect(text(SEED_INSTRUMENT)).toBe(rawFixture.seeds.instrument)
    expect(text(SEED_RATING)).toBe(rawFixture.seeds.rating)
    expect(text(SEED_BACKSTOP)).toBe(rawFixture.seeds.backstop)
  })

  // Байт сіда виписаний у програмі окремо від borsh-варіанта саме на випадок
  // перестановки варіантів, тож і звіряється він окремо від даних інструкції.
  it('дають той самий байт профілю, що й програма', () => {
    for (const entry of rawFixture.profileSeedBytes) {
      expect(profileSeedByte(entry.profile as RiskProfile)).toBe(entry.seedByte)
    }
  })
})
