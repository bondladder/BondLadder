// Друга реалізація розкладки акаунтів із programs/*/src/state.rs: до підпису
// показуємо стан, прочитаний напряму з RPC (FR-001, FR-007). Обидві сторони
// звіряються з fixtures/accounts.json — додане в state.rs поле ламає
// programs/bond-ladder/tests/account_layout.rs, а не цей декодер мовчки.
//
// Дискримінатор і довжина акаунта перевіряються до читання полів: акаунт за
// адресою з RPC може виявитись чим завгодно.

import { z } from 'zod'

export class AccountDecodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AccountDecodeError'
  }
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function encodeBase58(bytes: Uint8Array): string {
  let leadingZeros = 0
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) {
    leadingZeros += 1
  }

  const digits: number[] = []
  for (const byte of bytes.subarray(leadingZeros)) {
    let carry = byte
    for (let index = 0; index < digits.length; index += 1) {
      carry += (digits[index] ?? 0) * 256
      digits[index] = carry % 58
      carry = Math.floor(carry / 58)
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = Math.floor(carry / 58)
    }
  }

  const characters: string[] = []
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    characters.push(BASE58_ALPHABET.charAt(digits[index] ?? 0))
  }

  return '1'.repeat(leadingZeros) + characters.join('')
}

const DISCRIMINATOR_LENGTH = 8
const ADDRESS_LENGTH = 32

const PRINTABLE_FIRST = 0x21
const PRINTABLE_LAST = 0x7e

const U16_MAX = 65_535
const U64_MAX = 2n ** 64n - 1n
const I64_MIN = -(2n ** 63n)
const I64_MAX = 2n ** 63n - 1n

class Reader {
  private offset = DISCRIMINATOR_LENGTH

  constructor(
    private readonly account: string,
    private readonly bytes: Uint8Array,
    private readonly view: DataView,
  ) {}

  private refuse(reason: string): never {
    throw new AccountDecodeError(`${this.account}: ${reason}`)
  }

  u8(): number {
    const value = this.view.getUint8(this.offset)
    this.offset += 1
    return value
  }

  u16(): number {
    const value = this.view.getUint16(this.offset, true)
    this.offset += 2
    return value
  }

  u64(): bigint {
    const value = this.view.getBigUint64(this.offset, true)
    this.offset += 8
    return value
  }

  i64(): bigint {
    const value = this.view.getBigInt64(this.offset, true)
    this.offset += 8
    return value
  }

  bool(): boolean {
    const value = this.u8()
    if (value > 1) {
      return this.refuse(`прапорець має значення ${value}`)
    }
    return value === 1
  }

  address(): string {
    const raw = this.bytes.subarray(this.offset, this.offset + ADDRESS_LENGTH)
    this.offset += ADDRESS_LENGTH
    return encodeBase58(raw)
  }

  // Мітка на дроті — ASCII, доповнений нулями. Без перевірки хвоста "MO\0DYS"
  // тихо стало б агентством "MO", як це вже ловить notch_for_encoded_label.
  tag(width: number): string {
    const raw = this.bytes.subarray(this.offset, this.offset + width)
    this.offset += width

    const end = raw.indexOf(0)
    const significant = end === -1 ? raw : raw.subarray(0, end)

    if (end !== -1 && raw.subarray(end).some((byte) => byte !== 0)) {
      return this.refuse('мітка має ненульовий хвіст після нуля')
    }
    if (significant.some((byte) => byte < PRINTABLE_FIRST || byte > PRINTABLE_LAST)) {
      return this.refuse('мітка має недрукований байт')
    }

    return String.fromCharCode(...significant)
  }
}

function open(
  account: string,
  discriminator: readonly number[],
  size: number,
  data: Uint8Array,
): Reader {
  if (data.length !== size) {
    throw new AccountDecodeError(`${account}: очікувалось ${size} байтів, отримано ${data.length}`)
  }
  if (discriminator.some((byte, index) => data[index] !== byte)) {
    throw new AccountDecodeError(`${account}: чужий дискримінатор`)
  }

  return new Reader(account, data, new DataView(data.buffer, data.byteOffset, data.byteLength))
}

function checked<T>(account: string, schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw)
  if (!result.success) {
    throw new AccountDecodeError(`${account}: ${result.error.message}`)
  }
  return result.data
}

const addressSchema = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'адреса не у base58')
  .brand<'Address'>()

const u8Schema = z.number().int().min(0).max(255)
const u16Schema = z.number().int().min(0).max(U16_MAX)
const u64Schema = z.bigint().min(0n).max(U64_MAX)
const i64Schema = z.bigint().min(I64_MIN).max(I64_MAX)

export type Address = z.infer<typeof addressSchema>

export const vaultSchema = z.strictObject({
  admin: addressSchema,
  usdcMint: addressSchema,
  ratingOracle: addressSchema,
  issuerProgram: addressSchema,
  feeBps: u16Schema,
  spreadCoefBps: u16Schema,
  crankRewardBps: u16Schema,
  minDeposit: u64Schema,
  capacityUsdc: u64Schema,
  backstopFreeUsdc: u64Schema,
  backstopLockedValue: u64Schema,
  paused: z.boolean(),
  bump: u8Schema,
})

export const oracleConfigSchema = z.strictObject({
  authority: addressSchema,
  maxAgeSecs: i64Schema,
  bump: u8Schema,
})

export const ratingRecordSchema = z.strictObject({
  instrumentMint: addressSchema,
  notch: u8Schema,
  scaleVersion: u8Schema,
  agencyCode: z.string().max(8),
  updatedAt: i64Schema,
  bump: u8Schema,
})

export const issuerConfigSchema = z.strictObject({
  authority: addressSchema,
  usdcMint: addressSchema,
  bump: u8Schema,
})

export const instrumentSchema = z.strictObject({
  mint: addressSchema,
  issuerId: z.string().max(16),
  maturityTs: i64Schema,
  couponBps: u16Schema,
  priceMicro: u64Schema,
  bump: u8Schema,
})

export type Vault = z.infer<typeof vaultSchema>
export type OracleConfig = z.infer<typeof oracleConfigSchema>
export type RatingRecord = z.infer<typeof ratingRecordSchema>
export type IssuerConfig = z.infer<typeof issuerConfigSchema>
export type Instrument = z.infer<typeof instrumentSchema>

const VAULT = {
  discriminator: [0xd3, 0x08, 0xe8, 0x2b, 0x02, 0x98, 0x75, 0x77],
  size: DISCRIMINATOR_LENGTH + 4 * ADDRESS_LENGTH + 3 * 2 + 4 * 8 + 1 + 1,
} as const

const ORACLE_CONFIG = {
  discriminator: [0x85, 0xc4, 0x98, 0x32, 0x1b, 0x15, 0x91, 0xfe],
  size: DISCRIMINATOR_LENGTH + ADDRESS_LENGTH + 8 + 1,
} as const

const RATING_RECORD = {
  discriminator: [0x36, 0x7c, 0x02, 0xc7, 0x6a, 0x6c, 0xec, 0x3a],
  size: DISCRIMINATOR_LENGTH + ADDRESS_LENGTH + 1 + 1 + 8 + 8 + 1,
  agencyCodeWidth: 8,
} as const

const ISSUER_CONFIG = {
  discriminator: [0xee, 0xf4, 0x47, 0xdd, 0xfe, 0xa9, 0xf7, 0xed],
  size: DISCRIMINATOR_LENGTH + 2 * ADDRESS_LENGTH + 1,
} as const

const INSTRUMENT = {
  discriminator: [0x3b, 0x0e, 0x5c, 0x92, 0x73, 0x22, 0x9b, 0x91],
  size: DISCRIMINATOR_LENGTH + ADDRESS_LENGTH + 16 + 8 + 2 + 8 + 1,
  issuerIdWidth: 16,
} as const

export function decodeVault(data: Uint8Array): Vault {
  const reader = open('Vault', VAULT.discriminator, VAULT.size, data)

  return checked('Vault', vaultSchema, {
    admin: reader.address(),
    usdcMint: reader.address(),
    ratingOracle: reader.address(),
    issuerProgram: reader.address(),
    feeBps: reader.u16(),
    spreadCoefBps: reader.u16(),
    crankRewardBps: reader.u16(),
    minDeposit: reader.u64(),
    capacityUsdc: reader.u64(),
    backstopFreeUsdc: reader.u64(),
    backstopLockedValue: reader.u64(),
    paused: reader.bool(),
    bump: reader.u8(),
  })
}

export function decodeOracleConfig(data: Uint8Array): OracleConfig {
  const reader = open('OracleConfig', ORACLE_CONFIG.discriminator, ORACLE_CONFIG.size, data)

  return checked('OracleConfig', oracleConfigSchema, {
    authority: reader.address(),
    maxAgeSecs: reader.i64(),
    bump: reader.u8(),
  })
}

export function decodeRatingRecord(data: Uint8Array): RatingRecord {
  const reader = open('RatingRecord', RATING_RECORD.discriminator, RATING_RECORD.size, data)

  return checked('RatingRecord', ratingRecordSchema, {
    instrumentMint: reader.address(),
    notch: reader.u8(),
    scaleVersion: reader.u8(),
    agencyCode: reader.tag(RATING_RECORD.agencyCodeWidth),
    updatedAt: reader.i64(),
    bump: reader.u8(),
  })
}

export function decodeIssuerConfig(data: Uint8Array): IssuerConfig {
  const reader = open('IssuerConfig', ISSUER_CONFIG.discriminator, ISSUER_CONFIG.size, data)

  return checked('IssuerConfig', issuerConfigSchema, {
    authority: reader.address(),
    usdcMint: reader.address(),
    bump: reader.u8(),
  })
}

export function decodeInstrument(data: Uint8Array): Instrument {
  const reader = open('Instrument', INSTRUMENT.discriminator, INSTRUMENT.size, data)

  return checked('Instrument', instrumentSchema, {
    mint: reader.address(),
    issuerId: reader.tag(INSTRUMENT.issuerIdWidth),
    maturityTs: reader.i64(),
    couponBps: reader.u16(),
    priceMicro: reader.u64(),
    bump: reader.u8(),
  })
}
