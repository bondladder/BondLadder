// Розкладка інструкцій і сідів на дроті — те, з чого клієнт складає
// транзакцію, не маючи під рукою IDL. `target/` не комітиться, тому веб не
// може взяти ані IDL, ані згенеровані типи: замість копії IDL тут пряме
// кодування, звірене з fixtures/instructions.json.
//
// Той самий файл читає programs/bond-ladder/tests/instruction_layout.rs —
// перейменована інструкція або переставлений акаунт ламають Rust-тест, а не
// транзакцію на devnet.

import type { RiskProfile } from './profiles'

export class InstructionEncodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InstructionEncodeError'
  }
}

const U64_MAX = 2n ** 64n - 1n

function seed(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

export const SEED_VAULT = seed('vault')
export const SEED_POSITION = seed('position')
export const SEED_ORACLE = seed('oracle')
export const SEED_ISSUER = seed('issuer')
export const SEED_INSTRUMENT = seed('instrument')
export const SEED_RATING = seed('rating')

/// Інструмент, рейтинг, мінт і кастодія — по одному щаблю (open_ladder.rs).
export const ACCOUNTS_PER_RUNG = 4

export const OPEN_LADDER_DISCRIMINATOR = Uint8Array.of(31, 176, 2, 204, 72, 152, 86, 30)

export interface AccountSlot {
  readonly name: string
  readonly signer: boolean
  readonly writable: boolean
}

export const OPEN_LADDER_ACCOUNTS: readonly AccountSlot[] = [
  { name: 'vault', signer: false, writable: true },
  { name: 'position', signer: false, writable: true },
  { name: 'owner', signer: true, writable: true },
  { name: 'ownerUsdc', signer: false, writable: true },
  { name: 'oracleConfig', signer: false, writable: false },
  { name: 'issuerProgram', signer: false, writable: false },
  { name: 'issuerConfig', signer: false, writable: false },
  { name: 'issuerTreasury', signer: false, writable: true },
  { name: 'tokenProgram', signer: false, writable: false },
  { name: 'systemProgram', signer: false, writable: false },
]

// Байт сіда і borsh-варіант збігаються числами, але не походженням: програма
// виписує seed_byte вручну саме на випадок перестановки варіантів enum. Тому
// два записи, а не один спільний.
const PROFILE_SEED_BYTE: Record<RiskProfile, number> = { conservative: 0, balanced: 1 }
const PROFILE_VARIANT: Record<RiskProfile, number> = { conservative: 0, balanced: 1 }

export function profileSeedByte(profile: RiskProfile): number {
  return PROFILE_SEED_BYTE[profile]
}

export function openLadderData(profile: RiskProfile, depositMicro: bigint): Uint8Array {
  if (depositMicro < 0n || depositMicro > U64_MAX) {
    throw new InstructionEncodeError(`депозит ${depositMicro} не влазить у u64`)
  }

  const data = new Uint8Array(OPEN_LADDER_DISCRIMINATOR.length + 1 + 8)
  data.set(OPEN_LADDER_DISCRIMINATOR)
  data[OPEN_LADDER_DISCRIMINATOR.length] = PROFILE_VARIANT[profile]

  new DataView(data.buffer).setBigUint64(OPEN_LADDER_DISCRIMINATOR.length + 1, depositMicro, true)

  return data
}
