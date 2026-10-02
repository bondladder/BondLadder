import {
    accrueFee,
    type Instrument,
    instrumentSchema,
    type Position,
    positionSchema,
    proposeLadder,
    type RatingRecord,
    RUNG_MONTHS,
    ratingRecordSchema,
    rungTargetTs,
    SCALE_VERSION,
    settleExit,
    vaultSchema,
} from '@bondladder/shared';
import { describe, expect, it } from 'vitest';
import {
    catalogueCandidates,
    chartDomain,
    customErrorCode,
    driftPpm,
    exitRefusalText,
    holdingsToCreate,
    joinCatalogue,
    largestCoveredPercent,
    payoutFloor,
    positionStatement,
    QUOTE_TOLERANCE_BPS,
    quoteExit,
    ratingAxis,
    type StatementInput,
    termSheet,
    tokenAmountFrom,
    vaultRefusal,
} from './chain';
import { maturityDate } from './format';
import { ProgramClientError } from './program';

const NOW = 1_800_000_000n;
const DAY = 86_400n;
const MAX_AGE = 2_592_000n;
const DEPOSIT = 1_000_000_000n;

/** Base58 addresses only have to be well formed here — nothing is derived from them. */
const MINTS = [
    '54qF6z28JKTigFgqkYsYooZD9i6hit28L6fB3tufgy5x',
    'GTUNgpH4e6wfS65GeqSF369CfMUHeXRabEZSRRwXj7Fp',
    '8dd8kVyShvfPXs4XFipTWSYL1PzH35kfr3KNc6qpVtdP',
    'HftEWpSw9jNCrBiX9CKD8GG1AFTVBSvDgbu1FbNTK4tz',
    'D1bBmUA4Yc8viAwjwLR2fz14r7JSoxC6b5HWr2artfQS',
    '5aKvW5hFUGw5hKzpz5DRYBK26EADqRHHgknmCU1EGNHe',
    'EWhJjvNVb5mh1Jb9DTzvTwk7BeS9qdZdK7a6vdneQPa9',
    'EX1tNj2MLTacJPfAVzbBW8ejFsnSp7AsnZvnRLmDy3vK',
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
];

function mintAt(index: number): string {
    const mint = MINTS[index % MINTS.length];
    if (mint === undefined) throw new Error('немає мінта під індексом');
    return mint;
}

function instrument(overrides: Partial<Record<string, unknown>> = {}): Instrument {
    return instrumentSchema.parse({
        mint: mintAt(0),
        issuerId: 'HELVETIA-RE',
        maturityTs: rungTargetTs(NOW, 3),
        couponBps: 320,
        priceMicro: 970_000n,
        bump: 254,
        ...overrides,
    });
}

function rating(overrides: Partial<Record<string, unknown>> = {}): RatingRecord {
    return ratingRecordSchema.parse({
        instrumentMint: mintAt(0),
        notch: 1,
        scaleVersion: SCALE_VERSION,
        agencyCode: 'MOODYS',
        updatedAt: NOW - 60n,
        bump: 253,
        ...overrides,
    });
}

function vault(overrides: Partial<Record<string, unknown>> = {}) {
    return vaultSchema.parse({
        admin: mintAt(4),
        usdcMint: mintAt(2),
        ratingOracle: mintAt(6),
        issuerProgram: mintAt(7),
        feeBps: 50,
        spreadCoefBps: 200,
        crankRewardBps: 10,
        minDeposit: DEPOSIT,
        capacityUsdc: 1_000_000_000_000n,
        totalPrincipalUsdc: 0n,
        backstopFreeUsdc: 0n,
        backstopLockedValue: 0n,
        paused: false,
        bump: 255,
        ...overrides,
    });
}

describe('joinCatalogue', () => {
    it('pairs an instrument with its own rating', () => {
        const entries = joinCatalogue([instrument()], [rating()], NOW, MAX_AGE);

        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
            mint: mintAt(0),
            issuerId: 'HELVETIA-RE',
            notch: 1,
            couponBps: 320,
            priceMicro: 970_000n,
            agencyCode: 'MOODYS',
        });
    });

    it('drops an instrument the oracle has never rated', () => {
        expect(joinCatalogue([instrument()], [], NOW, MAX_AGE)).toEqual([]);
    });

    // The program refuses these three itself; a client that offered them would
    // put up a term sheet that cannot be signed.
    it('drops a rating the program would refuse', () => {
        const stale = rating({ updatedAt: NOW - MAX_AGE - 1n });
        const foreign = rating({ scaleVersion: SCALE_VERSION + 1 });

        expect(joinCatalogue([instrument()], [stale], NOW, MAX_AGE)).toEqual([]);
        expect(joinCatalogue([instrument()], [foreign], NOW, MAX_AGE)).toEqual([]);
    });

    it('drops an instrument whose maturity has already passed', () => {
        const matured = instrument({ maturityTs: NOW - DAY });

        expect(joinCatalogue([matured], [rating()], NOW, MAX_AGE)).toEqual([]);
    });

    it('drops an instrument the route would not sell', () => {
        const free = instrument({ priceMicro: 0n });

        expect(joinCatalogue([free], [rating()], NOW, MAX_AGE)).toEqual([]);
    });

    it('never pairs a rating with an instrument it was not written for', () => {
        const other = instrument({ mint: mintAt(1), issuerId: 'KESTREL-RAIL' });
        const entries = joinCatalogue([instrument(), other], [rating()], NOW, MAX_AGE);

        expect(entries.map((entry) => entry.mint)).toEqual([mintAt(0)]);
    });
});

describe('vaultRefusal', () => {
    it('lets a deposit inside the vault’s own limits through', () => {
        expect(vaultRefusal(vault(), DEPOSIT)).toBeNull();
    });

    it('refuses while the vault is paused', () => {
        expect(vaultRefusal(vault({ paused: true }), DEPOSIT)).toMatch(/paused/i);
    });

    it('refuses below the vault’s minimum and names it', () => {
        const refusal = vaultRefusal(vault(), DEPOSIT - 1n);

        expect(refusal).toMatch(/1,000.00 USDC/);
        expect(refusal).toMatch(/Nothing has been moved/);
    });

    it('refuses past the remaining capacity, not past the whole capacity', () => {
        const nearlyFull = vault({
            minDeposit: 1n,
            capacityUsdc: DEPOSIT * 2n,
            totalPrincipalUsdc: DEPOSIT + 1n,
        });

        expect(vaultRefusal(nearlyFull, DEPOSIT)).toMatch(/Nothing has been moved/);
        expect(vaultRefusal(nearlyFull, DEPOSIT - 1n)).toBeNull();
    });
});

describe('termSheet', () => {
    const entries = joinCatalogue(
        RUNG_MONTHS.flatMap((months, index) => [
            instrument({
                mint: mintAt(index),
                issuerId: `ISSUER-${index}`,
                maturityTs: rungTargetTs(NOW, months),
                priceMicro: 1_000_000n,
                couponBps: 300 + index,
            }),
        ]),
        RUNG_MONTHS.map((_, index) => rating({ instrumentMint: mintAt(index), notch: index + 1 })),
        NOW,
        MAX_AGE,
    );

    function sheetFor(depositMicro: bigint) {
        const proposal = proposeLadder({
            profile: 'balanced',
            depositMicro,
            nowTs: NOW,
            candidates: catalogueCandidates(entries),
        });
        if (!proposal.ok) throw new Error(`підбір відмовив: ${proposal.reason}`);

        return termSheet(proposal.allocations, depositMicro);
    }

    it('builds a row for every rung', () => {
        const sheet = sheetFor(DEPOSIT);

        expect(sheet.rows.map((row) => row.rungMonths)).toEqual([...RUNG_MONTHS]);
        expect(sheet.rows.every((row) => row.units > 0n)).toBe(true);
    });

    it('invests exactly what the rungs spend, and returns the rest', () => {
        const sheet = sheetFor(DEPOSIT);
        const spent = sheet.rows.reduce((sum, row) => sum + row.spentMicro, 0n);

        expect(sheet.investedMicro).toBe(spent);
        expect(sheet.investedMicro + sheet.returnedMicro).toBe(DEPOSIT);
    });

    // FR-032: the tail too small to buy a whole unit is the depositor's, and a
    // screen that showed the whole deposit as invested would be claiming it.
    it('shows the indivisible tail as returned, not as invested', () => {
        const sheet = sheetFor(DEPOSIT + 3n);

        expect(sheet.returnedMicro).toBe(3n);
        expect(sheet.investedMicro).toBe(DEPOSIT);
    });

    it('weights the rating by the money actually placed', () => {
        const sheet = sheetFor(DEPOSIT);

        expect(sheet.weightedNotch).toBeCloseTo(3, 5);
    });

    it('counts issuers and names the largest share', () => {
        const sheet = sheetFor(DEPOSIT);

        expect(sheet.issuerCount).toBe(5);
        expect(sheet.largestIssuerBps).toBe(2000);
    });

    it('names the rungs that a budget below the unit price would leave empty', () => {
        const dear = joinCatalogue(
            RUNG_MONTHS.map((months, index) =>
                instrument({
                    mint: mintAt(index),
                    issuerId: `ISSUER-${index}`,
                    maturityTs: rungTargetTs(NOW, months),
                    priceMicro: 500_000_000n,
                }),
            ),
            RUNG_MONTHS.map((_, index) => rating({ instrumentMint: mintAt(index), notch: index + 1 })),
            NOW,
            MAX_AGE,
        );
        const proposal = proposeLadder({
            profile: 'balanced',
            depositMicro: DEPOSIT,
            nowTs: NOW,
            candidates: catalogueCandidates(dear),
        });
        if (!proposal.ok) throw new Error('підбір відмовив');

        const sheet = termSheet(proposal.allocations, DEPOSIT);

        expect(sheet.emptyRungMonths).toEqual([...RUNG_MONTHS]);
    });
});

describe('tokenAmountFrom', () => {
    // A wallet with no USDC account at all holds no USDC — that is a balance,
    // not a failure to read one.
    it('reads nothing at all as an empty balance', () => {
        expect(tokenAmountFrom(null)).toBe(0n);
    });

    it('reads the amount out of a token account', () => {
        const data = new Uint8Array(165);
        new DataView(data.buffer).setBigUint64(64, 2_500_000_000n, true);

        expect(tokenAmountFrom(data)).toBe(2_500_000_000n);
    });

    it('refuses to read a buffer that is not a token account', () => {
        expect(() => tokenAmountFrom(new Uint8Array(64))).toThrow();
    });
});

describe('chartDomain', () => {
    // 2026-09-22, 2026-12-03 and 2028-03-10.
    const NOW_SEPTEMBER = 1_790_000_000n;
    const MATURITIES = [1_796_256_000n, 1_836_432_000n];

    it('starts the axis at the month the reader is in', () => {
        expect(chartDomain(MATURITIES, NOW_SEPTEMBER).xMin).toBe('2026-10-01');
    });

    it('ends the axis past the last maturity, never on it', () => {
        const domain = chartDomain(MATURITIES, NOW_SEPTEMBER);

        expect(domain.xMax).toBe('2028-04-01');
        expect(domain.xMax > maturityDate(1_836_432_000n)).toBe(true);
    });

    it('ticks every quarter inside the axis', () => {
        const { ticks } = chartDomain(MATURITIES, NOW_SEPTEMBER);

        expect(ticks[0]).toBe('2027-01-01');
        expect(ticks.at(-1) ?? '').toBe('2028-01-01');
        expect(ticks.every((tick) => tick.endsWith('-01'))).toBe(true);
    });

    it('survives an empty catalogue rather than drawing an axis backwards', () => {
        const domain = chartDomain([], NOW_SEPTEMBER);

        expect(domain.xMin < domain.xMax).toBe(true);
    });
});

describe('ratingAxis', () => {
    it('lists the grades present, best first', () => {
        expect(ratingAxis([7, 1, 7, 4], 10)).toEqual({
            ratingMin: 1,
            ratingMax: 10,
            axisValues: [1, 4, 7, 10],
        });
    });

    // The floor rule has to be drawn even when nothing sits at or below it,
    // otherwise it lands outside the plot.
    it('keeps the floor inside the axis', () => {
        expect(ratingAxis([1, 2], 7).ratingMax).toBe(7);
    });

    it('never collapses the axis to a single line', () => {
        const axis = ratingAxis([5], 5);

        expect(axis.ratingMin).toBeLessThan(axis.ratingMax);
    });
});

/* ------------------------------------------------------------------ */
/* The held position                                                   */
/* ------------------------------------------------------------------ */

const UNITS = 200n;
const UNIT_PRICE = 1_000_000n;
const PRINCIPAL = UNITS * UNIT_PRICE * BigInt(RUNG_MONTHS.length);

function months(index: number): number {
    return RUNG_MONTHS[index] ?? 3;
}

function heldInstrument(index: number, overrides: Partial<Record<string, unknown>> = {}): Instrument {
    return instrument({
        mint: mintAt(index),
        issuerId: `ISSUER-${index}`,
        maturityTs: rungTargetTs(NOW, months(index)),
        priceMicro: UNIT_PRICE,
        couponBps: 400 + index,
        ...overrides,
    });
}

function heldRating(index: number, overrides: Partial<Record<string, unknown>> = {}): RatingRecord {
    return rating({ instrumentMint: mintAt(index), notch: 4, ...overrides });
}

function heldRung(index: number, overrides: Partial<Record<string, unknown>> = {}) {
    return {
        targetMonths: months(index),
        instrument: mintAt(index),
        amount: UNITS,
        entryPriceMicro: UNIT_PRICE,
        entryNotch: 4,
        maturityTs: rungTargetTs(NOW, months(index)),
        flagged: false,
        ...overrides,
    };
}

function heldPosition(overrides: Partial<Record<string, unknown>> = {}): Position {
    return positionSchema.parse({
        owner: mintAt(4),
        profile: 'conservative',
        rungs: RUNG_MONTHS.map((_, index) => heldRung(index)),
        principalUsdc: PRINCIPAL,
        feeAccrued: 0n,
        lastFeeTs: NOW,
        openedAt: NOW,
        bump: 252,
        ...overrides,
    });
}

function statementInput(overrides: Partial<StatementInput> = {}): StatementInput {
    return {
        position: heldPosition(),
        vault: vault(),
        instruments: RUNG_MONTHS.map((_, index) => heldInstrument(index)),
        ratings: RUNG_MONTHS.map((_, index) => heldRating(index)),
        nowTs: NOW,
        maxAgeSecs: MAX_AGE,
        ...overrides,
    };
}

describe('positionStatement', () => {
    it('values every rung at what the issuer prices it today', () => {
        const dearer = RUNG_MONTHS.map((_, index) =>
            index === 0 ? heldInstrument(0, { priceMicro: 1_010_000n }) : heldInstrument(index),
        );
        const statement = positionStatement(statementInput({ instruments: dearer }));

        expect(statement.rows[0]).toMatchObject({
            rungMonths: 3,
            issuerId: 'ISSUER-0',
            units: UNITS,
            entryPriceMicro: UNIT_PRICE,
            priceMicro: 1_010_000n,
            costMicro: 200_000_000n,
            valueMicro: 202_000_000n,
        });
        expect(statement.grossValueMicro).toBe(PRINCIPAL + 2_000_000n);
    });

    // principal_usdc is the sum of what the route actually spent, and each
    // rung's cost is its units at the price it paid. The two are the same
    // figure read from two places; a mismatch means the row does not describe
    // the position the program recorded.
    it('accounts for the whole principal the program recorded', () => {
        const statement = positionStatement(statementInput());
        const cost = statement.rows.reduce((total, row) => total + row.costMicro, 0n);

        expect(cost).toBe(statement.principalMicro);
        expect(statement.principalMicro).toBe(PRINCIPAL);
    });

    // FR-030: the fee is a line of its own, and every figure beside it is net.
    it('shows the accrued fee apart and nets the value of it', () => {
        const held = 180n * 86_400n;
        const statement = positionStatement(
            statementInput({ position: heldPosition({ lastFeeTs: NOW - held, openedAt: NOW - held }) }),
        );

        expect(statement.feeBps).toBe(50);
        expect(statement.feeAccruedMicro).toBe(accrueFee(PRINCIPAL, 50, held));
        expect(statement.feeAccruedMicro).toBeGreaterThan(0n);
        expect(statement.netValueMicro).toBe(statement.grossValueMicro - statement.feeAccruedMicro);
        expect(statement.heldSeconds).toBe(held);
    });

    // Charged at the first next operation, so what the program already wrote
    // down is a debt the accrual since then is added to, not replaced by.
    it('adds what is already owed to what has accrued since', () => {
        const owed = 1_234n;
        const statement = positionStatement(
            statementInput({ position: heldPosition({ feeAccrued: owed, lastFeeTs: NOW - 86_400n }) }),
        );

        expect(statement.feeAccruedMicro).toBe(owed + accrueFee(PRINCIPAL, 50, 86_400n));
    });

    it('never nets the value below nothing', () => {
        const statement = positionStatement(statementInput({ position: heldPosition({ feeAccrued: PRINCIPAL * 2n }) }));

        expect(statement.netValueMicro).toBe(0n);
    });

    // A clock the browser owns and a clock the chain owns are not the same
    // clock; a few seconds of skew must not become a negative fee.
    it('accrues nothing for time that has not passed', () => {
        const statement = positionStatement(
            statementInput({ position: heldPosition({ lastFeeTs: NOW + 600n, openedAt: NOW + 600n }) }),
        );

        expect(statement.feeAccruedMicro).toBe(0n);
        expect(statement.heldSeconds).toBe(0n);
    });

    it('weights the rating by the money each rung holds', () => {
        const ratings = RUNG_MONTHS.map((_, index) => heldRating(index, { notch: index === 0 ? 9 : 4 }));
        const statement = positionStatement(statementInput({ ratings }));

        expect(statement.unratedCount).toBe(0);
        expect(statement.weightedNotch).toBeCloseTo((9 + 4 * 4) / 5, 10);
    });

    // The rating on the screen is today's, not the one the position was opened
    // at — the entry notch stays beside it so a downgrade is visible.
    it('keeps the grade the rung was bought at beside today’s', () => {
        const ratings = RUNG_MONTHS.map((_, index) => heldRating(index, { notch: index === 0 ? 9 : 4 }));
        const statement = positionStatement(statementInput({ ratings }));

        expect(statement.rows[0]).toMatchObject({ entryNotch: 4, notch: 9, agencyCode: 'MOODYS' });
    });

    // FR-025: an average over the rungs that happen to be rated would be
    // presented as the portfolio's, which it is not.
    it('refuses to average a rating it does not have for every rung', () => {
        const statement = positionStatement(statementInput({ ratings: [heldRating(0), heldRating(1)] }));

        expect(statement.weightedNotch).toBeNull();
        expect(statement.unratedCount).toBe(3);
        expect(statement.rows[2]).toMatchObject({ notch: null, agencyCode: null });
    });

    it('counts a rating the program would refuse as no rating', () => {
        const stale = RUNG_MONTHS.map((_, index) =>
            index === 0 ? heldRating(0, { updatedAt: NOW - MAX_AGE - 1n }) : heldRating(index),
        );
        const foreign = RUNG_MONTHS.map((_, index) =>
            index === 0 ? heldRating(0, { scaleVersion: SCALE_VERSION + 1 }) : heldRating(index),
        );

        expect(positionStatement(statementInput({ ratings: stale })).unratedCount).toBe(1);
        expect(positionStatement(statementInput({ ratings: foreign })).unratedCount).toBe(1);
    });

    it('averages the remaining term by the money it applies to', () => {
        const statement = positionStatement(statementInput());
        const remaining = statement.rows.reduce((total, row) => total + row.remainingSeconds, 0n);

        expect(statement.averageRemainingSeconds).toBe(remaining / 5n);
        expect(statement.rows[0]?.remainingSeconds).toBe(rungTargetTs(NOW, 3) - NOW);
    });

    // Nothing rolls a matured rung until maintenance exists, so it sits in the
    // position with no term left to run and must not shorten it by less.
    it('gives a matured rung no remaining term at all', () => {
        const matured = heldPosition({
            rungs: RUNG_MONTHS.map((_, index) =>
                index === 0 ? heldRung(0, { maturityTs: NOW - 86_400n }) : heldRung(index),
            ),
        });
        const statement = positionStatement(statementInput({ position: matured }));

        expect(statement.rows[0]?.remainingSeconds).toBe(0n);
    });

    it('names the earliest maturity whatever order the rungs arrive in', () => {
        const reversed = heldPosition({
            rungs: [...RUNG_MONTHS].map((_, index) => heldRung(RUNG_MONTHS.length - 1 - index)),
        });
        const statement = positionStatement(statementInput({ position: reversed }));

        expect(statement.nextMaturity?.rungMonths).toBe(3);
        expect(statement.nextMaturity?.maturityTs).toBe(rungTargetTs(NOW, 3));
    });

    it('carries the downgrade flag the program set', () => {
        const flagged = heldPosition({
            rungs: RUNG_MONTHS.map((_, index) => heldRung(index, { flagged: index === 2 })),
        });
        const statement = positionStatement(statementInput({ position: flagged }));

        expect(statement.rows.map((row) => row.flagged)).toEqual([false, false, true, false, false]);
    });

    // Reading the position without the instruments behind it cannot produce a
    // value, and a value short by one rung is worse than none.
    it('refuses to value a rung whose instrument it could not read', () => {
        const short = RUNG_MONTHS.slice(1).map((_, index) => heldInstrument(index + 1));

        expect(() => positionStatement(statementInput({ instruments: short }))).toThrow(ProgramClientError);
    });
});

/* ------------------------------------------------------------------ */
/* The exit                                                            */
/* ------------------------------------------------------------------ */

const FLUSH_POOL = 1_000_000_000_000n;

function heldStatement(overrides: Partial<Record<string, unknown>> = {}) {
    return positionStatement(statementInput({ position: heldPosition(overrides) }));
}

describe('payoutFloor', () => {
    it("signs for the quote less the declared tolerance, rounded in the owner's favour", () => {
        expect(QUOTE_TOLERANCE_BPS).toBe(10);
        expect(payoutFloor(1_000_000n)).toBe(999_000n);
        expect(payoutFloor(983_026_941n)).toBe(982_043_914n);
        expect(payoutFloor(999n)).toBe(998n);
    });

    it('asks for nothing when the quote is nothing', () => {
        expect(payoutFloor(0n)).toBe(0n);
    });
});

describe('quoteExit', () => {
    it('quotes the share through the settlement the program mirrors', () => {
        const statement = heldStatement({ feeAccrued: 1_234_567n, lastFeeTs: NOW - 30n * DAY });
        const outcome = quoteExit(statement, vault({ backstopFreeUsdc: FLUSH_POOL }), 100, NOW);

        if (!outcome.ok) throw new Error(outcome.refusal);
        const expected = settleExit({
            rungs: statement.rows.map((row) => ({
                units: row.units,
                priceMicro: row.priceMicro,
                maturityTs: row.maturityTs,
            })),
            principalMicro: statement.principalMicro,
            feeDueMicro: statement.feeAccruedMicro,
            shareBps: 10_000,
            spreadCoefBps: 200,
            nowTs: NOW,
        });

        expect(outcome.quote.settlement).toEqual(expected);
        expect(outcome.quote.shareBps).toBe(10_000);
        expect(outcome.quote.netValueMicro).toBe(expected.grossValueMicro - expected.feeChargedMicro);
        expect(outcome.quote.floorMicro).toBe(payoutFloor(expected.payoutMicro));
    });

    it('charges the whole fee due to a partial exit', () => {
        const statement = heldStatement({ feeAccrued: 2_000_000n });
        const outcome = quoteExit(statement, vault({ backstopFreeUsdc: FLUSH_POOL }), 50, NOW);

        if (!outcome.ok) throw new Error(outcome.refusal);
        expect(outcome.quote.shareBps).toBe(5_000);
        expect(outcome.quote.settlement.units).toEqual([100n, 100n, 100n, 100n, 100n]);
        expect(outcome.quote.settlement.feeChargedMicro).toBe(statement.feeAccruedMicro);
    });

    it('refuses an exit the pool cannot pay whole, and names the largest share it can', () => {
        const statement = heldStatement();
        const full = quoteExit(statement, vault({ backstopFreeUsdc: FLUSH_POOL }), 100, NOW);
        if (!full.ok) throw new Error(full.refusal);
        const pool = full.quote.settlement.payoutMicro / 2n;

        const outcome = quoteExit(statement, vault({ backstopFreeUsdc: pool }), 100, NOW);

        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.refusal).toContain('Nothing has been moved');
        expect(outcome.refusal).toContain('refused whole');
        expect(outcome.coveredPercent).not.toBeNull();

        const covered = outcome.coveredPercent ?? 0;
        const fits = quoteExit(statement, vault({ backstopFreeUsdc: pool }), covered, NOW);
        const above = quoteExit(statement, vault({ backstopFreeUsdc: FLUSH_POOL }), covered + 1, NOW);
        expect(fits.ok).toBe(true);
        if (!above.ok) throw new Error(above.refusal);
        expect(above.quote.settlement.payoutMicro).toBeGreaterThan(pool);
    });

    it('offers no smaller share when the pool is empty', () => {
        const outcome = quoteExit(heldStatement(), vault({ backstopFreeUsdc: 0n }), 100, NOW);

        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.coveredPercent).toBeNull();
    });

    it('refuses a share that moves no whole unit, without blaming the pool', () => {
        const thin = heldPosition({ rungs: RUNG_MONTHS.map((_, index) => heldRung(index, { amount: 1n })) });
        const statement = positionStatement(statementInput({ position: thin }));

        const outcome = quoteExit(statement, vault({ backstopFreeUsdc: FLUSH_POOL }), 50, NOW);

        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.refusal).toContain('whole unit');
        expect(outcome.coveredPercent).toBeNull();
    });

    it('refuses a share outside one to a hundred percent', () => {
        for (const percent of [0, 101, 2.5]) {
            const outcome = quoteExit(heldStatement(), vault({ backstopFreeUsdc: FLUSH_POOL }), percent, NOW);

            expect(outcome.ok, `${percent}`).toBe(false);
        }
    });
});

describe('largestCoveredPercent', () => {
    it('is the whole position when the pool covers it', () => {
        expect(largestCoveredPercent(heldStatement(), vault({ backstopFreeUsdc: FLUSH_POOL }), NOW)).toBe(100);
    });

    it('is nothing when not even one percent fits', () => {
        expect(largestCoveredPercent(heldStatement(), vault({ backstopFreeUsdc: 1n }), NOW)).toBeNull();
    });
});

describe('holdingsToCreate', () => {
    it('counts the rungs this exit moves units on and the pool holds nothing of yet', () => {
        const statement = heldStatement();
        const present = new Set([mintAt(0), mintAt(3)]);

        expect(holdingsToCreate(statement, [1n, 1n, 1n, 1n, 1n], present)).toBe(3);
        expect(holdingsToCreate(statement, [1n, 0n, 0n, 1n, 0n], present)).toBe(0);
        expect(holdingsToCreate(statement, [0n, 0n, 1n, 0n, 0n], new Set())).toBe(1);
    });
});

describe('customErrorCode', () => {
    it("reads the program's own code out of an instruction error", () => {
        expect(customErrorCode({ InstructionError: [0, { Custom: 6021 }] })).toBe(6021);
    });

    it('is nothing for an error that carries no custom code', () => {
        expect(customErrorCode({ InstructionError: [0, 'InvalidAccountData'] })).toBeNull();
        expect(customErrorCode('AccountNotFound')).toBeNull();
        expect(customErrorCode(null)).toBeNull();
        expect(customErrorCode({ InstructionError: [0, { Custom: 'x' }] })).toBeNull();
    });
});

describe('exitRefusalText', () => {
    it('explains the two refusals the owner can meet', () => {
        expect(exitRefusalText(6021)).toContain('backstop pool');
        expect(exitRefusalText(6028)).toContain('0.1%');
    });

    it('names the code of a refusal it has no sentence for', () => {
        expect(exitRefusalText(6003)).toContain('6003');
        expect(exitRefusalText(6003)).toContain('Nothing has been moved');
    });
});

describe('driftPpm', () => {
    it('measures what arrived against what was quoted, in parts per million', () => {
        expect(driftPpm(1_000_000n, 1_000_100n)).toBe(100n);
        expect(driftPpm(1_000_000n, 999_000n)).toBe(-1_000n);
        expect(driftPpm(1_000_000n, 1_000_000n)).toBe(0n);
    });

    it('is nothing against a quote of nothing', () => {
        expect(driftPpm(0n, 0n)).toBe(0n);
    });
});
