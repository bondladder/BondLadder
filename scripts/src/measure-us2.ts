// SC-003 and SC-006 on devnet (T038), measured over one hundred exits.
//
// The sample is 25 deposits of different sizes, each left in four steps —
// 10%, 25%, 50% and then the rest — so the exits differ both in the money
// behind them and in the share taken, and the partial path, where the whole
// fee due is charged against the slice, is measured on chain as well as the
// full one. A full exit closes the position, so one owner reopens it each
// round.
//
// The quote is built the way the exit screen builds it (`apps/web/src/lib/
// chain.ts`): live accounts, the shared `settleExit` and `accrueFee`, the
// wall clock frozen at the moment the quote is read, and the 0.1% floor
// signed with the exit. Between quote and send the run waits as long as a
// person reads, clicks and approves in a wallet, because that gap — fee
// accrual and the day count moving on — is where a quote can drift.
//
// SC-003 is timed from the signed transaction leaving to the moment the
// owner's USDC account is read back larger: confirmation polled as the screen
// polls it, then the balance the screen shows.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  accrueFee,
  BPS_DENOMINATOR,
  decodeInstrument,
  decodeOracleConfig,
  decodePosition,
  decodeRatingRecord,
  decodeVault,
  type ExitSettlement,
  exitLadderData,
  type Position,
  profileSeedByte,
  proposeLadder,
  type RiskProfile,
  SEED_BACKSTOP,
  SEED_INSTRUMENT,
  SEED_ISSUER,
  SEED_ORACLE,
  SEED_POSITION,
  SEED_RATING,
  SEED_VAULT,
  settleExit,
  type Vault,
} from '@bondladder/shared'
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
  SendTransactionError,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js'
import type { BondLadder } from '../../target/types/bond_ladder'
import {
  catalogAddresses,
  custodyAddress,
  explorerUrl,
  rungAccountMetas,
  toCandidates,
} from './demo-deposit'
import {
  DeployError,
  loadKeypair,
  MICRO_PER_USDC,
  pda,
  readIdl,
  sendAndConfirm,
  withRetry,
} from './deploy'
import { MeasureError, summarise } from './measure-us1'

export const DEPOSIT_COUNT = 25

/// The last share is the whole remainder: it closes the position, and the
/// next round can open the same PDA again.
export const EXIT_SHARES_BPS = [1_000, 2_500, 5_000, 10_000] as const

/// Not a whole number of USDC, so the per-rung floors land on odd amounts.
const DEPOSIT_STEP_MICRO = 160_370_000n

export function depositSizes(minimumMicro: bigint): readonly bigint[] {
  return Array.from(
    { length: DEPOSIT_COUNT },
    (_, index) => minimumMicro + BigInt(index) * DEPOSIT_STEP_MICRO,
  )
}

/// The exit screen's `QUOTE_TOLERANCE_BPS`: the floor signed with the exit is
/// the SC-006 budget itself.
const QUOTE_TOLERANCE_BPS = 10n

export function payoutFloor(payoutMicro: bigint): bigint {
  return (payoutMicro * (BPS_DENOMINATOR - QUOTE_TOLERANCE_BPS)) / BPS_DENOMINATOR
}

export interface ShareQuoteInput {
  readonly position: Position
  readonly prices: ReadonlyMap<string, bigint>
  readonly feeBps: number
  readonly spreadCoefBps: number
  readonly shareBps: number
  readonly nowTs: bigint
}

function sinceOrZero(nowTs: bigint, then: bigint): bigint {
  return nowTs > then ? nowTs - then : 0n
}

/// The fee due is what the program has written down plus what has accrued on
/// the whole position since — not on the slice, because the program charges
/// it all at the first operation that touches the position.
export function quoteShare(input: ShareQuoteInput): ExitSettlement {
  const rungs = input.position.rungs.map((rung) => {
    const priceMicro = input.prices.get(rung.instrument)
    if (priceMicro === undefined) {
      throw new MeasureError(`no price was read for ${rung.instrument}`)
    }

    return { units: rung.amount, priceMicro, maturityTs: rung.maturityTs }
  })
  const grossValueMicro = rungs.reduce((sum, rung) => sum + rung.units * rung.priceMicro, 0n)

  return settleExit({
    rungs,
    principalMicro: input.position.principalUsdc,
    feeDueMicro:
      input.position.feeAccrued +
      accrueFee(grossValueMicro, input.feeBps, sinceOrZero(input.nowTs, input.position.lastFeeTs)),
    shareBps: input.shareBps,
    spreadCoefBps: input.spreadCoefBps,
    nowTs: input.nowTs,
  })
}

const PPM = 1_000_000n
const SC_006_BUDGET_PPM = 1_000n

export function driftPpm(quotedMicro: bigint, receivedMicro: bigint): bigint {
  return quotedMicro === 0n ? 0n : ((receivedMicro - quotedMicro) * PPM) / quotedMicro
}

/// Compared cross-multiplied, so the boundary is not decided by a rounded ppm.
export function withinQuoteBudget(quotedMicro: bigint, receivedMicro: bigint): boolean {
  const gap =
    receivedMicro > quotedMicro ? receivedMicro - quotedMicro : quotedMicro - receivedMicro

  return gap * PPM <= quotedMicro * SC_006_BUDGET_PPM
}

export interface QuoteSample {
  readonly quotedMicro: bigint
  /// `null` when the program refused the exit with `QuoteDrift`.
  readonly receivedMicro: bigint | null
}

export interface QuoteVerdict {
  readonly count: number
  readonly refused: number
  /// The exit furthest from its quote relative to its size, as received
  /// minus quoted: on devnet the drift is a few micro-USDC, which a ppm
  /// rounded toward zero would report as nothing.
  readonly worstGapMicro: bigint
  readonly worstPpm: bigint
  readonly withinBudget: boolean
}

function magnitude(value: bigint): bigint {
  return value < 0n ? -value : value
}

export function judgeQuotes(samples: readonly QuoteSample[]): QuoteVerdict {
  if (samples.length === 0) {
    throw new MeasureError('nothing to judge: no exit was sampled')
  }

  let refused = 0
  let worst = { gapMicro: 0n, quotedMicro: 1n }
  let withinBudget = true

  for (const { quotedMicro, receivedMicro } of samples) {
    if (receivedMicro === null) {
      refused += 1
      withinBudget = false
      continue
    }

    const gapMicro = receivedMicro - quotedMicro
    if (magnitude(gapMicro) * worst.quotedMicro > magnitude(worst.gapMicro) * quotedMicro) {
      worst = { gapMicro, quotedMicro }
    }
    withinBudget &&= withinQuoteBudget(quotedMicro, receivedMicro)
  }

  return {
    count: samples.length,
    refused,
    worstGapMicro: worst.gapMicro,
    worstPpm: driftPpm(worst.quotedMicro, worst.quotedMicro + worst.gapMicro),
    withinBudget,
  }
}

function usdc(micro: bigint): string {
  const whole = micro / MICRO_PER_USDC
  const fraction = (micro % MICRO_PER_USDC).toString().padStart(6, '0')

  return `${whole}.${fraction}`
}

function signed(value: bigint): string {
  return `${value > 0n ? '+' : ''}${value}`
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const PROFILE: RiskProfile = 'conservative'
const PROFILE_ARG = { conservative: { conservative: {} }, balanced: { balanced: {} } } as const

/// Position rent, five pool holdings at most, and a few hundred fees.
const OWNER_FUNDING_LAMPORTS = 20_000_000

/// Reading the quote, pressing exit, approving in the wallet.
const HUMAN_PAUSE_MS = 20_000

const CONFIRM_POLL_MS = 500
const CONFIRM_TIMEOUT_MS = 60_000
const SC_003_BUDGET_MS = 10_000

/// `LadderError::QuoteDrift`, as the RPC spells it in a failed preflight.
const QUOTE_DRIFT = 6028
const QUOTE_DRIFT_HEX = `0x${QUOTE_DRIFT.toString(16)}`

interface Accounts {
  readonly vault: PublicKey
  readonly usdcMint: PublicKey
  readonly issuerProgram: PublicKey
  readonly ratingOracle: PublicKey
  readonly owner: Keypair
  readonly ownerUsdc: PublicKey
  readonly position: PublicKey
}

async function readUsdc(connection: Connection, account: PublicKey): Promise<bigint> {
  const { value } = await withRetry('owner USDC', () =>
    connection.getTokenAccountBalance(account, 'confirmed'),
  )

  return BigInt(value.amount)
}

async function deposit(
  connection: Connection,
  ladder: Program<BondLadder>,
  deployer: Keypair,
  accounts: Accounts,
  depositMicro: bigint,
): Promise<string> {
  const { vault, issuerProgram, ratingOracle, usdcMint, owner } = accounts
  const oracleConfig = pda([SEED_ORACLE], ratingOracle)
  const issuerConfig = pda([SEED_ISSUER], issuerProgram)
  const addresses = catalogAddresses(issuerProgram, ratingOracle)

  const [oracleInfo] = await withRetry('oracle', () =>
    connection.getMultipleAccountsInfo([oracleConfig]),
  )
  if (oracleInfo == null) {
    throw new MeasureError('the rating oracle is not initialised')
  }
  const instruments = await withRetry('catalogue', () =>
    connection.getMultipleAccountsInfo(addresses.map((address) => address.instrument)),
  )
  const ratings = await withRetry('ratings', () =>
    connection.getMultipleAccountsInfo(addresses.map((address) => address.rating)),
  )

  const nowTs = BigInt(Math.floor(Date.now() / 1000))
  const candidates = toCandidates(
    addresses.map((address, index) => {
      const instrument = instruments[index]
      const rating = ratings[index]

      return {
        address,
        instrument: instrument == null ? null : decodeInstrument(instrument.data),
        rating: rating == null ? null : decodeRatingRecord(rating.data),
      }
    }),
    nowTs,
    decodeOracleConfig(oracleInfo.data).maxAgeSecs,
  )
  const proposal = proposeLadder({ profile: PROFILE, depositMicro, nowTs, candidates })
  if (!proposal.ok) {
    throw new MeasureError(`the ladder proposal refused: ${proposal.reason}`)
  }

  const custodies = proposal.allocations.map(({ candidate }) =>
    custodyAddress(candidate.address.mint, vault),
  )
  const existing = await withRetry('custody', () => connection.getMultipleAccountsInfo(custodies))
  const missing = proposal.allocations.filter((_, index) => existing[index] == null)
  if (missing.length > 0) {
    await sendAndConfirm(
      connection,
      'vault custody',
      missing.map(({ candidate }) =>
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
  }

  const instruction = await ladder.methods
    .openLadder(PROFILE_ARG[PROFILE], new BN(depositMicro.toString()))
    .accountsPartial({
      vault,
      position: accounts.position,
      owner: owner.publicKey,
      ownerUsdc: accounts.ownerUsdc,
      oracleConfig,
      issuerProgram,
      issuerConfig,
      issuerTreasury: getAssociatedTokenAddressSync(usdcMint, issuerConfig, true),
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(
      proposal.allocations.flatMap(({ candidate }) => rungAccountMetas(candidate, vault)),
    )
    .instruction()

  return sendAndConfirm(connection, 'deposit', [instruction], owner, [])
}

interface ExitDesk {
  readonly position: Position
  readonly prices: ReadonlyMap<string, bigint>
  readonly vault: Vault
}

async function readDesk(connection: Connection, accounts: Accounts): Promise<ExitDesk> {
  const [vaultInfo, positionInfo] = await withRetry('vault and position', () =>
    connection.getMultipleAccountsInfo([accounts.vault, accounts.position]),
  )
  if (vaultInfo == null || positionInfo == null) {
    throw new MeasureError('the vault or the position is gone')
  }
  const position = decodePosition(positionInfo.data)

  const infos = await withRetry('instruments', () =>
    connection.getMultipleAccountsInfo(
      position.rungs.map((rung) =>
        pda([SEED_INSTRUMENT, new PublicKey(rung.instrument).toBytes()], accounts.issuerProgram),
      ),
    ),
  )
  const prices = new Map<string, bigint>()
  for (const info of infos) {
    if (info != null) {
      const instrument = decodeInstrument(info.data)
      prices.set(instrument.mint, instrument.priceMicro)
    }
  }

  return { position, prices, vault: decodeVault(vaultInfo.data) }
}

/// The same keys, in the same order, as `exitLadderInstruction` on the screen.
function exitInstruction(
  ladderProgram: PublicKey,
  accounts: Accounts,
  position: Position,
  shareBps: number,
  minPayoutMicro: bigint,
): TransactionInstruction {
  const keys: AccountMeta[] = [
    { pubkey: accounts.vault, isSigner: false, isWritable: true },
    { pubkey: accounts.position, isSigner: false, isWritable: true },
    { pubkey: accounts.owner.publicKey, isSigner: true, isWritable: true },
    { pubkey: accounts.ownerUsdc, isSigner: false, isWritable: true },
    {
      pubkey: getAssociatedTokenAddressSync(accounts.usdcMint, accounts.vault, true),
      isSigner: false,
      isWritable: true,
    },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ]

  for (const rung of position.rungs) {
    const mint = new PublicKey(rung.instrument).toBytes()
    keys.push(
      {
        pubkey: pda([SEED_INSTRUMENT, mint], accounts.issuerProgram),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: pda([SEED_RATING, mint], accounts.ratingOracle),
        isSigner: false,
        isWritable: false,
      },
      { pubkey: pda([SEED_BACKSTOP, mint], ladderProgram), isSigner: false, isWritable: true },
    )
  }

  return new TransactionInstruction({
    programId: ladderProgram,
    keys,
    data: Buffer.from(exitLadderData(shareBps, minPayoutMicro)),
  })
}

function refusedWithQuoteDrift(failure: unknown): boolean {
  if (failure instanceof SendTransactionError) {
    return [failure.message, ...(failure.logs ?? [])].some((line) =>
      line.includes(`custom program error: ${QUOTE_DRIFT_HEX}`),
    )
  }

  return false
}

function customCode(err: unknown): number | null {
  if (typeof err !== 'object' || err === null || !('InstructionError' in err)) {
    return null
  }
  const pair: unknown = err.InstructionError
  if (!Array.isArray(pair)) {
    return null
  }
  const detail: unknown = pair[1]

  return typeof detail === 'object' &&
    detail !== null &&
    'Custom' in detail &&
    typeof detail.Custom === 'number'
    ? detail.Custom
    : null
}

/// Resolves with the transaction's error, `null` once it confirmed clean.
async function awaitSignature(connection: Connection, signature: string): Promise<unknown> {
  const deadline = Date.now() + CONFIRM_TIMEOUT_MS

  while (Date.now() < deadline) {
    const { value } = await withRetry('signature status', () =>
      connection.getSignatureStatuses([signature]),
    )
    const status = value[0]
    if (status != null && (status.err !== null || status.confirmationStatus !== 'processed')) {
      return status.err
    }
    await pause(CONFIRM_POLL_MS)
  }

  throw new MeasureError(`${signature} was not confirmed within ${CONFIRM_TIMEOUT_MS / 1000} s`)
}

interface ExitSample extends QuoteSample {
  readonly depositMicro: bigint
  readonly shareBps: number
  /// Signature to a larger balance; `null` for a refused exit.
  readonly ms: number | null
  readonly signature: string | null
}

async function measureExit(
  connection: Connection,
  ladderProgram: PublicKey,
  accounts: Accounts,
  depositMicro: bigint,
  shareBps: number,
): Promise<ExitSample> {
  const nowTs = BigInt(Math.floor(Date.now() / 1000))
  const desk = await readDesk(connection, accounts)
  const quote = quoteShare({
    position: desk.position,
    prices: desk.prices,
    feeBps: desk.vault.feeBps,
    spreadCoefBps: desk.vault.spreadCoefBps,
    shareBps,
    nowTs,
  })
  if (quote.payoutMicro > desk.vault.backstopFreeUsdc) {
    throw new MeasureError(
      `the pool holds ${usdc(desk.vault.backstopFreeUsdc)} and this exit pays ${usdc(quote.payoutMicro)}: run fund:backstop first`,
    )
  }
  const before = await readUsdc(connection, accounts.ownerUsdc)

  await pause(HUMAN_PAUSE_MS)

  const { blockhash, lastValidBlockHeight } = await withRetry('blockhash', () =>
    connection.getLatestBlockhash('confirmed'),
  )
  const transaction = new Transaction({
    feePayer: accounts.owner.publicKey,
    blockhash,
    lastValidBlockHeight,
  }).add(
    exitInstruction(
      ladderProgram,
      accounts,
      desk.position,
      shareBps,
      payoutFloor(quote.payoutMicro),
    ),
  )
  transaction.sign(accounts.owner)
  const raw = transaction.serialize()
  const refused = {
    depositMicro,
    shareBps,
    quotedMicro: quote.payoutMicro,
    receivedMicro: null,
    ms: null,
  }

  const started = performance.now()
  let signature: string
  try {
    signature = await withRetry('exit', () =>
      connection.sendRawTransaction(raw, { preflightCommitment: 'confirmed' }),
    )
  } catch (failure) {
    if (refusedWithQuoteDrift(failure)) {
      return { ...refused, signature: null }
    }
    throw failure
  }

  const err = await awaitSignature(connection, signature)
  if (err !== null) {
    if (customCode(err) === QUOTE_DRIFT) {
      return { ...refused, signature }
    }
    throw new MeasureError(`${signature} failed: ${JSON.stringify(err)}`)
  }

  const deadline = Date.now() + CONFIRM_TIMEOUT_MS
  let after = await readUsdc(connection, accounts.ownerUsdc)
  while (after <= before) {
    if (Date.now() > deadline) {
      throw new MeasureError(`${signature} confirmed, but the owner's USDC never grew`)
    }
    await pause(CONFIRM_POLL_MS)
    after = await readUsdc(connection, accounts.ownerUsdc)
  }

  return {
    depositMicro,
    shareBps,
    quotedMicro: quote.payoutMicro,
    receivedMicro: after - before,
    ms: Math.round(performance.now() - started),
    signature,
  }
}

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

  const vault = pda([SEED_VAULT], ladder.programId)
  const vaultInfo = await withRetry('vault', () => connection.getAccountInfo(vault))
  if (vaultInfo === null) {
    throw new MeasureError('the vault does not exist: run deploy:devnet first')
  }
  const vaultState = decodeVault(vaultInfo.data)
  if (vaultState.paused) {
    throw new MeasureError('the vault is paused (FR-023)')
  }

  const sizes = depositSizes(vaultState.minDeposit)
  const totalMicro = sizes.reduce((sum, size) => sum + size, 0n)
  // Every exit pays out less than the deposit behind it, so the deposits
  // bound what the pool has to cover over the whole run.
  if (totalMicro > vaultState.backstopFreeUsdc) {
    throw new MeasureError(
      `the run deposits ${usdc(totalMicro)} and the pool holds ${usdc(vaultState.backstopFreeUsdc)}: run fund:backstop first`,
    )
  }

  const owner = Keypair.generate()
  const usdcMint = new PublicKey(vaultState.usdcMint)
  const accounts: Accounts = {
    vault,
    usdcMint,
    issuerProgram: new PublicKey(vaultState.issuerProgram),
    ratingOracle: new PublicKey(vaultState.ratingOracle),
    owner,
    ownerUsdc: getAssociatedTokenAddressSync(usdcMint, owner.publicKey),
    position: pda(
      [SEED_POSITION, owner.publicKey.toBytes(), Uint8Array.of(profileSeedByte(PROFILE))],
      ladder.programId,
    ),
  }

  console.log(`RPC        ${rpcUrl}`)
  console.log(`owner      ${owner.publicKey.toBase58()}`)
  console.log(
    `plan       ${DEPOSIT_COUNT} deposits ${usdc(sizes[0] ?? 0n)}…${usdc(sizes[sizes.length - 1] ?? 0n)} USDC, ` +
      `each left in ${EXIT_SHARES_BPS.map((bps) => `${bps / 100}%`).join(' → ')}`,
  )
  console.log(`pause      ${HUMAN_PAUSE_MS / 1000} s between quote and send\n`)

  await sendAndConfirm(
    connection,
    'owner SOL and USDC',
    [
      SystemProgram.transfer({
        fromPubkey: deployer.publicKey,
        toPubkey: owner.publicKey,
        lamports: OWNER_FUNDING_LAMPORTS,
      }),
      createAssociatedTokenAccountIdempotentInstruction(
        deployer.publicKey,
        accounts.ownerUsdc,
        owner.publicKey,
        usdcMint,
      ),
      createMintToInstruction(usdcMint, accounts.ownerUsdc, deployer.publicKey, totalMicro),
    ],
    deployer,
    [],
  )

  const samples: ExitSample[] = []
  for (const [round, depositMicro] of sizes.entries()) {
    await deposit(connection, ladder, deployer, accounts, depositMicro)

    for (const shareBps of EXIT_SHARES_BPS) {
      const sample = await measureExit(
        connection,
        ladder.programId,
        accounts,
        depositMicro,
        shareBps,
      )
      samples.push(sample)

      const outcome =
        sample.receivedMicro === null
          ? 'REFUSED QuoteDrift'
          : `received ${usdc(sample.receivedMicro)}  ${signed(sample.receivedMicro - sample.quotedMicro)} micro (${signed(driftPpm(sample.quotedMicro, sample.receivedMicro))} ppm)  ${sample.ms} ms`
      console.log(
        `${String(samples.length).padStart(3)}/100  round ${round + 1}  deposit ${usdc(depositMicro)}  ` +
          `${String(shareBps / 100).padStart(3)}%  quoted ${usdc(sample.quotedMicro)}  ${outcome}` +
          (sample.signature === null ? '' : `  ${explorerUrl(sample.signature, cluster)}`),
      )

      if (sample.receivedMicro === null && shareBps === 10_000) {
        throw new MeasureError(
          'the closing exit was refused, so the next round cannot reopen the position',
        )
      }
    }
  }

  const latency = summarise(
    samples.flatMap((sample) => (sample.ms === null ? [] : [sample.ms])),
    SC_003_BUDGET_MS,
  )
  const quotes = judgeQuotes(samples)

  console.log(
    `\nSC-003  worst ${latency.maxMs} ms (< ${SC_003_BUDGET_MS})  median ${latency.medianMs}  ` +
      `best ${latency.minMs}  exits ${latency.count}  ${latency.withinBudget ? 'PASS' : 'FAIL'}`,
  )
  console.log(
    `SC-006  worst ${signed(quotes.worstGapMicro)} micro-USDC = ${signed(quotes.worstPpm)} ppm (≤ ${SC_006_BUDGET_PPM} ppm = 0.1%)  ` +
      `exits ${quotes.count}  refused ${quotes.refused}  ${quotes.withinBudget ? 'PASS' : 'FAIL'}`,
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
