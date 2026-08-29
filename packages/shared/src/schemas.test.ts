import { describe, expect, it } from 'vitest'
import rawFixture from '../../../fixtures/accounts.json'
import {
  AccountDecodeError,
  decodeInstrument,
  decodeIssuerConfig,
  decodeOracleConfig,
  decodeRatingRecord,
  decodeVault,
  vaultSchema,
} from './schemas'

type Decoded = Record<string, string | number | boolean>

const cases = rawFixture.accounts as ReadonlyArray<{
  case: string
  account: string
  data: string
  decoded: Decoded
}>

const DISCRIMINATOR_LENGTH = 8

function bytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return out
}

function caseNamed(name: string): { data: string; decoded: Decoded } {
  const found = cases.find((entry) => entry.case === name)
  if (found === undefined) {
    throw new Error(`у фікстурі немає випадку ${name}`)
  }
  return found
}

function decodedBy(account: string, data: Uint8Array): unknown {
  switch (account) {
    case 'Vault':
      return decodeVault(data)
    case 'OracleConfig':
      return decodeOracleConfig(data)
    case 'RatingRecord':
      return decodeRatingRecord(data)
    case 'IssuerConfig':
      return decodeIssuerConfig(data)
    case 'Instrument':
      return decodeInstrument(data)
    default:
      throw new Error(`у фікстурі невідомий акаунт ${account}`)
  }
}

function expectedFor(account: string, d: Decoded): unknown {
  switch (account) {
    case 'Vault':
      return {
        admin: String(d.admin),
        usdcMint: String(d.usdcMint),
        ratingOracle: String(d.ratingOracle),
        issuerProgram: String(d.issuerProgram),
        feeBps: Number(d.feeBps),
        spreadCoefBps: Number(d.spreadCoefBps),
        crankRewardBps: Number(d.crankRewardBps),
        minDeposit: BigInt(String(d.minDeposit)),
        capacityUsdc: BigInt(String(d.capacityUsdc)),
        backstopFreeUsdc: BigInt(String(d.backstopFreeUsdc)),
        backstopLockedValue: BigInt(String(d.backstopLockedValue)),
        paused: d.paused === true,
        bump: Number(d.bump),
      }
    case 'OracleConfig':
      return {
        authority: String(d.authority),
        maxAgeSecs: BigInt(String(d.maxAgeSecs)),
        bump: Number(d.bump),
      }
    case 'RatingRecord':
      return {
        instrumentMint: String(d.instrumentMint),
        notch: Number(d.notch),
        scaleVersion: Number(d.scaleVersion),
        agencyCode: String(d.agencyCode),
        updatedAt: BigInt(String(d.updatedAt)),
        bump: Number(d.bump),
      }
    case 'IssuerConfig':
      return {
        authority: String(d.authority),
        usdcMint: String(d.usdcMint),
        bump: Number(d.bump),
      }
    case 'Instrument':
      return {
        mint: String(d.mint),
        issuerId: String(d.issuerId),
        maturityTs: BigInt(String(d.maturityTs)),
        couponBps: Number(d.couponBps),
        priceMicro: BigInt(String(d.priceMicro)),
        bump: Number(d.bump),
      }
    default:
      throw new Error(`у фікстурі невідомий акаунт ${account}`)
  }
}

describe('декодери акаунтів', () => {
  it('декодують кожен випадок зі спільного фікстура', () => {
    expect(cases.length).toBe(7)

    for (const entry of cases) {
      expect(decodedBy(entry.account, bytes(entry.data))).toEqual(
        expectedFor(entry.account, entry.decoded),
      )
    }
  })

  it('не втрачають точність на межі u64', () => {
    const limits = caseNamed('vaultAtTheLimits')

    expect(decodeVault(bytes(limits.data)).capacityUsdc).toBe(2n ** 64n - 1n)
  })

  it('кодують адреси так само, як програма', () => {
    const template = bytes(caseNamed('issuerConfig').data)

    for (const vector of rawFixture.addresses) {
      const carrier = Uint8Array.from(template)
      carrier.set(bytes(vector.bytes), DISCRIMINATOR_LENGTH)

      expect(decodeIssuerConfig(carrier).authority).toBe(vector.address)
    }
  })

  it('відкидають акаунт із чужим дискримінатором', () => {
    const foreign = bytes(caseNamed('vault').data)
    foreign[0] = (foreign[0] ?? 0) ^ 0xff

    expect(() => decodeVault(foreign)).toThrow(AccountDecodeError)
  })

  it('відкидають декодування акаунта не тим декодером', () => {
    expect(() => decodeVault(bytes(caseNamed('issuerConfig').data))).toThrow(AccountDecodeError)
  })

  it('відкидають акаунт не тієї довжини', () => {
    const vault = bytes(caseNamed('vault').data)

    expect(() => decodeVault(vault.subarray(0, vault.length - 1))).toThrow(AccountDecodeError)

    const padded = new Uint8Array(vault.length + 1)
    padded.set(vault)
    expect(() => decodeVault(padded)).toThrow(AccountDecodeError)
  })

  // Той самий капкан, що й у notch_for_encoded_label: без перевірки хвоста
  // "MO\0DYS" тихо стало б агентством "MO".
  it('відкидають мітку з ненульовим хвостом', () => {
    const record = bytes(caseNamed('ratingRecord').data)
    const agencyCodeAt = DISCRIMINATOR_LENGTH + 32 + 2

    record[agencyCodeAt + 2] = 0

    expect(() => decodeRatingRecord(record)).toThrow(AccountDecodeError)
  })

  it('відкидають мітку з недрукованим байтом', () => {
    const record = bytes(caseNamed('ratingRecord').data)
    const agencyCodeAt = DISCRIMINATOR_LENGTH + 32 + 2

    record[agencyCodeAt] = 0x01

    expect(() => decodeRatingRecord(record)).toThrow(AccountDecodeError)
  })

  it('приймають мітку, що займає всю ширину поля', () => {
    const full = caseNamed('ratingRecordBeforeTheEpoch')

    expect(decodeRatingRecord(bytes(full.data)).agencyCode).toBe('FITCHIBM')
  })

  it('декодують від’ємну мітку часу', () => {
    const before = caseNamed('ratingRecordBeforeTheEpoch')

    expect(decodeRatingRecord(bytes(before.data)).updatedAt).toBe(-1n)
  })
})

describe('схеми акаунтів', () => {
  const valid = {
    admin: '11111111111111111111111111111111',
    usdcMint: '11111111111111111111111111111111',
    ratingOracle: '11111111111111111111111111111111',
    issuerProgram: '11111111111111111111111111111111',
    feeBps: 50,
    spreadCoefBps: 200,
    crankRewardBps: 10,
    minDeposit: 100_000_000n,
    capacityUsdc: 10_000_000_000n,
    backstopFreeUsdc: 0n,
    backstopLockedValue: 0n,
    paused: false,
    bump: 254,
  }

  it('приймають те, що повертає декодер', () => {
    expect(vaultSchema.safeParse(valid).success).toBe(true)
  })

  it('відкидають адресу, якої немає в base58', () => {
    expect(vaultSchema.safeParse({ ...valid, admin: 'not an address: 0OIl' }).success).toBe(false)
  })

  it('відкидають величину поза шириною поля', () => {
    expect(vaultSchema.safeParse({ ...valid, feeBps: 65_536 }).success).toBe(false)
    expect(vaultSchema.safeParse({ ...valid, capacityUsdc: 2n ** 64n }).success).toBe(false)
    expect(vaultSchema.safeParse({ ...valid, bump: -1 }).success).toBe(false)
  })

  it('відкидають число там, де програма пише 64 біти', () => {
    expect(vaultSchema.safeParse({ ...valid, minDeposit: 100_000_000 }).success).toBe(false)
  })

  it('відкидають зайве поле', () => {
    expect(vaultSchema.safeParse({ ...valid, surprise: 1 }).success).toBe(false)
  })
})
