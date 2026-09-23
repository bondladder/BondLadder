// Заміри SC-001, SC-002 і SC-008 на devnet (T030) — остання задача M2.
//
// Міряється **підлога під екраном**, а не екран: скільки часу з трьох чисел
// з'їдає мережа. Сам критерій каже про видиме («видимої розкладки», «перший
// екран»), і повне число знімається у браузері на живому сайті — тут лишається
// те, що браузер не може прискорити, і те, з чим порівнюють, коли вимір
// промахнувся: якщо підлога вже за бюджетом, винен не рендер.
//
// Шлях відтворюється той самий, яким ходить веб (`apps/web/src/lib/chain.ts`):
// каталог — скануванням програм за дискримінатором, позиція — деривацією PDA.
// Читати іншим шляхом означало б виміряти не те, що показує сайт.
//
// Ендпоінт за замовчуванням — публічний devnet, бо саме на нього ходить
// зібраний сайт: `VITE_SOLANA_RPC_URL` у секретах репозиторію не заданий.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  decodeInstrument,
  decodeOracleConfig,
  decodePosition,
  decodeRatingRecord,
  decodeVault,
  encodeBase58,
  INSTRUMENT_ACCOUNT,
  isRatingUsable,
  profileSeedByte,
  proposeLadder,
  RATING_RECORD_ACCOUNT,
  type RiskProfile,
  SEED_INSTRUMENT,
  SEED_ISSUER,
  SEED_ORACLE,
  SEED_POSITION,
  SEED_RATING,
  SEED_VAULT,
} from '@bondladder/shared'
import { AnchorProvider, BN, Program, Wallet } from '@coral-xyz/anchor'
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from '@solana/web3.js'
import type { BondLadder } from '../../target/types/bond_ladder'
import { custodyAddress, DEPOSIT_MICRO, explorerUrl } from './demo-deposit'
import { DeployError, loadKeypair, pda, readIdl, sendAndConfirm, withRetry } from './deploy'

export class MeasureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MeasureError'
  }
}

export interface Summary {
  readonly minMs: number
  readonly medianMs: number
  readonly maxMs: number
  readonly count: number
  readonly withinBudget: boolean
}

/// Вердикт ставиться за найгіршим зразком, а не за медіаною: бюджет обіцяний
/// відвідувачу, а не в середньому по відвідувачах, і один прогін за межею —
/// це прогін, який хтось побачив.
export function summarise(samples: readonly number[], budgetMs: number): Summary {
  if (samples.length === 0) {
    throw new MeasureError('нема чого підсумовувати: жодного зразка')
  }

  const sorted = [...samples].sort((left, right) => left - right)
  const middle = sorted.length >> 1
  const low = sorted[middle - 1] ?? 0
  const high = sorted[middle] ?? 0

  return {
    minMs: sorted[0] ?? 0,
    medianMs: sorted.length % 2 === 1 ? high : (low + high) / 2,
    maxMs: sorted[sorted.length - 1] ?? 0,
    count: sorted.length,
    withinBudget: (sorted[sorted.length - 1] ?? 0) <= budgetMs,
  }
}

export function report(criterion: string, budgetMs: number, summary: Summary): string {
  const verdict = summary.withinBudget ? '✅ проходить' : '❌ не проходить'

  return (
    `${criterion}  найгірший ${summary.maxMs} мс (< ${budgetMs})  ` +
    `медіана ${summary.medianMs}  найкращий ${summary.minMs}  ` +
    `прогонів ${summary.count}  ${verdict}`
  )
}

async function timed<T>(work: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const started = performance.now()
  const value = await work()

  return { ms: Math.round(performance.now() - started), value }
}

function scanFilters(layout: { discriminator: readonly number[]; size: number }) {
  return [
    { dataSize: layout.size },
    { memcmp: { offset: 0, bytes: encodeBase58(Uint8Array.from(layout.discriminator)) } },
  ]
}

/// Те саме, що робить `loadCatalogue` у вебі: vault, конфіг оракула, тоді два
/// сканування програм — і підбір розкладки на тому, що прийшло.
async function catalogueFloor(connection: Connection, ladderProgram: PublicKey): Promise<number> {
  const { ms } = await timed(async () => {
    const vaultInfo = await connection.getAccountInfo(pda([SEED_VAULT], ladderProgram))
    if (vaultInfo === null) {
      throw new MeasureError('vault не існує — спершу deploy:devnet')
    }
    const vault = decodeVault(vaultInfo.data)
    const ratingOracle = new PublicKey(vault.ratingOracle)
    const issuerProgram = new PublicKey(vault.issuerProgram)

    const oracleInfo = await connection.getAccountInfo(pda([SEED_ORACLE], ratingOracle))
    if (oracleInfo === null) {
      throw new MeasureError('оракул не ініціалізований')
    }
    const { maxAgeSecs } = decodeOracleConfig(oracleInfo.data)

    const [rawInstruments, rawRatings] = await Promise.all([
      connection.getProgramAccounts(issuerProgram, { filters: scanFilters(INSTRUMENT_ACCOUNT) }),
      connection.getProgramAccounts(ratingOracle, { filters: scanFilters(RATING_RECORD_ACCOUNT) }),
    ])

    const nowTs = BigInt(Math.floor(Date.now() / 1000))
    const ratings = new Map(
      rawRatings.map(({ account }) => {
        const record = decodeRatingRecord(account.data)
        return [record.instrumentMint, record]
      }),
    )

    const candidates = rawInstruments.flatMap(({ account }) => {
      const instrument = decodeInstrument(account.data)
      const rating = ratings.get(instrument.mint)
      if (rating === undefined || !isRatingUsable(rating, nowTs, maxAgeSecs)) {
        return []
      }
      if (instrument.maturityTs <= nowTs || instrument.priceMicro === 0n) {
        return []
      }

      return [
        { issuerId: instrument.issuerId, maturityTs: instrument.maturityTs, notch: rating.notch },
      ]
    })

    const proposal = proposeLadder({
      profile: 'conservative',
      depositMicro: DEPOSIT_MICRO,
      nowTs,
      candidates,
    })
    if (!proposal.ok) {
      throw new MeasureError(`підбір розкладки відмовив: ${proposal.reason}`)
    }

    return proposal.allocations.length
  })

  return ms
}

const PROFILES: readonly RiskProfile[] = ['conservative', 'balanced']

/// Те саме, що робить `readStatements` у вебі: vault і обидві позиції разом,
/// тоді конфіг оракула з інструментами й рейтингами щаблів одним запитом.
async function positionFloor(
  connection: Connection,
  ladderProgram: PublicKey,
  owner: PublicKey,
): Promise<number> {
  const { ms } = await timed(async () => {
    const [vaultInfo, ...positionInfos] = await Promise.all([
      connection.getAccountInfo(pda([SEED_VAULT], ladderProgram)),
      ...PROFILES.map((profile) =>
        connection.getAccountInfo(
          pda(
            [SEED_POSITION, owner.toBytes(), Uint8Array.of(profileSeedByte(profile))],
            ladderProgram,
          ),
        ),
      ),
    ])
    if (vaultInfo == null) {
      throw new MeasureError('vault не існує')
    }

    const positions = positionInfos.flatMap((info) =>
      info == null ? [] : [decodePosition(info.data)],
    )
    if (positions.length === 0) {
      throw new MeasureError(`у ${owner.toBase58()} немає позиції — нема чого міряти`)
    }

    const vault = decodeVault(vaultInfo.data)
    const ratingOracle = new PublicKey(vault.ratingOracle)
    const issuerProgram = new PublicKey(vault.issuerProgram)
    const mints = [
      ...new Set(positions.flatMap((position) => position.rungs.map((rung) => rung.instrument))),
    ]

    const infos = await connection.getMultipleAccountsInfo([
      pda([SEED_ORACLE], ratingOracle),
      ...mints.map((mint) => pda([SEED_INSTRUMENT, new PublicKey(mint).toBytes()], issuerProgram)),
      ...mints.map((mint) => pda([SEED_RATING, new PublicKey(mint).toBytes()], ratingOracle)),
    ])

    const oracle = infos[0]
    if (oracle == null) {
      throw new MeasureError('оракул не ініціалізований')
    }
    decodeOracleConfig(oracle.data)
    for (let index = 0; index < mints.length; index += 1) {
      const instrument = infos[1 + index]
      const rating = infos[1 + mints.length + index]
      if (instrument == null) {
        throw new MeasureError(`інструмент ${mints[index]} не прочитався`)
      }
      decodeInstrument(instrument.data)
      if (rating != null) {
        decodeRatingRecord(rating.data)
      }
    }

    return positions.length
  })

  return ms
}

const PROFILE_ARG = {
  conservative: { conservative: {} },
  balanced: { balanced: {} },
} as const

const DEMO_PROFILE: RiskProfile = 'conservative'

/// Вкладнику вистачає на оренду позиції і підпис — так само, як у демо.
const OWNER_FUNDING_LAMPORTS = 10_000_000

interface Deposit {
  readonly ms: number
  readonly signature: string
}

/// SC-002 міряється від відправлення підписаної транзакції до підтвердження:
/// це і є «підтвердження видно». Підготовка вкладника і кастодія до замірy не
/// входять — вони не частина депозиту й у вебі роблені окремо (T027).
async function measureDeposit(
  connection: Connection,
  ladder: Program<BondLadder>,
  deployer: Keypair,
): Promise<Deposit> {
  const vault = pda([SEED_VAULT], ladder.programId)
  const vaultInfo = await withRetry('читання vault', () => connection.getAccountInfo(vault))
  if (vaultInfo === null) {
    throw new MeasureError('vault не існує')
  }
  const vaultState = decodeVault(vaultInfo.data)
  const usdcMint = new PublicKey(vaultState.usdcMint)
  const issuerProgram = new PublicKey(vaultState.issuerProgram)
  const ratingOracle = new PublicKey(vaultState.ratingOracle)
  const issuerConfig = pda([SEED_ISSUER], issuerProgram)
  const oracleConfig = pda([SEED_ORACLE], ratingOracle)
  const issuerTreasury = getAssociatedTokenAddressSync(usdcMint, issuerConfig, true)

  const owner = Keypair.generate()
  const ownerUsdc = getAssociatedTokenAddressSync(usdcMint, owner.publicKey)

  const oracleInfo = await withRetry('читання оракула', () =>
    connection.getAccountInfo(oracleConfig),
  )
  if (oracleInfo === null) {
    throw new MeasureError('оракул не ініціалізований')
  }
  const { maxAgeSecs } = decodeOracleConfig(oracleInfo.data)

  const nowTs = BigInt(Math.floor(Date.now() / 1000))
  const [rawInstruments, rawRatings] = await Promise.all([
    withRetry('сканування інструментів', () =>
      connection.getProgramAccounts(issuerProgram, { filters: scanFilters(INSTRUMENT_ACCOUNT) }),
    ),
    withRetry('сканування рейтингів', () =>
      connection.getProgramAccounts(ratingOracle, { filters: scanFilters(RATING_RECORD_ACCOUNT) }),
    ),
  ])

  const ratings = new Map(
    rawRatings.map(({ account }) => {
      const record = decodeRatingRecord(account.data)
      return [record.instrumentMint, record]
    }),
  )
  const candidates = rawInstruments.flatMap(({ account }) => {
    const instrument = decodeInstrument(account.data)
    const rating = ratings.get(instrument.mint)
    if (rating === undefined || !isRatingUsable(rating, nowTs, maxAgeSecs)) {
      return []
    }
    if (instrument.maturityTs <= nowTs || instrument.priceMicro === 0n) {
      return []
    }

    return [
      {
        issuerId: instrument.issuerId,
        maturityTs: instrument.maturityTs,
        notch: rating.notch,
        mint: new PublicKey(instrument.mint),
      },
    ]
  })

  const proposal = proposeLadder({
    profile: DEMO_PROFILE,
    depositMicro: DEPOSIT_MICRO,
    nowTs,
    candidates,
  })
  if (!proposal.ok) {
    throw new MeasureError(`підбір розкладки відмовив: ${proposal.reason}`)
  }

  await sendAndConfirm(
    connection,
    'видача SOL і USDC вкладнику',
    [
      SystemProgram.transfer({
        fromPubkey: deployer.publicKey,
        toPubkey: owner.publicKey,
        lamports: OWNER_FUNDING_LAMPORTS,
      }),
      createAssociatedTokenAccountIdempotentInstruction(
        deployer.publicKey,
        ownerUsdc,
        owner.publicKey,
        usdcMint,
      ),
      createMintToInstruction(usdcMint, ownerUsdc, deployer.publicKey, DEPOSIT_MICRO),
    ],
    deployer,
    [],
  )

  await sendAndConfirm(
    connection,
    'кастодія vault',
    proposal.allocations.map(({ candidate }) =>
      createAssociatedTokenAccountIdempotentInstruction(
        deployer.publicKey,
        custodyAddress(candidate.mint, vault),
        vault,
        candidate.mint,
      ),
    ),
    deployer,
    [],
  )

  const position = pda(
    [SEED_POSITION, owner.publicKey.toBytes(), Uint8Array.of(profileSeedByte(DEMO_PROFILE))],
    ladder.programId,
  )
  const instruction: TransactionInstruction = await ladder.methods
    .openLadder(PROFILE_ARG[DEMO_PROFILE], new BN(DEPOSIT_MICRO.toString()))
    .accountsPartial({
      vault,
      position,
      owner: owner.publicKey,
      ownerUsdc,
      oracleConfig,
      issuerProgram,
      issuerConfig,
      issuerTreasury,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(
      proposal.allocations.flatMap(({ candidate }) => [
        {
          pubkey: pda([SEED_INSTRUMENT, candidate.mint.toBytes()], issuerProgram),
          isWritable: false,
          isSigner: false,
        },
        {
          pubkey: pda([SEED_RATING, candidate.mint.toBytes()], ratingOracle),
          isWritable: false,
          isSigner: false,
        },
        { pubkey: candidate.mint, isWritable: true, isSigner: false },
        { pubkey: custodyAddress(candidate.mint, vault), isWritable: true, isSigner: false },
      ]),
    )
    .instruction()

  const { blockhash, lastValidBlockHeight } = await withRetry('blockhash', () =>
    connection.getLatestBlockhash('confirmed'),
  )
  const transaction = new Transaction({
    feePayer: owner.publicKey,
    blockhash,
    lastValidBlockHeight,
  }).add(instruction)
  transaction.sign(owner)

  const { ms, value: signature } = await timed(async () => {
    const sent = await connection.sendRawTransaction(transaction.serialize(), {
      preflightCommitment: 'confirmed',
    })
    await connection.confirmTransaction(
      { signature: sent, blockhash, lastValidBlockHeight },
      'confirmed',
    )

    return sent
  })

  return { ms, signature }
}

const CATALOGUE_RUNS = 5
const POSITION_RUNS = 5
const DEPOSIT_RUNS = 3

/// Пауза між зразками. Прогони впритул — це черга запитів від одного клієнта,
/// і публічний devnet відповідає на неї 429: харнес міряв би власний сплеск,
/// а не відвідувача, який відкриває сторінку раз. Вбудований відкат web3.js
/// потім домальовує секунди, яких у реального відвідувача немає.
const PAUSE_BETWEEN_SAMPLES_MS = 5_000

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const SC_001_BUDGET_MS = 3_000
const SC_002_BUDGET_MS = 5_000
const SC_008_BUDGET_MS = 2_000

export async function main(): Promise<void> {
  const rpcUrl = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com'
  const cluster = process.env.SOLANA_CLUSTER ?? 'devnet'
  const keypairPath =
    process.env.DEPLOYER_KEYPAIR_PATH ??
    join(homedir(), '.config', 'solana', 'bondladder-devnet-deployer.json')

  const deployer = loadKeypair(keypairPath)
  const connection = new Connection(rpcUrl, 'confirmed')
  const provider = new AnchorProvider(connection, new Wallet(deployer), {
    commitment: 'confirmed',
  })
  const ladder = new Program<BondLadder>(readIdl<BondLadder>('bond_ladder'), provider)

  console.log(`RPC        ${rpcUrl}`)
  console.log(`програма   ${ladder.programId.toBase58()}`)
  console.log('міряється  підлога під екраном: мережа без браузера і без рендера\n')

  const catalogueSamples: number[] = []
  for (let run = 0; run < CATALOGUE_RUNS; run += 1) {
    if (run > 0) {
      await pause(PAUSE_BETWEEN_SAMPLES_MS)
    }
    catalogueSamples.push(await catalogueFloor(connection, ladder.programId))
  }
  const catalogue = summarise(catalogueSamples, SC_001_BUDGET_MS)
  console.log(report('SC-001 мережа', SC_001_BUDGET_MS, catalogue))

  const deposits: Deposit[] = []
  for (let run = 0; run < DEPOSIT_RUNS; run += 1) {
    if (run > 0) {
      await pause(PAUSE_BETWEEN_SAMPLES_MS)
    }
    deposits.push(await measureDeposit(connection, ladder, deployer))
  }
  const deposit = summarise(
    deposits.map((sample) => sample.ms),
    SC_002_BUDGET_MS,
  )
  console.log(report('SC-002 усього ', SC_002_BUDGET_MS, deposit))
  for (const sample of deposits) {
    console.log(`           ${sample.ms} мс  ${explorerUrl(sample.signature, cluster)}`)
  }

  const lastDeposit = deposits[deposits.length - 1]
  if (lastDeposit === undefined) {
    throw new MeasureError('жодного депозиту не відбулось')
  }
  const owner = new PublicKey(
    (
      await withRetry('читання транзакції', () =>
        connection.getTransaction(lastDeposit.signature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        }),
      )
    )?.transaction.message.staticAccountKeys[0] ?? deployer.publicKey,
  )

  const positionSamples: number[] = []
  for (let run = 0; run < POSITION_RUNS; run += 1) {
    if (run > 0) {
      await pause(PAUSE_BETWEEN_SAMPLES_MS)
    }
    positionSamples.push(await positionFloor(connection, ladder.programId, owner))
  }
  const position = summarise(positionSamples, SC_008_BUDGET_MS)
  console.log(report('SC-008 мережа', SC_008_BUDGET_MS, position))
  console.log(`           власник ${owner.toBase58()}`)

  console.log(
    '\nЦе ще не критерій: SC-001 і SC-008 обіцяні про видиме, тож повне число ' +
      'знімається у браузері на живому сайті. Тут — скільки з нього з’їдає мережа.',
  )
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((failure: unknown) => {
    console.error(
      failure instanceof DeployError || failure instanceof MeasureError ? failure.message : failure,
    )
    process.exitCode = 1
  })
}
