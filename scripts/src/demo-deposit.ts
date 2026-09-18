// Демо-депозит на devnet без інтерфейсу (FR-008) — доказ M1: 1000 USDC однією
// транзакцією перетворюються на лествицю з п'яти щаблів, і записане програмою
// звіряється з тим, що було показано до підпису.
//
// Каталог не сканується: адреси мінтів детерміновані (deploy.ts), тому
// інструменти й рейтинги читаються за виведеними адресами, а не пошуком.
//
// Гаманець вкладника — одноразовий: він створюється на прогін, отримує SOL і
// демо-USDC від деплоєра і більше ні для чого не потрібен. Так демо
// перезапускається скільки завгодно разів (позиція живе за адресою, виведеною
// з власника) і вкладник не має жодних прав у програмах.

import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AnchorProvider, BN, Program, Wallet } from '@coral-xyz/anchor'
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import {
  type AccountMeta,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
} from '@solana/web3.js'
import {
  decodeInstrument,
  decodeOracleConfig,
  decodeRatingRecord,
  type Instrument,
  type LadderAllocation,
  type LadderCandidate,
  type RatingRecord,
  type RiskProfile,
  SCALE_VERSION,
  decodeVault,
  profileSeedByte,
  proposeLadder,
  SEED_INSTRUMENT,
  SEED_ISSUER,
  SEED_ORACLE,
  SEED_POSITION,
  SEED_RATING,
  SEED_VAULT,
} from '@bondladder/shared'
import type { BondLadder } from '../../target/types/bond_ladder'
import type { RatingOracle } from '../../target/types/rating_oracle'
import {
  DeployError,
  instrumentMintKeypair,
  loadKeypair,
  MICRO_PER_USDC,
  pda,
  readIdl,
  sendAndConfirm,
  VAULT_PARAMS,
  withRetry,
} from './deploy'
import { buildCatalog } from './seed-catalog'

/// Демо вносить рівно мінімум vault: менший депозит програма відхилить, а
/// більший нічого не додає до доказу.
export const DEPOSIT_MICRO = VAULT_PARAMS.minDeposit

export const DEMO_PROFILE: RiskProfile = 'conservative'

/// Профіль підбору і профіль у транзакції — одне значення: розійшовшись, вони
/// дали б позицію під іншим порогом, і звірка щаблів цього не помітила б.
const PROFILE_ARG = {
  conservative: { conservative: {} },
  balanced: { balanced: {} },
} as const

/// Вкладнику вистачає на оренду позиції (369 байтів ≈ 0.0035 SOL) і підпис.
/// Решта лишається в одноразовому гаманці — це ціна прогону демо.
const OWNER_FUNDING_LAMPORTS = 10_000_000

export interface CatalogAddress {
  readonly issuerId: string
  readonly rungMonths: number
  readonly mint: PublicKey
  readonly instrument: PublicKey
  readonly rating: PublicKey
}

export interface CatalogRow {
  readonly address: CatalogAddress
  readonly instrument: Instrument | null
  readonly rating: RatingRecord | null
}

export interface DevnetCandidate extends LadderCandidate {
  readonly priceMicro: bigint
  readonly address: CatalogAddress
}

/// Щабель так, як його записала програма.
export interface RecordedRung {
  readonly targetMonths: number
  readonly instrument: string
  readonly entryNotch: number
  readonly maturityTs: bigint
  readonly amount: bigint
}

export function catalogAddresses(
  issuerProgram: PublicKey,
  oracleProgram: PublicKey,
): readonly CatalogAddress[] {
  // Каталог тут потрібен лише як перелік «емітент × щабель»: адреса мінта від
  // опорного часу не залежить, тому нуль замість реального моменту.
  return buildCatalog(0n).map((entry) => {
    const mint = instrumentMintKeypair(entry).publicKey

    return {
      issuerId: entry.issuerId,
      rungMonths: entry.rungMonths,
      mint,
      instrument: pda([SEED_INSTRUMENT, mint.toBytes()], issuerProgram),
      rating: pda([SEED_RATING, mint.toBytes()], oracleProgram),
    }
  })
}

export function custodyAddress(mint: PublicKey, vault: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, vault, true)
}

/// Дзеркало RatingRecord::is_usable: чужа версія шкали трактується так само,
/// як застарілий запис, а вік рівно у межі ще придатний.
function isUsable(rating: RatingRecord, nowTs: bigint, maxAgeSecs: bigint): boolean {
  return rating.scaleVersion === SCALE_VERSION && nowTs - rating.updatedAt <= maxAgeSecs
}

/// Кандидат для підбору складається з двох акаунтів, і жоден із них не
/// гарантований: каталог могло не дописати, а рейтинг — протухнути. Те, що
/// програма все одно відхилить, до пропозиції не потрапляє.
export function toCandidates(
  rows: readonly CatalogRow[],
  nowTs: bigint,
  maxAgeSecs: bigint,
): readonly DevnetCandidate[] {
  const candidates: DevnetCandidate[] = []

  for (const { address, instrument, rating } of rows) {
    if (instrument === null || rating === null) {
      continue
    }
    if (rating.instrumentMint !== instrument.mint || !isUsable(rating, nowTs, maxAgeSecs)) {
      continue
    }

    candidates.push({
      issuerId: instrument.issuerId,
      maturityTs: instrument.maturityTs,
      notch: rating.notch,
      priceMicro: instrument.priceMicro,
      address,
    })
  }

  return candidates
}

/// Порядок четвірки — той, який читає open_ladder: інструмент, рейтинг, мінт,
/// кастодія vault.
export function rungAccountMetas(candidate: DevnetCandidate, vault: PublicKey): AccountMeta[] {
  return [
    { pubkey: candidate.address.instrument, isWritable: false, isSigner: false },
    { pubkey: candidate.address.rating, isWritable: false, isSigner: false },
    { pubkey: candidate.address.mint, isWritable: true, isSigner: false },
    { pubkey: custodyAddress(candidate.address.mint, vault), isWritable: true, isSigner: false },
  ]
}

/// Пропозиція нічого не доводить, доки записане програмою з нею не збіглося:
/// саме це звірення і є доказом M1, а не факт успішної транзакції.
export function reconcile(
  allocations: readonly LadderAllocation<DevnetCandidate>[],
  recorded: readonly RecordedRung[],
): readonly string[] {
  if (allocations.length !== recorded.length) {
    return [`щаблів у позиції ${recorded.length}, а в пропозиції ${allocations.length}`]
  }

  const mismatches: string[] = []

  for (const [index, allocation] of allocations.entries()) {
    const rung = recorded[index]
    if (rung === undefined) {
      continue
    }

    const { candidate, rungMonths } = allocation
    const differences: string[] = []

    if (rung.targetMonths !== rungMonths) {
      differences.push(`щабель ${rung.targetMonths} замість ${rungMonths}`)
    }
    if (rung.instrument !== candidate.address.mint.toBase58()) {
      differences.push(`інструмент ${rung.instrument}`)
    }
    if (rung.entryNotch !== candidate.notch) {
      differences.push(`рейтинг ${rung.entryNotch} замість ${candidate.notch}`)
    }
    if (rung.maturityTs !== candidate.maturityTs) {
      differences.push(`погашення ${rung.maturityTs} замість ${candidate.maturityTs}`)
    }
    if (rung.amount === 0n) {
      differences.push('жодної одиниці')
    }

    if (differences.length > 0) {
      differences.unshift(`${rungMonths} міс`)
      mismatches.push(differences.join(': '))
    }
  }

  return mismatches
}

export function explorerUrl(signature: string, cluster: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=${cluster}`
}

function usdc(micro: bigint): string {
  const whole = micro / MICRO_PER_USDC
  const fraction = (micro % MICRO_PER_USDC).toString().padStart(6, '0')

  return `${whole}.${fraction}`
}

async function readRows(
  connection: Connection,
  addresses: readonly CatalogAddress[],
): Promise<readonly CatalogRow[]> {
  const instruments = await withRetry('читання каталогу', () =>
    connection.getMultipleAccountsInfo(addresses.map((address) => address.instrument)),
  )
  const ratings = await withRetry('читання рейтингів', () =>
    connection.getMultipleAccountsInfo(addresses.map((address) => address.rating)),
  )

  return addresses.map((address, index) => {
    const instrument = instruments[index]
    const rating = ratings[index]

    return {
      address,
      instrument: instrument == null ? null : decodeInstrument(instrument.data),
      rating: rating == null ? null : decodeRatingRecord(rating.data),
    }
  })
}

export async function main(): Promise<void> {
  const rpcUrl = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com'
  const cluster = process.env.SOLANA_CLUSTER ?? 'devnet'
  const keypairPath =
    process.env.DEPLOYER_KEYPAIR_PATH ??
    join(homedir(), '.config', 'solana', 'bondladder-devnet-deployer.json')

  const deployer = loadKeypair(keypairPath)
  const owner = Keypair.generate()
  const connection = new Connection(rpcUrl, 'confirmed')
  const provider = new AnchorProvider(connection, new Wallet(deployer), {
    commitment: 'confirmed',
  })

  const ladder = new Program<BondLadder>(readIdl<BondLadder>('bond_ladder'), provider)
  const oracle = new Program<RatingOracle>(readIdl<RatingOracle>('rating_oracle'), provider)

  const vault = pda([SEED_VAULT], ladder.programId)
  const oracleConfig = pda([SEED_ORACLE], oracle.programId)

  const [vaultInfo, oracleInfo] = await withRetry('читання vault', () =>
    connection.getMultipleAccountsInfo([vault, oracleConfig]),
  )
  if (vaultInfo == null || oracleInfo == null) {
    throw new DeployError(`${rpcUrl}: vault або оракул не ініціалізовані — спершу deploy:devnet`)
  }

  const vaultState = decodeVault(vaultInfo.data)
  const maxAgeSecs = decodeOracleConfig(oracleInfo.data).maxAgeSecs

  if (vaultState.paused) {
    throw new DeployError('vault на паузі — депозити зупинені (FR-023)')
  }
  if (DEPOSIT_MICRO < vaultState.minDeposit) {
    throw new DeployError(
      `депозит ${usdc(DEPOSIT_MICRO)} USDC нижчий за мінімум vault ${usdc(vaultState.minDeposit)}`,
    )
  }

  const usdcMint = new PublicKey(vaultState.usdcMint)
  const issuerProgram = new PublicKey(vaultState.issuerProgram)
  const ratingOracle = new PublicKey(vaultState.ratingOracle)
  const issuerConfig = pda([SEED_ISSUER], issuerProgram)

  console.log(`RPC        ${rpcUrl}`)
  console.log(`vault      ${vault.toBase58()}`)
  console.log(`вкладник   ${owner.publicKey.toBase58()} (одноразовий)`)
  console.log(`депозит    ${usdc(DEPOSIT_MICRO)} USDC, профіль ${DEMO_PROFILE}`)

  const nowTs = BigInt(Math.floor(Date.now() / 1000))
  const rows = await readRows(connection, catalogAddresses(issuerProgram, ratingOracle))
  const candidates = toCandidates(rows, nowTs, maxAgeSecs)
  console.log(`каталог    ${candidates.length} придатних інструментів із ${rows.length}`)

  const proposal = proposeLadder({
    profile: DEMO_PROFILE,
    depositMicro: DEPOSIT_MICRO,
    nowTs,
    candidates,
  })
  if (!proposal.ok) {
    throw new DeployError(`підбір розкладки відмовив: ${proposal.reason}`)
  }

  console.log('\nрозкладка до підпису:')
  for (const { rungMonths, amountMicro, candidate } of proposal.allocations) {
    const units = amountMicro / candidate.priceMicro
    console.log(
      `  ${String(rungMonths).padStart(2)} міс  ${candidate.issuerId.padEnd(16)} ` +
        `notch ${String(candidate.notch).padStart(2)}  ${usdc(amountMicro)} USDC  ` +
        `≈ ${units} од. по ${usdc(candidate.priceMicro)}`,
    )
  }

  const ownerUsdc = getAssociatedTokenAddressSync(usdcMint, owner.publicKey)
  const issuerTreasury = getAssociatedTokenAddressSync(usdcMint, issuerConfig, true)

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
        issuerTreasury,
        issuerConfig,
        usdcMint,
      ),
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
  console.log(
    `\nвкладник   отримав ${usdc(DEPOSIT_MICRO)} USDC і ${OWNER_FUNDING_LAMPORTS} лампортів`,
  )

  await sendAndConfirm(
    connection,
    'кастодія vault',
    proposal.allocations.map(({ candidate }) =>
      createAssociatedTokenAccountIdempotentInstruction(
        deployer.publicKey,
        custodyAddress(candidate.address.mint, vault),
        vault,
        candidate.address.mint,
      ),
    ),
    deployer,
    [],
  )
  console.log("кастодія   п'ять рахунків vault готові")

  const position = pda(
    [SEED_POSITION, owner.publicKey.toBytes(), Uint8Array.of(profileSeedByte(DEMO_PROFILE))],
    ladder.programId,
  )
  const remainingAccounts = proposal.allocations.flatMap(({ candidate }) =>
    rungAccountMetas(candidate, vault),
  )

  const deposit: TransactionInstruction = await ladder.methods
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
    .remainingAccounts(remainingAccounts)
    .instruction()

  const signature = await sendAndConfirm(connection, 'депозит', [deposit], owner, [])

  console.log(`\nдепозит    однією транзакцією ${signature}`)
  console.log(`explorer   ${explorerUrl(signature, cluster)}`)

  // TS-декодера Position ще немає навмисно: він потрібен вебу (T026/T028), і
  // писати його тут означало б зробити його двічі.
  const recordedPosition = await withRetry('читання позиції', () =>
    ladder.account.position.fetch(position),
  )
  const recorded: readonly RecordedRung[] = recordedPosition.rungs.map((rung) => ({
    targetMonths: rung.targetMonths,
    instrument: rung.instrument.toBase58(),
    entryNotch: rung.entryNotch,
    maturityTs: BigInt(rung.maturityTs.toString()),
    amount: BigInt(rung.amount.toString()),
  }))

  console.log(`\nпозиція    ${position.toBase58()}`)
  for (const rung of recorded) {
    console.log(
      `  ${String(rung.targetMonths).padStart(2)} міс  ${rung.instrument}  ` +
        `${rung.amount} од.  notch ${rung.entryNotch}`,
    )
  }

  const principalUsdc = BigInt(recordedPosition.principalUsdc.toString())
  console.log(
    `\nвкладено   ${usdc(principalUsdc)} USDC з ${usdc(DEPOSIT_MICRO)}; ` +
      `решта ${usdc(DEPOSIT_MICRO - principalUsdc)} лишилась вкладнику (FR-032)`,
  )

  const mismatches = reconcile(proposal.allocations, recorded)
  if (mismatches.length > 0) {
    throw new DeployError(`записане не збігається з показаним:\n  ${mismatches.join('\n  ')}`)
  }
  console.log('звірка     записане збігається з розкладкою, показаною до підпису')
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
