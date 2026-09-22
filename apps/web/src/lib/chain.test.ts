import {
    type Instrument,
    type RatingRecord,
    RUNG_MONTHS,
    SCALE_VERSION,
    instrumentSchema,
    proposeLadder,
    ratingRecordSchema,
    rungTargetTs,
    vaultSchema,
} from '@bondladder/shared';
import { describe, expect, it } from 'vitest';
import {
    catalogueCandidates,
    chartDomain,
    joinCatalogue,
    ratingAxis,
    termSheet,
    tokenAmountFrom,
    vaultRefusal,
} from './chain';
import { maturityDate } from './format';

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
        RUNG_MONTHS.map((_, index) =>
            rating({ instrumentMint: mintAt(index), notch: index + 1 }),
        ),
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
