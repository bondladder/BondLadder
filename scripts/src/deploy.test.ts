import { describe, expect, it } from 'vitest'
import {
  AGENCY_CODE_LEN,
  encodeFixedAscii,
  ISSUER_ID_LEN,
  instrumentMintKeypair,
  isRateLimited,
  RATING_LABEL_LEN,
  toRatingArgs,
  toRegisterArgs,
  VAULT_PARAMS,
} from './deploy'
import { buildCatalog } from './seed-catalog'

const REFERENCE_TS = 1_800_000_000n

const BPS_DENOMINATOR = 10_000

describe('encodeFixedAscii', () => {
  it('вирівнює ліворуч і добиває нулями', () => {
    expect(encodeFixedAscii('FITCH', AGENCY_CODE_LEN, 'agencyCode')).toEqual(
      Uint8Array.from([0x46, 0x49, 0x54, 0x43, 0x48, 0, 0, 0]),
    )
  })

  it('приймає значення рівно у розмір поля', () => {
    expect(encodeFixedAscii('ORICON-LOGISTICS', ISSUER_ID_LEN, 'issuerId')).toHaveLength(
      ISSUER_ID_LEN,
    )
  })

  it('відмовляє, коли значення довше за поле, і називає поле', () => {
    expect(() => encodeFixedAscii('SEVENTEEN-CHARS!!', ISSUER_ID_LEN, 'issuerId')).toThrow(
      /issuerId/,
    )
  })

  // Багатобайтовий символ дав би довжину в байтах більшу за довжину рядка, і
  // мовчки з'їв би обмеження вище.
  it('відмовляє на не-ASCII', () => {
    expect(() => encodeFixedAscii('MOODYS™', AGENCY_CODE_LEN, 'agencyCode')).toThrow(/ASCII/)
  })
})

describe('toRegisterArgs', () => {
  it('переносить запис каталогу в аргументи register_instrument', () => {
    const [entry] = buildCatalog(REFERENCE_TS)
    if (entry === undefined) {
      throw new Error('каталог порожній')
    }

    const args = toRegisterArgs(entry)

    expect(args.issuerId).toEqual(encodeFixedAscii(entry.issuerId, ISSUER_ID_LEN, 'issuerId'))
    expect(args.maturityTs).toBe(entry.maturityTs)
    expect(args.couponBps).toBe(entry.couponBps)
    expect(args.priceMicro).toBe(entry.priceMicro)
  })
})

describe('toRatingArgs', () => {
  it('шле мітку, а не notch — нормалізація належить програмі (FR-003)', () => {
    const args = toRatingArgs({ ratingLabel: 'AAA', agencyCode: 'MOODYS' })

    expect(args.label).toEqual(Uint8Array.from([0x41, 0x41, 0x41, 0]))
    expect(args.agencyCode).toHaveLength(AGENCY_CODE_LEN)
  })

  it('відмовляє на мітці поза шкалою до відправки транзакції', () => {
    expect(() => toRatingArgs({ ratingLabel: 'AA+++', agencyCode: 'MOODYS' })).toThrow(/AA\+\+\+/)
  })
})

// Каталог редагують окремо від цього скрипта, і надто довгий ідентифікатор
// емітента виявився б лише відмовою транзакції на середині прогону.
describe('демо-каталог', () => {
  it('увесь кодується у поля фіксованої ширини', () => {
    for (const entry of buildCatalog(REFERENCE_TS)) {
      expect(() => toRegisterArgs(entry)).not.toThrow()
      expect(() => toRatingArgs(entry)).not.toThrow()
      expect(entry.ratingLabel.length).toBeLessThanOrEqual(RATING_LABEL_LEN)
    }
  })
})

// Ті самі межі, що VaultParams::validate перевіряє на ланцюзі: відмова має
// статись тут, а не після оплати трьох деплоїв.
describe('VAULT_PARAMS', () => {
  it('тримається меж, які програма перевіряє сама', () => {
    expect(VAULT_PARAMS.feeBps).toBeLessThanOrEqual(BPS_DENOMINATOR)
    expect(VAULT_PARAMS.spreadCoefBps).toBeLessThanOrEqual(BPS_DENOMINATOR)
    expect(VAULT_PARAMS.crankRewardBps).toBeLessThanOrEqual(BPS_DENOMINATOR)
    expect(VAULT_PARAMS.minDeposit).toBeGreaterThan(0n)
    expect(VAULT_PARAMS.capacityUsdc).toBeGreaterThanOrEqual(VAULT_PARAMS.minDeposit)
  })

  it('несе комісію 0.5% річних зі спеки (FR-020)', () => {
    expect(VAULT_PARAMS.feeBps).toBe(50)
  })

  // Неподільна решта обмежена ціною однієї одиниці на щабель (≈2.46 USDC на
  // демо-каталозі). На мінімумі 1000 USDC це ≤0.25%, на 100 було б 2.5%.
  it('тримає мінімальний депозит там, де здача лишається дрібницею', () => {
    expect(VAULT_PARAMS.minDeposit).toBeGreaterThanOrEqual(1_000_000_000n)
  })
})

// Прогін реєструє 45 інструментів, по одному на транзакцію. Випадкові мінти
// зробили б повторний запуск після обриву новим каталогом поверх старого, тож
// адреса мінта виводиться з самого запису.
describe('instrumentMintKeypair', () => {
  it('дає ту саму адресу для того самого запису каталогу', () => {
    const [entry] = buildCatalog(REFERENCE_TS)
    if (entry === undefined) {
      throw new Error('каталог порожній')
    }

    expect(instrumentMintKeypair(entry).publicKey.toBase58()).toBe(
      instrumentMintKeypair(entry).publicKey.toBase58(),
    )
  })

  it('не залежить від опорного часу — інакше повторний прогін дав би нові мінти', () => {
    const [early] = buildCatalog(REFERENCE_TS)
    const [late] = buildCatalog(REFERENCE_TS + 86_400n)
    if (early === undefined || late === undefined) {
      throw new Error('каталог порожній')
    }

    expect(instrumentMintKeypair(early).publicKey.toBase58()).toBe(
      instrumentMintKeypair(late).publicKey.toBase58(),
    )
  })

  it('дає різні адреси всім записам каталогу', () => {
    const catalog = buildCatalog(REFERENCE_TS)
    const addresses = new Set(
      catalog.map((entry) => instrumentMintKeypair(entry).publicKey.toBase58()),
    )

    expect(addresses.size).toBe(catalog.length)
  })
})

// Публічний devnet-RPC ріже прогін каталогу на середині. Відрізнити
// його «зачекай» від справжньої відмови програми — умова того, що повторна
// спроба має сенс.
describe('isRateLimited', () => {
  it('впізнає 429 від RPC', () => {
    expect(isRateLimited(new Error('429 :  {"jsonrpc":"2.0","error":{"code": 429}}'))).toBe(true)
  })

  it('не приймає за ліміт відмову програми', () => {
    expect(isRateLimited(new Error('custom program error: 0x1771'))).toBe(false)
  })

  it('витримує те, що кинули не Error', () => {
    expect(isRateLimited('429')).toBe(false)
  })
})
