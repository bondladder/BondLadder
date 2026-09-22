import { instrumentSchema, ratingRecordSchema, SCALE_VERSION } from '@bondladder/shared'
import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import {
  type CatalogAddress,
  type CatalogRow,
  catalogAddresses,
  custodyAddress,
  DEPOSIT_MICRO,
  type DevnetCandidate,
  explorerUrl,
  type RecordedRung,
  reconcile,
  rungAccountMetas,
  toCandidates,
} from './demo-deposit'
import { instrumentMintKeypair, VAULT_PARAMS } from './deploy'
import { buildCatalog } from './seed-catalog'

const ISSUER_PROGRAM = new PublicKey('EX1tNj2MLTacJPfAVzbBW8ejFsnSp7AsnZvnRLmDy3vK')
const ORACLE_PROGRAM = new PublicKey('EWhJjvNVb5mh1Jb9DTzvTwk7BeS9qdZdK7a6vdneQPa9')
const VAULT = new PublicKey('HftEWpSw9jNCrBiX9CKD8GG1AFTVBSvDgbu1FbNTK4tz')

const NOW_TS = 1_800_000_000n
const MAX_AGE_SECS = 2_592_000n

function addressOf(issuerId: string, rungMonths: number): CatalogAddress {
  const found = catalogAddresses(ISSUER_PROGRAM, ORACLE_PROGRAM).find(
    (address) => address.issuerId === issuerId && address.rungMonths === rungMonths,
  )
  if (found === undefined) {
    throw new Error(`у каталозі немає ${issuerId}/${rungMonths}`)
  }

  return found
}

function row(overrides: Partial<CatalogRow> = {}): CatalogRow {
  const address = overrides.address ?? addressOf('HELVETIA-RE', 3)

  return {
    address,
    instrument: instrumentSchema.parse({
      mint: address.mint.toBase58(),
      issuerId: address.issuerId,
      maturityTs: NOW_TS + 7_862_400n,
      couponBps: 320,
      priceMicro: 970_000n,
      bump: 254,
    }),
    rating: ratingRecordSchema.parse({
      instrumentMint: address.mint.toBase58(),
      notch: 1,
      scaleVersion: SCALE_VERSION,
      agencyCode: 'MOODYS',
      updatedAt: NOW_TS - 60n,
      bump: 253,
    }),
    ...overrides,
  }
}

describe('catalogAddresses', () => {
  it('дає по адресі на кожен запис каталогу', () => {
    expect(catalogAddresses(ISSUER_PROGRAM, ORACLE_PROGRAM)).toHaveLength(
      buildCatalog(NOW_TS).length,
    )
  })

  it('бере той самий мінт, що й реєстрація каталогу', () => {
    const address = addressOf('CALDERA-WATER', 12)

    expect(address.mint.toBase58()).toBe(
      instrumentMintKeypair({ issuerId: 'CALDERA-WATER', rungMonths: 12 }).publicKey.toBase58(),
    )
  })

  it('виводить PDA інструмента і рейтингу з мінта', () => {
    const address = addressOf('VERDANT-AGRI', 18)

    expect(address.instrument).toEqual(
      PublicKey.findProgramAddressSync(
        [Buffer.from('instrument'), address.mint.toBytes()],
        ISSUER_PROGRAM,
      )[0],
    )
    expect(address.rating).toEqual(
      PublicKey.findProgramAddressSync(
        [Buffer.from('rating'), address.mint.toBytes()],
        ORACLE_PROGRAM,
      )[0],
    )
  })
})

describe('toCandidates', () => {
  it('зводить інструмент і рейтинг в кандидата підбору', () => {
    const source = row()

    expect(toCandidates([source], NOW_TS, MAX_AGE_SECS)).toEqual([
      {
        issuerId: 'HELVETIA-RE',
        maturityTs: NOW_TS + 7_862_400n,
        notch: 1,
        priceMicro: 970_000n,
        address: source.address,
      },
    ])
  })

  // Дзеркало RatingRecord::is_fresh: вік рівно у межі ще придатний.
  it('лишає рейтинг рівно на межі віку', () => {
    const source = row({
      rating: ratingRecordSchema.parse({
        instrumentMint: addressOf('HELVETIA-RE', 3).mint.toBase58(),
        notch: 1,
        scaleVersion: SCALE_VERSION,
        agencyCode: 'MOODYS',
        updatedAt: NOW_TS - MAX_AGE_SECS,
        bump: 253,
      }),
    })

    expect(toCandidates([source], NOW_TS, MAX_AGE_SECS)).toHaveLength(1)
  })

  it('відкидає рейтинг, старший за межу віку', () => {
    const source = row({
      rating: ratingRecordSchema.parse({
        instrumentMint: addressOf('HELVETIA-RE', 3).mint.toBase58(),
        notch: 1,
        scaleVersion: SCALE_VERSION,
        agencyCode: 'MOODYS',
        updatedAt: NOW_TS - MAX_AGE_SECS - 1n,
        bump: 253,
      }),
    })

    expect(toCandidates([source], NOW_TS, MAX_AGE_SECS)).toEqual([])
  })

  it('відкидає запис із чужої версії шкали', () => {
    const source = row({
      rating: ratingRecordSchema.parse({
        instrumentMint: addressOf('HELVETIA-RE', 3).mint.toBase58(),
        notch: 1,
        scaleVersion: SCALE_VERSION + 1,
        agencyCode: 'MOODYS',
        updatedAt: NOW_TS,
        bump: 253,
      }),
    })

    expect(toCandidates([source], NOW_TS, MAX_AGE_SECS)).toEqual([])
  })

  // Програма звіряє record.instrument_mint з instrument.mint і відмовляє;
  // клієнт не має платити за таку транзакцію.
  it('відкидає рейтинг, виданий іншому мінту', () => {
    const source = row({
      rating: ratingRecordSchema.parse({
        instrumentMint: addressOf('KESTREL-RAIL', 9).mint.toBase58(),
        notch: 1,
        scaleVersion: SCALE_VERSION,
        agencyCode: 'MOODYS',
        updatedAt: NOW_TS,
        bump: 253,
      }),
    })

    expect(toCandidates([source], NOW_TS, MAX_AGE_SECS)).toEqual([])
  })

  it('пропускає те, чого на ланцюзі немає', () => {
    expect(
      toCandidates([row({ instrument: null }), row({ rating: null })], NOW_TS, MAX_AGE_SECS),
    ).toEqual([])
  })
})

describe('rungAccountMetas', () => {
  const candidate: DevnetCandidate = {
    issuerId: 'ATLAS-MARITIME',
    maturityTs: NOW_TS,
    notch: 5,
    priceMicro: 940_000n,
    address: addressOf('ATLAS-MARITIME', 6),
  }

  it('віддає четвірку в порядку, який читає програма', () => {
    expect(rungAccountMetas(candidate, VAULT).map((meta) => meta.pubkey.toBase58())).toEqual([
      candidate.address.instrument.toBase58(),
      candidate.address.rating.toBase58(),
      candidate.address.mint.toBase58(),
      custodyAddress(candidate.address.mint, VAULT).toBase58(),
    ])
  })

  // Мінт і кастодія міняються під час обміну, інструмент і рейтинг — ні.
  it('відкриває на запис лише мінт і кастодію', () => {
    expect(rungAccountMetas(candidate, VAULT).map((meta) => meta.isWritable)).toEqual([
      false,
      false,
      true,
      true,
    ])
    expect(rungAccountMetas(candidate, VAULT).every((meta) => !meta.isSigner)).toBe(true)
  })
})

describe('reconcile', () => {
  const candidate: DevnetCandidate = {
    issuerId: 'NORDLYS-ENERGI',
    maturityTs: NOW_TS + 15_811_200n,
    notch: 3,
    priceMicro: 950_000n,
    address: addressOf('NORDLYS-ENERGI', 6),
  }
  const allocation = { rungMonths: 6, amountMicro: 200_000_000n, candidate }

  function recorded(overrides: Partial<RecordedRung> = {}): RecordedRung {
    return {
      targetMonths: 6,
      instrument: candidate.address.mint.toBase58(),
      entryNotch: 3,
      maturityTs: candidate.maturityTs,
      amount: 210n,
      ...overrides,
    }
  }

  it('мовчить, коли записане збігається з показаним', () => {
    expect(reconcile([allocation], [recorded()])).toEqual([])
  })

  it('називає щабель, на якому програма записала інший інструмент', () => {
    const stranger = addressOf('KESTREL-RAIL', 6).mint.toBase58()

    expect(reconcile([allocation], [recorded({ instrument: stranger })])).toEqual([
      expect.stringContaining('6'),
    ])
  })

  it('називає щабель, який лишився без жодної одиниці', () => {
    expect(reconcile([allocation], [recorded({ amount: 0n })])).toHaveLength(1)
  })

  it('вважає розбіжністю саму різницю в кількості щаблів', () => {
    expect(reconcile([allocation], [])).toHaveLength(1)
  })
})

describe('explorerUrl', () => {
  it('веде на транзакцію в тому самому кластері', () => {
    expect(explorerUrl('5xy', 'devnet')).toBe('https://explorer.solana.com/tx/5xy?cluster=devnet')
  })
})

describe('DEPOSIT_MICRO', () => {
  // Демо вносить рівно мінімум vault: менший депозит програма відхилить, а
  // більший нічого не додає до доказу.
  it('дорівнює мінімальному вкладу vault', () => {
    expect(DEPOSIT_MICRO).toBe(VAULT_PARAMS.minDeposit)
  })
})
