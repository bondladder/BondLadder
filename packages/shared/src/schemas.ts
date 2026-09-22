// Друга реалізація розкладки акаунтів із programs/*/src/state.rs: до підпису
// показуємо стан, прочитаний напряму з RPC (FR-001, FR-007). Обидві сторони
// звіряються з fixtures/accounts.json — додане в state.rs поле ламає
// programs/bond-ladder/tests/account_layout.rs, а не цей декодер мовчки.
//
// Дискримінатор і довжина акаунта перевіряються до читання полів: акаунт за
// адресою з RPC може виявитись чим завгодно.

import { z } from 'zod'

import { RUNG_COUNT, type RiskProfile } from './profiles'
import { SCALE_VERSION } from './scale'

export class AccountDecodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AccountDecodeError'
  }
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

export function encodeBase58(bytes: Uint8Array): string {
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

  // Варіант enum на дроті — індекс, а не назва. Невідомий індекс означає або
  // чужий акаунт, або програму новішу за цей декодер; і те, і те читається
  // неправильно, тому значення за замовчуванням тут бути не може.
  variant<T extends string>(names: readonly T[]): T {
    const index = this.u8()
    const name = names[index]
    if (name === undefined) {
      return this.refuse(`варіант ${index} програмі невідомий`)
    }
    return name
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
  totalPrincipalUsdc: u64Schema,
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

const profileSchema = z.enum(['conservative', 'balanced'])

export const rungSchema = z.strictObject({
  targetMonths: u8Schema,
  instrument: addressSchema,
  amount: u64Schema,
  entryPriceMicro: u64Schema,
  entryNotch: u8Schema,
  maturityTs: i64Schema,
  flagged: z.boolean(),
})

export const positionSchema = z.strictObject({
  owner: addressSchema,
  profile: profileSchema,
  rungs: z.array(rungSchema).length(RUNG_COUNT),
  principalUsdc: u64Schema,
  feeAccrued: u64Schema,
  lastFeeTs: i64Schema,
  openedAt: i64Schema,
  bump: u8Schema,
})

export type Vault = z.infer<typeof vaultSchema>
export type OracleConfig = z.infer<typeof oracleConfigSchema>
export type RatingRecord = z.infer<typeof ratingRecordSchema>
export type IssuerConfig = z.infer<typeof issuerConfigSchema>
export type Instrument = z.infer<typeof instrumentSchema>
export type Rung = z.infer<typeof rungSchema>
export type Position = z.infer<typeof positionSchema>

const VAULT = {
  discriminator: [0xd3, 0x08, 0xe8, 0x2b, 0x02, 0x98, 0x75, 0x77],
  size: DISCRIMINATOR_LENGTH + 4 * ADDRESS_LENGTH + 3 * 2 + 5 * 8 + 1 + 1,
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

const RUNG_SIZE = 1 + ADDRESS_LENGTH + 8 + 8 + 1 + 8 + 1

const POSITION = {
  discriminator: [0xaa, 0xbc, 0x8f, 0xe4, 0x7a, 0x40, 0xf7, 0xd0],
  size: DISCRIMINATOR_LENGTH + ADDRESS_LENGTH + 1 + RUNG_COUNT * RUNG_SIZE + 4 * 8 + 1,
  profiles: ['conservative', 'balanced'],
} as const

/// Дискримінатор і довжина акаунта — це фільтр getProgramAccounts, яким
/// браузер знаходить каталог, не знаючи жодної адреси наперед (T027). Без
/// фільтра клієнт тягнув би всі акаунти програми і розбирав би їх сам.
export interface AccountLayout {
  readonly discriminator: readonly number[]
  readonly size: number
}

export const INSTRUMENT_ACCOUNT: AccountLayout = INSTRUMENT
export const RATING_RECORD_ACCOUNT: AccountLayout = RATING_RECORD

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
    totalPrincipalUsdc: reader.u64(),
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

export function decodePosition(data: Uint8Array): Position {
  const reader = open('Position', POSITION.discriminator, POSITION.size, data)

  const owner = reader.address()
  const profile: RiskProfile = reader.variant(POSITION.profiles)
  const rungs = Array.from({ length: RUNG_COUNT }, () => ({
    targetMonths: reader.u8(),
    instrument: reader.address(),
    amount: reader.u64(),
    entryPriceMicro: reader.u64(),
    entryNotch: reader.u8(),
    maturityTs: reader.i64(),
    flagged: reader.bool(),
  }))

  return checked('Position', positionSchema, {
    owner,
    profile,
    rungs,
    principalUsdc: reader.u64(),
    feeAccrued: reader.u64(),
    lastFeeTs: reader.i64(),
    openedAt: reader.i64(),
    bump: reader.u8(),
  })
}

// Дзеркало RatingRecord::is_usable. Запис із чужої версії шкали читається так
// само, як застарілий: та сама цифра під іншою таблицею означала б інший
// щабель (FR-003, FR-025). Вік рівно у межі ще придатний — інакше клієнт
// відкидав би кандидата, якого програма приймає, і розкладка до підпису
// розійшлася б із записаною.
export function isRatingUsable(
  rating: Pick<RatingRecord, 'scaleVersion' | 'updatedAt'>,
  nowTs: bigint,
  maxAgeSecs: bigint,
): boolean {
  return rating.scaleVersion === SCALE_VERSION && nowTs - rating.updatedAt <= maxAgeSecs
}
