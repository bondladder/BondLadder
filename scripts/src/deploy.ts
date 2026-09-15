// Початкова ініціалізація трьох програм на devnet: демо-USDC, конфіги оракула
// й емітента, vault і весь демо-каталог із seed-catalog.ts.
//
// Сам деплой байткоду — крок CLI, який робиться до цього скрипта (у WSL):
//   anchor deploy --provider.cluster devnet \
//     --provider.wallet ~/.config/solana/bondladder-devnet-deployer.json
//
// Скрипт ідемпотентний: каталог — це 45 транзакцій поспіль, і обрив посеред
// прогону на публічному RPC — норма, а не виняток. Повторний запуск пропускає
// вже створене і дописує решту.
//
// Типи програм беруться з `target/types/*`, які пише `anchor build`, — на
// чистому клоні спершу збірка, потім цей скрипт.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AnchorProvider, BN, Program, Wallet } from '@coral-xyz/anchor'
import { createMint } from '@solana/spl-token'
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from '@solana/web3.js'
import { notchForLabel } from '@bondladder/shared'
import type { BondLadder } from '../../target/types/bond_ladder'
import type { MockIssuer } from '../../target/types/mock_issuer'
import type { RatingOracle } from '../../target/types/rating_oracle'
import { buildCatalog, type CatalogEntry } from './seed-catalog'

export const ISSUER_ID_LEN = 16
export const AGENCY_CODE_LEN = 8
export const RATING_LABEL_LEN = 4

const USDC_DECIMALS = 6
const MICRO_PER_USDC = 1_000_000n

/// Рейтинг старший за цей строк програма не приймає (FR-025). На демо строк
/// довгий навмисно: повторний прогін скрипта — єдине, що оновлює мітки часу,
/// а між показами можуть минати тижні.
const RATING_MAX_AGE_SECS = 30 * 24 * 60 * 60

/// Пауза між записами каталогу і межі повторів. Публічний devnet тримає
/// близько десятка запитів на секунду на адресу, а один запис — це дві
/// транзакції, кожна з підтвердженням.
const RPC_PACE_MS = 400
const RPC_POLL_MS = 700
const RPC_BACKOFF_MS = 1_000
const RPC_MAX_ATTEMPTS = 6

export const VAULT_PARAMS = {
  feeBps: 50,
  spreadCoefBps: 200,
  crankRewardBps: 10,
  /// Неподільна решта депозиту обмежена ціною однієї одиниці на щабель
  /// (FR-032) — на демо-каталозі це ≈2.46 USDC. На тисячі це 0.25%, на сотні
  /// було б 2.5%, тому мінімум стоїть на тисячі.
  minDeposit: 1_000n * MICRO_PER_USDC,
  capacityUsdc: 1_000_000n * MICRO_PER_USDC,
} as const

export class DeployError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeployError'
  }
}

export function encodeFixedAscii(value: string, length: number, field: string): Uint8Array {
  if (!/^[\x20-\x7e]*$/.test(value)) {
    throw new DeployError(`${field}: «${value}» містить не-ASCII, а поле передається байтами`)
  }
  if (value.length > length) {
    throw new DeployError(`${field}: «${value}» довше за ${length} байтів`)
  }

  const buffer = new Uint8Array(length)
  buffer.set(Uint8Array.from(value, (character) => character.charCodeAt(0)))

  return buffer
}

export interface RegisterArgs {
  readonly issuerId: Uint8Array
  readonly maturityTs: bigint
  readonly couponBps: number
  readonly priceMicro: bigint
}

export function toRegisterArgs(entry: CatalogEntry): RegisterArgs {
  return {
    issuerId: encodeFixedAscii(entry.issuerId, ISSUER_ID_LEN, 'issuerId'),
    maturityTs: entry.maturityTs,
    couponBps: entry.couponBps,
    priceMicro: entry.priceMicro,
  }
}

export interface RatingArgs {
  readonly label: Uint8Array
  readonly agencyCode: Uint8Array
}

/// Мітка йде на ланцюг як мітка: notch рахує програма (FR-003). Тут вона
/// перевіряється лише щоб не платити за транзакцію, яку оракул відхилить.
export function toRatingArgs(entry: Pick<CatalogEntry, 'ratingLabel' | 'agencyCode'>): RatingArgs {
  if (notchForLabel(entry.ratingLabel) === null) {
    throw new DeployError(`ratingLabel: «${entry.ratingLabel}» немає у шкалі`)
  }

  return {
    label: encodeFixedAscii(entry.ratingLabel, RATING_LABEL_LEN, 'ratingLabel'),
    agencyCode: encodeFixedAscii(entry.agencyCode, AGENCY_CODE_LEN, 'agencyCode'),
  }
}

/// Адреса мінта виводиться з емітента і щабля, а не генерується випадково:
/// інакше повторний прогін після обриву поклав би поруч другий каталог.
/// Дата погашення в сід не входить — вона залежить від часу прогону.
export function instrumentMintKeypair(
  entry: Pick<CatalogEntry, 'issuerId' | 'rungMonths'>,
): Keypair {
  const seed = createHash('sha256')
    .update(`bondladder:instrument:${entry.issuerId}:${entry.rungMonths}`)
    .digest()

  return Keypair.fromSeed(seed.subarray(0, 32))
}

function loadKeypair(path: string): Keypair {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(parsed) || parsed.some((byte) => typeof byte !== 'number')) {
    throw new DeployError(`${path}: не схоже на файл ключа Solana`)
  }

  return Keypair.fromSecretKey(Uint8Array.from(parsed))
}

function readIdl<T>(name: string): T {
  const path = join(import.meta.dirname, '../../target/idl', `${name}.json`)

  return JSON.parse(readFileSync(path, 'utf8')) as T
}

/// Публічний devnet-RPC ріже темп задовго до кінця каталогу. Його «зачекай»
/// треба відрізняти від відмови програми: повторювати варто лише перше, бо
/// друге повториться так само.
export function isRateLimited(error: unknown): boolean {
  return error instanceof Error && error.message.includes('429')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withRetry<T>(what: string, action: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await action()
    } catch (error) {
      if (attempt >= RPC_MAX_ATTEMPTS || !isRateLimited(error)) {
        throw error
      }

      const backoffMs = RPC_BACKOFF_MS * 2 ** (attempt - 1)
      console.log(`${what}: RPC тримає темп, повтор через ${backoffMs} мс`)
      await sleep(backoffMs)
    }
  }
}

async function accountExists(connection: Connection, address: PublicKey): Promise<boolean> {
  return (await withRetry('читання акаунта', () => connection.getAccountInfo(address))) !== null
}

/// `.rpc()` анкора чекає підтвердження через WebSocket-підписку, а публічний
/// devnet ріже і її — причому помилка приходить подією сокета, повз промис, і
/// вбиває процес мимо будь-якого catch. Тому підтвердження опитується по HTTP:
/// повільніше, зате в межах того самого withRetry, що й решта викликів.
async function confirm(connection: Connection, signature: string, until: number): Promise<void> {
  for (;;) {
    const { value } = await withRetry('статус транзакції', () =>
      connection.getSignatureStatuses([signature]),
    )
    const status = value[0]

    if (status?.err != null) {
      throw new DeployError(`${signature}: ${JSON.stringify(status.err)}`)
    }
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      return
    }

    const height = await withRetry('висота блоку', () => connection.getBlockHeight('confirmed'))
    if (height > until) {
      throw new DeployError(`${signature}: блокхеш протух до підтвердження`)
    }

    await sleep(RPC_POLL_MS)
  }
}

async function sendAndConfirm(
  connection: Connection,
  what: string,
  instructions: readonly TransactionInstruction[],
  payer: Keypair,
  extraSigners: readonly Keypair[],
): Promise<void> {
  await withRetry(what, async () => {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
    const transaction = new Transaction({
      feePayer: payer.publicKey,
      blockhash,
      lastValidBlockHeight,
    }).add(...instructions)
    transaction.sign(payer, ...extraSigners)

    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      preflightCommitment: 'confirmed',
    })
    await confirm(connection, signature, lastValidBlockHeight)
  })
}

function pda(seeds: readonly Uint8Array[], programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([...seeds], programId)[0]
}

const SEED_VAULT = Buffer.from('vault')
const SEED_ORACLE = Buffer.from('oracle')
const SEED_ISSUER = Buffer.from('issuer')
const SEED_INSTRUMENT = Buffer.from('instrument')

export async function main(): Promise<void> {
  const rpcUrl = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com'
  const keypairPath =
    process.env.DEPLOYER_KEYPAIR_PATH ??
    join(homedir(), '.config', 'solana', 'bondladder-devnet-deployer.json')

  const deployer = loadKeypair(keypairPath)
  const connection = new Connection(rpcUrl, 'confirmed')
  const provider = new AnchorProvider(connection, new Wallet(deployer), {
    commitment: 'confirmed',
  })

  const oracle = new Program<RatingOracle>(readIdl<RatingOracle>('rating_oracle'), provider)
  const issuer = new Program<MockIssuer>(readIdl<MockIssuer>('mock_issuer'), provider)
  const ladder = new Program<BondLadder>(readIdl<BondLadder>('bond_ladder'), provider)

  console.log(`RPC        ${rpcUrl}`)
  console.log(`деплоєр    ${deployer.publicKey.toBase58()}`)
  console.log(`баланс     ${(await connection.getBalance(deployer.publicKey)) / 1e9} SOL`)

  const oracleConfig = pda([SEED_ORACLE], oracle.programId)
  const issuerConfig = pda([SEED_ISSUER], issuer.programId)
  const vault = pda([SEED_VAULT], ladder.programId)

  // Мінт демо-USDC створюється один раз і далі береться з конфігу емітента:
  // новий мінт на повторному прогоні лишив би vault прив'язаним до старого.
  let usdcMint: PublicKey
  if (await accountExists(connection, issuerConfig)) {
    usdcMint = (await issuer.account.issuerConfig.fetch(issuerConfig)).usdcMint
    console.log(`USDC       ${usdcMint.toBase58()} (з наявного конфігу емітента)`)
  } else {
    usdcMint = await createMint(
      connection,
      deployer,
      deployer.publicKey,
      null,
      USDC_DECIMALS,
      undefined,
      { commitment: 'confirmed' },
    )
    console.log(`USDC       ${usdcMint.toBase58()} (створено)`)

    await sendAndConfirm(
      connection,
      'ініціалізація емітента',
      [await issuer.methods.initialize().accounts({ usdcMint }).instruction()],
      deployer,
      [],
    )
    console.log('емітент    ініціалізовано')
  }

  if (await accountExists(connection, oracleConfig)) {
    console.log('оракул     уже ініціалізований')
  } else {
    await sendAndConfirm(
      connection,
      'ініціалізація оракула',
      [await oracle.methods.initialize(new BN(RATING_MAX_AGE_SECS)).instruction()],
      deployer,
      [],
    )
    console.log(`оракул     ініціалізовано, max_age = ${RATING_MAX_AGE_SECS} с`)
  }

  if (await accountExists(connection, vault)) {
    console.log('vault      уже ініціалізований')
  } else {
    await ladder.methods
      .initializeVault({
        feeBps: VAULT_PARAMS.feeBps,
        spreadCoefBps: VAULT_PARAMS.spreadCoefBps,
        crankRewardBps: VAULT_PARAMS.crankRewardBps,
        minDeposit: new BN(VAULT_PARAMS.minDeposit.toString()),
        capacityUsdc: new BN(VAULT_PARAMS.capacityUsdc.toString()),
      })
      .accounts({
        usdcMint,
        ratingOracle: oracle.programId,
        issuerProgram: issuer.programId,
      })
      .instruction()
      .then((instruction) =>
        sendAndConfirm(connection, 'ініціалізація vault', [instruction], deployer, []),
      )
    console.log('vault      ініціалізовано')
  }

  const catalog = buildCatalog(BigInt(Math.floor(Date.now() / 1000)))
  let registered = 0
  let skipped = 0

  for (const entry of catalog) {
    const mint = instrumentMintKeypair(entry)
    const instrument = pda([SEED_INSTRUMENT, mint.publicKey.toBytes()], issuer.programId)
    const args = toRegisterArgs(entry)

    const rating = toRatingArgs(entry)
    const instructions: TransactionInstruction[] = []
    const signers: Keypair[] = []

    if (await accountExists(connection, instrument)) {
      skipped += 1
    } else {
      instructions.push(
        await issuer.methods
          .registerInstrument(
            Array.from(args.issuerId),
            new BN(args.maturityTs.toString()),
            args.couponBps,
            new BN(args.priceMicro.toString()),
          )
          .accounts({ mint: mint.publicKey })
          .instruction(),
      )
      signers.push(mint)
      registered += 1
    }

    // Рейтинг публікується щоразу: `publish_rating` — init_if_needed, і саме
    // повторна публікація повертає запису свіжість, якої вимагає FR-025.
    // Разом із реєстрацією однією транзакцією: інструмента без рейтингу не
    // буває навіть тоді, коли прогін обірвався посередині.
    instructions.push(
      await oracle.methods
        .publishRating(Array.from(rating.label), Array.from(rating.agencyCode))
        .accounts({ instrumentMint: mint.publicKey })
        .instruction(),
    )

    await sendAndConfirm(
      connection,
      `${entry.issuerId}/${entry.rungMonths}`,
      instructions,
      deployer,
      signers,
    )
    await sleep(RPC_PACE_MS)
  }

  console.log(
    `каталог    ${registered} зареєстровано, ${skipped} уже було, рейтингів ${catalog.length}`,
  )
  console.log(`vault PDA  ${vault.toBase58()}`)
  console.log(`баланс     ${(await connection.getBalance(deployer.publicKey)) / 1e9} SOL`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
