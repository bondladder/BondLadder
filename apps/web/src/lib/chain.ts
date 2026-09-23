/**
 * BondLadder — the catalogue and the term sheet, read from the chain.
 *
 * The browser knows no instrument address in advance: the catalogue is found
 * by asking each program for its own accounts, filtered by discriminator and
 * size. Deriving the 45 mints from the seeds `scripts/src/deploy.ts` uses
 * would need ed25519 in the browser and would hard-code the demo catalogue's
 * naming into the app; a program scan needs neither and shows what is actually
 * deployed. Two round trips, and no address is ever taken on trust — every
 * account goes through the decoders in `@bondladder/shared`.
 *
 * Nothing here decides anything the program does not decide again: the term
 * sheet is what `open_ladder` will record if it accepts, shown before the
 * signature (FR-007). Its arithmetic is mirrored and fixture-pinned, so a
 * figure on the screen and a figure in the position cannot drift apart.
 */

import {
    accrueFee,
    decodeInstrument,
    decodeOracleConfig,
    decodeRatingRecord,
    encodeBase58,
    fillForShare,
    INSTRUMENT_ACCOUNT,
    type Instrument,
    isRatingUsable,
    issuerShareBps,
    type LadderAllocation,
    type LadderCandidate,
    maxIssuerBps,
    type Position,
    proposeLadder,
    RATING_RECORD_ACCOUNT,
    type RatingRecord,
    type RiskProfile,
    type Vault,
} from '@bondladder/shared';
import { PublicKey } from '@solana/web3.js';
import { usdcFromMicro } from './format';
import {
    associatedTokenAddress,
    buildCustodySetup,
    buildDeposit,
    connection,
    instrumentAddress,
    missingCustody,
    oracleConfigAddress,
    ProgramClientError,
    ratingAddress,
    readPosition,
    readTokenAccount,
    readVault,
    type VaultState,
} from './program';

export { explorerTx } from './program';

/** One instrument, with the rating the program would read beside it. */
export interface CatalogueEntry {
    readonly mint: string;
    readonly issuerId: string;
    readonly agencyCode: string;
    readonly notch: number;
    readonly maturityTs: bigint;
    readonly couponBps: number;
    readonly priceMicro: bigint;
}

export interface Catalogue {
    readonly vault: VaultState;
    readonly maxAgeSecs: bigint;
    /** How many instruments the issuer holds, usable or not. */
    readonly instrumentCount: number;
    readonly entries: readonly CatalogueEntry[];
}

export interface CatalogueCandidate extends LadderCandidate {
    readonly entry: CatalogueEntry;
}

export interface SheetRow {
    readonly rungMonths: number;
    readonly entry: CatalogueEntry;
    readonly budgetMicro: bigint;
    readonly units: bigint;
    readonly spentMicro: bigint;
    readonly shareBps: number;
}

export interface TermSheet {
    readonly rows: readonly SheetRow[];
    readonly depositMicro: bigint;
    readonly investedMicro: bigint;
    /** The tail too small to buy a whole unit — it never leaves the wallet. */
    readonly returnedMicro: bigint;
    readonly weightedNotch: number;
    readonly issuerCount: number;
    readonly largestIssuerBps: number;
    /** Rungs whose share does not reach one unit of their instrument. */
    readonly emptyRungMonths: readonly number[];
}

const TOKEN_ACCOUNT_SIZE = 165;
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64;

/**
 * An instrument counts only with its own rating beside it, fresh enough and on
 * this scale version. Everything dropped here the program would drop too — and
 * a term sheet built on it could be shown but never signed.
 */
export function joinCatalogue(
    instruments: readonly Instrument[],
    ratings: readonly RatingRecord[],
    nowTs: bigint,
    maxAgeSecs: bigint,
): readonly CatalogueEntry[] {
    const byMint = new Map(ratings.map((record) => [record.instrumentMint, record]));
    const entries: CatalogueEntry[] = [];

    for (const instrument of instruments) {
        const rating = byMint.get(instrument.mint);
        if (rating === undefined || !isRatingUsable(rating, nowTs, maxAgeSecs)) {
            continue;
        }
        // The issuer refuses to sell a matured instrument, and the route
        // refuses a price of zero: neither belongs on a term sheet.
        if (instrument.maturityTs <= nowTs || instrument.priceMicro === 0n) {
            continue;
        }

        entries.push({
            mint: instrument.mint,
            issuerId: instrument.issuerId,
            agencyCode: rating.agencyCode,
            notch: rating.notch,
            maturityTs: instrument.maturityTs,
            couponBps: instrument.couponBps,
            priceMicro: instrument.priceMicro,
        });
    }

    return entries;
}

export function catalogueCandidates(entries: readonly CatalogueEntry[]): readonly CatalogueCandidate[] {
    return entries.map((entry) => ({
        issuerId: entry.issuerId,
        maturityTs: entry.maturityTs,
        notch: entry.notch,
        entry,
    }));
}

/**
 * The three refusals the vault itself holds (FR-009, FR-023). They are checked
 * here so the screen can say which one applies instead of handing the wallet a
 * transaction that is going to fail.
 */
export function vaultRefusal(vault: Vault, depositMicro: bigint): string | null {
    if (vault.paused) {
        return 'This vault is paused and is not taking deposits. Nothing has been moved.';
    }
    if (depositMicro < vault.minDeposit) {
        return `Minimum deposit is ${usdcFromMicro(vault.minDeposit)}. Nothing has been moved.`;
    }

    const remaining = vault.capacityUsdc - vault.totalPrincipalUsdc;
    if (depositMicro > remaining) {
        return `This vault can still take ${usdcFromMicro(remaining)} and no more. Nothing has been moved.`;
    }

    return null;
}

/**
 * What the position will hold. The route buys whole units, so each rung spends
 * its share less the tail below one unit's price (FR-032) — and that tail is
 * the depositor's, which is why it is reported as returned rather than
 * quietly folded into the total.
 */
export function termSheet(
    allocations: readonly LadderAllocation<CatalogueCandidate>[],
    depositMicro: bigint,
): TermSheet {
    const rows: SheetRow[] = [];
    const byIssuer = new Map<string, bigint>();
    let investedMicro = 0n;
    let notchWeighted = 0n;

    for (const { rungMonths, amountMicro, candidate } of allocations) {
        const { units, spentMicro } = fillForShare(amountMicro, candidate.entry.priceMicro);

        investedMicro += spentMicro;
        notchWeighted += BigInt(candidate.notch) * spentMicro;
        byIssuer.set(candidate.issuerId, (byIssuer.get(candidate.issuerId) ?? 0n) + amountMicro);

        rows.push({
            rungMonths,
            entry: candidate.entry,
            budgetMicro: amountMicro,
            units,
            spentMicro,
            shareBps: issuerShareBps(amountMicro, depositMicro),
        });
    }

    const shares = [...byIssuer.values()].map((held) => issuerShareBps(held, depositMicro));

    return {
        rows,
        depositMicro,
        investedMicro,
        returnedMicro: depositMicro - investedMicro,
        // Weighted by the money actually placed, not by the budget: a rung that
        // bought nothing says nothing about the credit quality held.
        weightedNotch: investedMicro === 0n ? 0 : Number(notchWeighted) / Number(investedMicro),
        issuerCount: byIssuer.size,
        largestIssuerBps: shares.length === 0 ? 0 : Math.max(...shares),
        emptyRungMonths: rows.filter((row) => row.units === 0n).map((row) => row.rungMonths),
    };
}

export interface ChartDomain {
    readonly xMin: string;
    readonly xMax: string;
    readonly ticks: string[];
}

export interface RatingAxis {
    readonly ratingMin: number;
    readonly ratingMax: number;
    readonly axisValues: number[];
}

const MONTHS_PER_TICK = 3;
const MONTHS_PER_YEAR = 12;

function monthStart(unixSeconds: bigint, offsetMonths: number): string {
    const moment = new Date(Number(unixSeconds) * 1000);

    return new Date(Date.UTC(moment.getUTCFullYear(), moment.getUTCMonth() + offsetMonths, 1))
        .toISOString()
        .slice(0, 10);
}

/**
 * The horizontal axis, taken from the catalogue rather than fixed: what is
 * deployed decides how far out the ladder reaches, and a fixed domain would
 * push marks off the plot the moment the catalogue is re-seeded.
 */
export function chartDomain(maturities: readonly bigint[], nowTs: bigint): ChartDomain {
    const latest = maturities.reduce((last, ts) => (ts > last ? ts : last), nowTs);
    const xMin = monthStart(nowTs, 1);
    const xMax = monthStart(latest, 1);
    const ticks: string[] = [];

    for (let offset = MONTHS_PER_TICK; ; offset += MONTHS_PER_TICK) {
        const tick = monthStart(nowTs, offset + 1);
        if (tick >= xMax || offset > MONTHS_PER_YEAR * 10) {
            break;
        }
        ticks.push(tick);
    }

    return { xMin, xMax: xMax > xMin ? xMax : monthStart(nowTs, 2), ticks };
}

/** The grades actually present, plus the floor, so the floor rule has a place. */
export function ratingAxis(notches: readonly number[], floorNotch: number): RatingAxis {
    const present = [...new Set([...notches, floorNotch])].sort((left, right) => left - right);
    const ratingMin = present[0] ?? floorNotch;
    const ratingMax = present[present.length - 1] ?? floorNotch;

    return {
        ratingMin,
        // A single grade would divide by zero in the plot's scale.
        ratingMax: ratingMax > ratingMin ? ratingMax : ratingMin + 1,
        axisValues: present,
    };
}

/** A wallet with no token account for the mint holds none of it. */
export function tokenAmountFrom(data: Uint8Array | null): bigint {
    if (data === null) {
        return 0n;
    }
    if (data.length !== TOKEN_ACCOUNT_SIZE) {
        throw new ProgramClientError(`token account has ${data.length} bytes instead of ${TOKEN_ACCOUNT_SIZE}`);
    }

    return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(TOKEN_ACCOUNT_AMOUNT_OFFSET, true);
}

function scanFilters(layout: { discriminator: readonly number[]; size: number }) {
    return [
        { dataSize: layout.size },
        { memcmp: { offset: 0, bytes: encodeBase58(Uint8Array.from(layout.discriminator)) } },
    ];
}

/**
 * Vault and oracle first, because both program addresses and the freshness
 * window live in them (FR-002): the catalogue is read from the programs the
 * vault points at, not from anything this bundle was built with.
 */
export async function loadCatalogue(nowTs: bigint): Promise<Catalogue> {
    const vault = await readVault();
    const ratingOracle = new PublicKey(vault.state.ratingOracle);
    const issuerProgram = new PublicKey(vault.state.issuerProgram);

    const oracleInfo = await connection().getAccountInfo(oracleConfigAddress(ratingOracle));
    if (oracleInfo === null) {
        throw new ProgramClientError('the rating oracle is not initialised');
    }
    const { maxAgeSecs } = decodeOracleConfig(oracleInfo.data);

    const [rawInstruments, rawRatings] = await Promise.all([
        connection().getProgramAccounts(issuerProgram, {
            filters: scanFilters(INSTRUMENT_ACCOUNT),
        }),
        connection().getProgramAccounts(ratingOracle, {
            filters: scanFilters(RATING_RECORD_ACCOUNT),
        }),
    ]);

    const instruments = rawInstruments.map(({ account }) => decodeInstrument(account.data));
    const ratings = rawRatings.map(({ account }) => decodeRatingRecord(account.data));

    return {
        vault,
        maxAgeSecs,
        instrumentCount: instruments.length,
        entries: joinCatalogue(instruments, ratings, nowTs, maxAgeSecs),
    };
}

export interface Proposal {
    readonly sheet: TermSheet;
    readonly allocations: readonly LadderAllocation<CatalogueCandidate>[];
}

export type ProposalOutcome =
    | { readonly ok: true; readonly proposal: Proposal }
    | { readonly ok: false; readonly refusal: string };

function countWord(count: number): string {
    return ['no', 'one', 'two', 'three', 'four'][count] ?? String(count);
}

/**
 * The proposal and its refusals in one place, so the screen prints a sentence
 * rather than a reason code. None of it binds the program: `open_ladder`
 * checks every constraint again and would refuse an unfaithful proposal
 * (SC-004).
 */
export function proposeDeposit(
    catalogue: Catalogue,
    profile: RiskProfile,
    depositMicro: bigint,
    nowTs: bigint,
): ProposalOutcome {
    const refusal = vaultRefusal(catalogue.vault.state, depositMicro);
    if (refusal !== null) {
        return { ok: false, refusal };
    }

    const candidates = catalogueCandidates(catalogue.entries);
    const proposal = proposeLadder({ profile, depositMicro, nowTs, candidates });

    if (!proposal.ok) {
        return { ok: false, refusal: proposalRefusal(proposal.reason, catalogue, profile) };
    }

    const sheet = termSheet(proposal.allocations, depositMicro);
    if (sheet.emptyRungMonths.length > 0) {
        const months = sheet.emptyRungMonths.join(', ');
        return {
            ok: false,
            refusal:
                `${usdcFromMicro(depositMicro)} does not buy a whole unit at the ${months} month ` +
                'point. A position is never opened partially. Nothing has been moved.',
        };
    }

    return { ok: true, proposal: { sheet, allocations: proposal.allocations } };
}

function proposalRefusal(
    reason: 'deposit-below-rung-count' | 'rung-unfilled' | 'issuer-limit',
    catalogue: Catalogue,
    profile: RiskProfile,
): string {
    if (reason === 'issuer-limit') {
        const limit = maxIssuerBps(profile) / 100;
        return (
            `No five instruments fit without one issuer taking more than ${limit}% of the ` +
            'deposit. Nothing has been moved.'
        );
    }
    if (reason === 'deposit-below-rung-count') {
        return 'A deposit is split across five maturities and cannot be smaller than five units. Nothing has been moved.';
    }

    const issuers = new Set(catalogue.entries.map((entry) => entry.issuerId)).size;
    return (
        `Only ${countWord(issuers)} ${issuers === 1 ? 'issuer meets' : 'issuers meet'} the ` +
        `${profile} floor with a usable rating today. A position needs five, one per maturity, ` +
        'and is never opened partially. Nothing has been moved.'
    );
}

export async function readUsdcBalance(catalogue: Catalogue, owner: string): Promise<bigint> {
    const data = await readTokenAccount(new PublicKey(catalogue.vault.state.usdcMint), new PublicKey(owner));

    return tokenAmountFrom(data);
}

/** What the screen is waiting for, so it can say which of the two signatures. */
export type DepositStep = 'custody' | 'deposit';

/**
 * Opening the position: custody first if any of the five accounts is missing,
 * then the deposit itself.
 *
 * Two transactions, not one, and not for convenience. `open_ladder` checks the
 * custody accounts rather than creating them, and the deposit already carries
 * 31 accounts — adding five creations to it lands at 1226 bytes against a
 * ceiling of 1232, with no room for a compute-unit limit. Kept apart, the
 * deposit stays exactly what SC-002 measures: one transaction, ≈114 000 CU.
 */
export async function openPosition(
    catalogue: Catalogue,
    proposal: Proposal,
    profile: RiskProfile,
    depositMicro: bigint,
    owner: string,
    sign: (transaction: Uint8Array) => Promise<string>,
    onStep: (step: DepositStep) => void,
): Promise<string> {
    const vault = catalogue.vault;
    const payer = new PublicKey(owner);
    const issuerProgram = new PublicKey(vault.state.issuerProgram);
    const ratingOracle = new PublicKey(vault.state.ratingOracle);
    const mints = proposal.sheet.rows.map((row) => new PublicKey(row.entry.mint));

    const missing = await missingCustody(vault.address, mints);
    if (missing.length > 0) {
        onStep('custody');
        await sign(await buildCustodySetup(payer, vault.address, missing));
    }

    onStep('deposit');

    return sign(
        await buildDeposit({
            vault,
            owner: payer,
            profile,
            depositMicro,
            rungs: mints.map((mint) => ({
                instrument: instrumentAddress(mint, issuerProgram),
                rating: ratingAddress(mint, ratingOracle),
                mint,
                custody: associatedTokenAddress(mint, vault.address),
            })),
        }),
    );
}

/* ------------------------------------------------------------------ */
/* The held position                                                   */
/* ------------------------------------------------------------------ */

/** One rung of a held position, valued at what the issuer prices it today. */
export interface StatementRow {
    readonly rungMonths: number;
    readonly mint: string;
    readonly issuerId: string;
    /** `null` together with `notch`: the oracle has nothing usable to say today. */
    readonly agencyCode: string | null;
    readonly entryNotch: number;
    readonly notch: number | null;
    readonly maturityTs: bigint;
    readonly couponBps: number;
    readonly units: bigint;
    readonly entryPriceMicro: bigint;
    readonly priceMicro: bigint;
    /** Units at the price the route paid — the rung's share of the principal. */
    readonly costMicro: bigint;
    readonly valueMicro: bigint;
    readonly remainingSeconds: bigint;
    readonly flagged: boolean;
}

export interface PositionStatement {
    readonly profile: RiskProfile;
    readonly rows: readonly StatementRow[];
    readonly openedAt: bigint;
    readonly heldSeconds: bigint;
    readonly principalMicro: bigint;
    readonly grossValueMicro: bigint;
    /** Accrued and not yet taken: a liability, shown on a line of its own. */
    readonly feeAccruedMicro: bigint;
    readonly feeBps: number;
    readonly netValueMicro: bigint;
    /** `null` when any rung is unrated — see `unratedCount`. */
    readonly weightedNotch: number | null;
    readonly unratedCount: number;
    readonly averageRemainingSeconds: bigint;
    readonly nextMaturity: StatementRow | null;
}

export interface StatementInput {
    readonly position: Position;
    readonly vault: Vault;
    readonly instruments: readonly Instrument[];
    readonly ratings: readonly RatingRecord[];
    readonly nowTs: bigint;
    readonly maxAgeSecs: bigint;
}

function sinceOrZero(nowTs: bigint, then: bigint): bigint {
    return nowTs > then ? nowTs - then : 0n;
}

/**
 * What the position is worth and what it costs to hold (FR-011, FR-030).
 *
 * Every figure is read back rather than remembered: the units come from the
 * position the program wrote, the price from the issuer today, the grade from
 * the oracle today. The entry price and the entry grade travel beside them, so
 * a change in either is visible rather than averaged away.
 *
 * The fee is the debt the program will charge at the first operation that
 * touches the position (FR-020) — what it has already written down, plus what
 * has accrued since, by the same arithmetic the program uses. It is subtracted
 * from the value rather than reported next to it, because FR-030 asks every
 * other figure on the dashboard to be net of it.
 */
export function positionStatement(input: StatementInput): PositionStatement {
    const { position, vault, nowTs, maxAgeSecs } = input;
    const instrumentByMint = new Map(input.instruments.map((instrument) => [instrument.mint, instrument]));
    const ratingByMint = new Map(input.ratings.map((record) => [record.instrumentMint, record]));

    const rows: StatementRow[] = [];
    let grossValueMicro = 0n;
    let notchWeighted = 0n;
    let remainingWeighted = 0n;
    let unratedCount = 0;

    for (const rung of position.rungs) {
        const instrument = instrumentByMint.get(rung.instrument);
        if (instrument === undefined) {
            throw new ProgramClientError(`the instrument behind ${rung.instrument} could not be read`);
        }

        const record = ratingByMint.get(rung.instrument);
        const rated = record !== undefined && isRatingUsable(record, nowTs, maxAgeSecs);
        if (!rated) {
            unratedCount += 1;
        }

        const valueMicro = rung.amount * instrument.priceMicro;
        const remainingSeconds = sinceOrZero(rung.maturityTs, nowTs);

        grossValueMicro += valueMicro;
        remainingWeighted += remainingSeconds * valueMicro;
        if (rated && record !== undefined) {
            notchWeighted += BigInt(record.notch) * valueMicro;
        }

        rows.push({
            rungMonths: rung.targetMonths,
            mint: rung.instrument,
            issuerId: instrument.issuerId,
            agencyCode: rated && record !== undefined ? record.agencyCode : null,
            entryNotch: rung.entryNotch,
            notch: rated && record !== undefined ? record.notch : null,
            maturityTs: rung.maturityTs,
            couponBps: instrument.couponBps,
            units: rung.amount,
            entryPriceMicro: rung.entryPriceMicro,
            priceMicro: instrument.priceMicro,
            costMicro: rung.amount * rung.entryPriceMicro,
            valueMicro,
            remainingSeconds,
            flagged: rung.flagged,
        });
    }

    const feeAccruedMicro =
        position.feeAccrued + accrueFee(grossValueMicro, vault.feeBps, sinceOrZero(nowTs, position.lastFeeTs));

    const nextMaturity = rows.reduce<StatementRow | null>(
        (earliest, row) => (earliest === null || row.maturityTs < earliest.maturityTs ? row : earliest),
        null,
    );

    return {
        profile: position.profile,
        rows,
        openedAt: position.openedAt,
        heldSeconds: sinceOrZero(nowTs, position.openedAt),
        principalMicro: position.principalUsdc,
        grossValueMicro,
        feeAccruedMicro,
        feeBps: vault.feeBps,
        netValueMicro: grossValueMicro > feeAccruedMicro ? grossValueMicro - feeAccruedMicro : 0n,
        // Weighting by value is only honest over rungs that have a value and a
        // grade. One unrated rung and the portfolio's grade is unknown, not
        // the average of the rest (FR-025).
        weightedNotch:
            unratedCount > 0 || grossValueMicro === 0n ? null : Number(notchWeighted) / Number(grossValueMicro),
        unratedCount,
        averageRemainingSeconds: grossValueMicro === 0n ? 0n : remainingWeighted / grossValueMicro,
        nextMaturity,
    };
}

/** Both PDAs a wallet can hold, because a wallet may have opened under either. */
const STATEMENT_PROFILES: readonly RiskProfile[] = ['conservative', 'balanced'];

/**
 * Every position this wallet holds — none, one, or one per profile.
 *
 * Two round trips deep, and no program scan: a position names its own five
 * instruments, so the accounts behind it are derived rather than searched for.
 * That is what keeps the first screen inside SC-008 where the composer needs a
 * catalogue-wide scan.
 */
export async function readStatements(owner: string, nowTs: bigint): Promise<readonly PositionStatement[]> {
    const ownerKey = new PublicKey(owner);
    const [vault, held] = await Promise.all([
        readVault(),
        Promise.all(STATEMENT_PROFILES.map((profile) => readPosition(ownerKey, profile))),
    ]);

    const positions = held.filter((position): position is Position => position !== null);
    if (positions.length === 0) {
        return [];
    }

    const issuerProgram = new PublicKey(vault.state.issuerProgram);
    const ratingOracle = new PublicKey(vault.state.ratingOracle);
    const mints = [...new Set(positions.flatMap((position) => position.rungs.map((rung) => rung.instrument)))];

    const infos = await connection().getMultipleAccountsInfo([
        oracleConfigAddress(ratingOracle),
        ...mints.map((mint) => instrumentAddress(new PublicKey(mint), issuerProgram)),
        ...mints.map((mint) => ratingAddress(new PublicKey(mint), ratingOracle)),
    ]);

    const oracle = infos[0];
    if (oracle == null) {
        throw new ProgramClientError('the rating oracle is not initialised');
    }

    const instruments = mints.flatMap((_, index) => {
        const info = infos[1 + index];

        return info == null ? [] : [decodeInstrument(info.data)];
    });
    const ratings = mints.flatMap((_, index) => {
        const info = infos[1 + mints.length + index];

        return info == null ? [] : [decodeRatingRecord(info.data)];
    });

    const { maxAgeSecs } = decodeOracleConfig(oracle.data);

    return positions.map((position) =>
        positionStatement({ position, vault: vault.state, instruments, ratings, nowTs, maxAgeSecs }),
    );
}
