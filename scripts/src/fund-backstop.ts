// Tops the devnet backstop pool up to a target level so exits have USDC to pay
// out of. The pool is the vault's canonical demo-USDC account; the deployer is
// both the vault admin and the mint authority, so the top-up is minted rather
// than bought.
//
// Idempotent by level, not by amount: the gap is read from the vault's own
// `backstop_free_usdc`, so a rerun after a dropped transaction funds nothing
// twice.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { decodeVault, SEED_VAULT } from '@bondladder/shared'
import { AnchorProvider, BN, Program, Wallet } from '@coral-xyz/anchor'
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import { Connection, PublicKey } from '@solana/web3.js'
import type { BondLadder } from '../../target/types/bond_ladder'
import { custodyAddress } from './demo-deposit'
import {
  DeployError,
  loadKeypair,
  MICRO_PER_USDC,
  pda,
  readIdl,
  sendAndConfirm,
  withRetry,
} from './deploy'

const U64_MAX = 2n ** 64n - 1n

/// A hundred exits of the minimum deposit, so the SC-006 run never has to
/// stop and refill the pool halfway through.
export const BACKSTOP_TARGET_MICRO = 100_000n * MICRO_PER_USDC

export function backstopTopUp(freeMicro: bigint, targetMicro: bigint): bigint {
  return freeMicro >= targetMicro ? 0n : targetMicro - freeMicro
}

export function parseTargetMicro(raw: string | undefined): bigint {
  if (raw === undefined) {
    return BACKSTOP_TARGET_MICRO
  }
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new DeployError(`BACKSTOP_TARGET_USDC: "${raw}" is not a positive whole USDC amount`)
  }

  const targetMicro = BigInt(raw) * MICRO_PER_USDC
  if (targetMicro > U64_MAX) {
    throw new DeployError(`BACKSTOP_TARGET_USDC: ${raw} USDC does not fit the u64 pool counter`)
  }

  return targetMicro
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
  const targetMicro = parseTargetMicro(process.env.BACKSTOP_TARGET_USDC)

  const deployer = loadKeypair(keypairPath)
  const connection = new Connection(rpcUrl, 'confirmed')
  const provider = new AnchorProvider(connection, new Wallet(deployer), {
    commitment: 'confirmed',
  })
  const ladder = new Program<BondLadder>(readIdl<BondLadder>('bond_ladder'), provider)
  const vault = pda([SEED_VAULT], ladder.programId)

  const readVault = async () => {
    const info = await withRetry('vault read', () => connection.getAccountInfo(vault))
    if (info === null) {
      throw new DeployError(`${rpcUrl}: vault is not initialized, run deploy:devnet first`)
    }

    return decodeVault(info.data)
  }

  const before = await readVault()
  if (before.admin !== deployer.publicKey.toBase58()) {
    throw new DeployError(
      `vault admin is ${before.admin}, not ${deployer.publicKey.toBase58()}: fund_backstop would refuse`,
    )
  }

  const usdcMint = new PublicKey(before.usdcMint)
  const backstopUsdc = custodyAddress(usdcMint, vault)
  const adminUsdc = getAssociatedTokenAddressSync(usdcMint, deployer.publicKey)
  const topUpMicro = backstopTopUp(before.backstopFreeUsdc, targetMicro)

  console.log(`RPC        ${rpcUrl}`)
  console.log(`vault      ${vault.toBase58()}`)
  console.log(`pool       ${backstopUsdc.toBase58()}`)
  console.log(`free       ${usdc(before.backstopFreeUsdc)} USDC, target ${usdc(targetMicro)}`)

  if (topUpMicro === 0n) {
    console.log('pool       already at target, nothing to fund')
    return
  }

  // One transaction, so a dropped run leaves either all of it or none of it
  // to redo, never minted USDC stranded on the admin account.
  const signature = await sendAndConfirm(
    connection,
    'backstop top-up',
    [
      createAssociatedTokenAccountIdempotentInstruction(
        deployer.publicKey,
        backstopUsdc,
        vault,
        usdcMint,
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        deployer.publicKey,
        adminUsdc,
        deployer.publicKey,
        usdcMint,
      ),
      createMintToInstruction(usdcMint, adminUsdc, deployer.publicKey, topUpMicro),
      await ladder.methods
        .fundBackstop(new BN(topUpMicro.toString()))
        .accountsPartial({
          vault,
          admin: deployer.publicKey,
          adminUsdc,
          backstopUsdc,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction(),
    ],
    deployer,
    [],
  )

  const after = await readVault()
  const poolBalance = await withRetry('pool read', () =>
    connection.getTokenAccountBalance(backstopUsdc),
  )

  console.log(`funded     ${usdc(topUpMicro)} USDC  ${signature}`)
  console.log(`free       ${usdc(after.backstopFreeUsdc)} USDC in the vault counter`)
  console.log(`pool       ${poolBalance.value.uiAmountString} USDC on the token account`)

  if (after.backstopFreeUsdc < targetMicro) {
    throw new DeployError(
      `free backstop ${usdc(after.backstopFreeUsdc)} is still below target ${usdc(targetMicro)}`,
    )
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
