/**
 * BondLadder — клієнт трьох програм у браузері.
 *
 * IDL сюди не потрапляє: `target/` не комітиться, тож на Vercel його просто
 * немає. Замість копії IDL — пряме кодування з `@bondladder/shared`, звірене з
 * `fixtures/instructions.json` з обох боків.
 *
 * Усе, що приходить із RPC, проходить декодери пакета `shared`, а не читається
 * полями: за адресою може лежати що завгодно.
 */

import {
    decodePosition,
    decodeVault,
    openLadderData,
    type Position,
    profileSeedByte,
    type RiskProfile,
    RUNG_COUNT,
    SEED_INSTRUMENT,
    SEED_ISSUER,
    SEED_ORACLE,
    SEED_POSITION,
    SEED_RATING,
    SEED_VAULT,
    type Vault,
} from '@bondladder/shared';
import {
    type AccountMeta,
    Connection,
    PublicKey,
    SystemProgram,
    Transaction,
    TransactionInstruction,
} from '@solana/web3.js';
import { Buffer } from 'buffer';

// Глобального Buffer у браузері немає, а web3.js вимагає саме його: дані
// інструкції — Buffer, не Uint8Array.

export class ProgramClientError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ProgramClientError';
    }
}

const env = import.meta.env as Record<string, string | undefined>;

function required(name: string): string {
    const value = env[name];
    if (value === undefined || value === '') {
        throw new ProgramClientError(`змінна ${name} не задана — див. .env.example`);
    }
    return value;
}

export const RPC_URL = env.VITE_SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';

export const CLUSTER = env.VITE_SOLANA_CLUSTER ?? 'devnet';

/** Мережа у записі Wallet Standard: саме її гаманець звіряє перед підписом. */
export const CHAIN = `solana:${CLUSTER}`;

export function explorerTx(signature: string): string {
    return `https://explorer.solana.com/tx/${signature}?cluster=${CLUSTER}`;
}

let programId: PublicKey | null = null;

/**
 * Адреса читається лінько: у модульній області брак змінної впав би на імпорті
 * й лишив би порожню сторінку замість повідомлення про налаштування.
 */
export function bondLadderProgramId(): PublicKey {
    programId ??= new PublicKey(required('VITE_BOND_LADDER_PROGRAM_ID'));
    return programId;
}

// Адреса токен-програми зашита в саму інструкцію (`address =` в open_ladder),
// тому вибору тут немає і в конфігурацію вона не виноситься.
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

let shared: Connection | null = null;

export function connection(): Connection {
    shared ??= new Connection(RPC_URL, 'confirmed');
    return shared;
}

function pda(seeds: readonly Uint8Array[], programId: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync([...seeds], programId)[0];
}

export function vaultAddress(): PublicKey {
    return pda([SEED_VAULT], bondLadderProgramId());
}

export function positionAddress(owner: PublicKey, profile: RiskProfile): PublicKey {
    return pda([SEED_POSITION, owner.toBytes(), Uint8Array.of(profileSeedByte(profile))], bondLadderProgramId());
}

export function oracleConfigAddress(ratingOracle: PublicKey): PublicKey {
    return pda([SEED_ORACLE], ratingOracle);
}

export function issuerConfigAddress(issuerProgram: PublicKey): PublicKey {
    return pda([SEED_ISSUER], issuerProgram);
}

export function instrumentAddress(mint: PublicKey, issuerProgram: PublicKey): PublicKey {
    return pda([SEED_INSTRUMENT, mint.toBytes()], issuerProgram);
}

export function ratingAddress(mint: PublicKey, ratingOracle: PublicKey): PublicKey {
    return pda([SEED_RATING, mint.toBytes()], ratingOracle);
}

export function associatedTokenAddress(mint: PublicKey, owner: PublicKey): PublicKey {
    return pda([owner.toBytes(), TOKEN_PROGRAM_ID.toBytes(), mint.toBytes()], ASSOCIATED_TOKEN_PROGRAM_ID);
}

/**
 * `CreateIdempotent` асоційованого рахунку — один байт даних і шість акаунтів.
 * Заради цього не заводиться `@solana/spl-token`: розкладка стабільна, а
 * пакет тягне у бандл ще сотню кілобайт заради однієї інструкції.
 */
const ATA_CREATE_IDEMPOTENT = 1;

export function createAtaIdempotentInstruction(
    payer: PublicKey,
    mint: PublicKey,
    owner: PublicKey,
): TransactionInstruction {
    return new TransactionInstruction({
        programId: ASSOCIATED_TOKEN_PROGRAM_ID,
        keys: [
            { pubkey: payer, isWritable: true, isSigner: true },
            { pubkey: associatedTokenAddress(mint, owner), isWritable: true, isSigner: false },
            { pubkey: owner, isWritable: false, isSigner: false },
            { pubkey: mint, isWritable: false, isSigner: false },
            { pubkey: SystemProgram.programId, isWritable: false, isSigner: false },
            { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
        ],
        data: Buffer.from(Uint8Array.of(ATA_CREATE_IDEMPOTENT)),
    });
}

export interface VaultState {
    readonly address: PublicKey;
    readonly state: Vault;
}

export async function readVault(): Promise<VaultState> {
    const address = vaultAddress();
    const info = await connection().getAccountInfo(address);
    if (info === null) {
        throw new ProgramClientError(`${RPC_URL}: vault за адресою ${address.toBase58()} не існує`);
    }

    return { address, state: decodeVault(info.data) };
}

/** Позиції може не бути — це нормальний стан гаманця, який ще не вкладав. */
export async function readPosition(owner: PublicKey, profile: RiskProfile): Promise<Position | null> {
    const info = await connection().getAccountInfo(positionAddress(owner, profile));

    return info === null ? null : decodePosition(info.data);
}

/** Четвірка акаунтів щабля у порядку, яким її читає `open_ladder`. */
export interface RungAccounts {
    readonly instrument: PublicKey;
    readonly rating: PublicKey;
    readonly mint: PublicKey;
    readonly custody: PublicKey;
}

export interface DepositInput {
    readonly vault: VaultState;
    readonly owner: PublicKey;
    readonly profile: RiskProfile;
    readonly depositMicro: bigint;
    readonly rungs: readonly RungAccounts[];
}

function rungMetas(rung: RungAccounts): AccountMeta[] {
    return [
        { pubkey: rung.instrument, isWritable: false, isSigner: false },
        { pubkey: rung.rating, isWritable: false, isSigner: false },
        { pubkey: rung.mint, isWritable: true, isSigner: false },
        { pubkey: rung.custody, isWritable: true, isSigner: false },
    ];
}

export function openLadderInstruction(input: DepositInput): TransactionInstruction {
    if (input.rungs.length !== RUNG_COUNT) {
        throw new ProgramClientError(`лествиця з ${input.rungs.length} щаблів замість ${RUNG_COUNT}`);
    }

    const { usdcMint, issuerProgram, ratingOracle } = input.vault.state;
    const issuerProgramId = new PublicKey(issuerProgram);
    const issuerConfig = issuerConfigAddress(issuerProgramId);

    const keys: AccountMeta[] = [
        { pubkey: input.vault.address, isWritable: true, isSigner: false },
        { pubkey: positionAddress(input.owner, input.profile), isWritable: true, isSigner: false },
        { pubkey: input.owner, isWritable: true, isSigner: true },
        {
            pubkey: associatedTokenAddress(new PublicKey(usdcMint), input.owner),
            isWritable: true,
            isSigner: false,
        },
        {
            pubkey: oracleConfigAddress(new PublicKey(ratingOracle)),
            isWritable: false,
            isSigner: false,
        },
        { pubkey: issuerProgramId, isWritable: false, isSigner: false },
        { pubkey: issuerConfig, isWritable: false, isSigner: false },
        {
            pubkey: associatedTokenAddress(new PublicKey(usdcMint), issuerConfig),
            isWritable: true,
            isSigner: false,
        },
        { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
        { pubkey: SystemProgram.programId, isWritable: false, isSigner: false },
        ...input.rungs.flatMap(rungMetas),
    ];

    return new TransactionInstruction({
        programId: bondLadderProgramId(),
        keys,
        data: Buffer.from(openLadderData(input.profile, input.depositMicro)),
    });
}

async function serialize(owner: PublicKey, instructions: readonly TransactionInstruction[]): Promise<Uint8Array> {
    const { blockhash } = await connection().getLatestBlockhash('confirmed');

    const transaction = new Transaction({ feePayer: owner, recentBlockhash: blockhash });
    for (const instruction of instructions) {
        transaction.add(instruction);
    }

    return transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
}

/**
 * Транзакція віддається гаманцю несеріалізованою по частинах, а цілим
 * повідомленням: підпис ставить гаманець, тому підписів тут ще немає.
 */
export async function buildDeposit(input: DepositInput): Promise<Uint8Array> {
    return serialize(input.owner, [openLadderInstruction(input)]);
}

/**
 * Кастодія vault має існувати до депозиту: `open_ladder` перевіряє рахунок, а
 * не створює його. Створює будь-хто, тому це робить сам вкладник — але
 * **окремою транзакцією**.
 *
 * Разом вони не їдуть не з економії, а через межу розміру: депозит це вже 31
 * акаунт і ≈1144 байти, а програма ATA додає і свій акаунт, і по інструкції на
 * щабель — 1226 байтів при стелі 1232, без місця під ліміт обчислень. Розрив
 * на дві транзакції лишає депозит тим, чим його міряє SC-002: однією
 * транзакцією, ≈114 000 CU.
 */
export async function missingCustody(vault: PublicKey, mints: readonly PublicKey[]): Promise<readonly PublicKey[]> {
    const addresses = mints.map((mint) => associatedTokenAddress(mint, vault));
    const infos = await connection().getMultipleAccountsInfo(addresses);

    return mints.filter((_, index) => infos[index] == null);
}

export async function buildCustodySetup(
    owner: PublicKey,
    vault: PublicKey,
    mints: readonly PublicKey[],
): Promise<Uint8Array> {
    return serialize(
        owner,
        mints.map((mint) => createAtaIdempotentInstruction(owner, mint, vault)),
    );
}

export async function readTokenAccount(mint: PublicKey, owner: PublicKey): Promise<Uint8Array | null> {
    const info = await connection().getAccountInfo(associatedTokenAddress(mint, owner));

    return info === null ? null : info.data;
}
