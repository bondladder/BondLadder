// Tops the devnet issuer treasury up to the face value of every instrument
// unit in circulation, so a matured rung can be redeemed at par and rolled.
// The treasury only ever received purchase prices, which are a discount to
// par, so without this the first roll is refused whole (TreasuryShort).
//
// The deployer is the demo-USDC mint authority, so the top-up is minted
// straight into the treasury. Idempotent by level, like fund:backstop: the gap
// is read from the treasury's balance and the mints' supply on every run.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { decodeVault, SEED_ISSUER, SEED_VAULT } from '@bondladder/shared'
import { AnchorProvider, Program, Wallet } from '@coral-xyz/anchor'
import {
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  unpackMint,
} from '@solana/spl-token'
import { Connection, PublicKey } from '@solana/web3.js'
import type { BondLadder } from '../../target/types/bond_ladder'
import { catalogAddresses } from './demo-deposit'
import {
  DeployError,
  loadKeypair,
  MICRO_PER_USDC,
  pda,
  readIdl,
  sendAndConfirm,
  withRetry,
} from './deploy'

/// The instrument mints have no decimals, so one unit is one face value of
/// 1 USDC — `Instrument::PAR_MICRO` in mock_issuer.
export const PAR_MICRO = MICRO_PER_USDC

/// Every unit in circulation, not only the vault's: the issuer redeems any
/// holder at maturity, and the pool's bought-back holdings sit in the same
/// custody as the ladders.
export function redeemableMicro(supplies: readonly bigint[]): bigint {
  return supplies.reduce((owed, supply) => owed + supply * PAR_MICRO, 0n)
}

export function treasuryTopUp(balanceMicro: bigint, owedMicro: bigint): bigint {
  return balanceMicro >= owedMicro ? 0n : owedMicro - balanceMicro
}

function usdc(micro: bigint): string {
  const whole = micro / MICRO_PER_USDC
  const fraction = (micro % MICRO_PER_USDC).toString().padStart(6, '0')

  return `${whole}.${fraction}`
}

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
  const ladder = new Program<BondLadder>(readIdl<BondLadder>('bond_ladder'), provider)
  const vault = pda([SEED_VAULT], ladder.programId)

  const vaultInfo = await withRetry('vault read', () => connection.getAccountInfo(vault))
  if (vaultInfo === null) {
    throw new DeployError(`${rpcUrl}: vault is not initialized, run deploy:devnet first`)
  }
  const vaultState = decodeVault(vaultInfo.data)
  const usdcMint = new PublicKey(vaultState.usdcMint)
  const issuerProgram = new PublicKey(vaultState.issuerProgram)
  const issuerConfig = pda([SEED_ISSUER], issuerProgram)
  const treasury = getAssociatedTokenAddressSync(usdcMint, issuerConfig, true)

  const mints = catalogAddresses(issuerProgram, new PublicKey(vaultState.ratingOracle)).map(
    (address) => address.mint,
  )

  const readOwed = async () => {
    const infos = await withRetry('mint read', () => connection.getMultipleAccountsInfo(mints))
    const supplies = infos.map((info, index) => {
      const mint = mints[index]
      if (mint === undefined || info === null) {
        throw new DeployError(`instrument mint ${mint?.toBase58()} is missing, run deploy:devnet`)
      }

      return unpackMint(mint, info, TOKEN_PROGRAM_ID).supply
    })

    return redeemableMicro(supplies)
  }
  const readBalance = async () =>
    BigInt(
      (await withRetry('treasury read', () => connection.getTokenAccountBalance(treasury))).value
        .amount,
    )

  const owedMicro = await readOwed()
  const balanceMicro = await readBalance()
  const topUpMicro = treasuryTopUp(balanceMicro, owedMicro)

  console.log(`RPC        ${rpcUrl}`)
  console.log(`treasury   ${treasury.toBase58()}`)
  console.log(`holds      ${usdc(balanceMicro)} USDC, face value owed ${usdc(owedMicro)}`)

  if (topUpMicro === 0n) {
    console.log('treasury   already covers the face value, nothing to fund')
    return
  }

  const signature = await sendAndConfirm(
    connection,
    'treasury top-up',
    [createMintToInstruction(usdcMint, treasury, deployer.publicKey, topUpMicro)],
    deployer,
    [],
  )

  const after = await readBalance()
  console.log(`funded     ${usdc(topUpMicro)} USDC  ${signature}`)
  console.log(`holds      ${usdc(after)} USDC`)

  // Supply can grow between the reads if someone deposits meanwhile; the
  // check is against the face value read now, not before the top-up.
  const owedNow = await readOwed()
  if (after < owedNow) {
    throw new DeployError(
      `treasury ${usdc(after)} is still below the face value owed ${usdc(owedNow)}, run again`,
    )
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
