/**
 * BondLadder — single source of mock data.
 *
 * Every figure rendered anywhere in the app comes from this file, verbatim.
 * Nothing here is derived at runtime from rates or day counts: the string
 * labels are the authority, the numbers alongside them exist only so the
 * interface can scale a deposit that is not exactly 1,000.00 USDC.
 *
 * No network, no wallet, no chain. Illustrative figures only.
 */

import type {
    Bond,
    HeldRow,
    Issuer,
    Profile,
    ProfileKey,
    RedemptionQuote,
    RegisterEntry,
    Sheet,
    TermKey,
} from './source';

/* ------------------------------------------------------------------ */
/* Rating scale                                                        */
/* ------------------------------------------------------------------ */

export interface Grade {
    value: number;
    label: string;
}

/** The full notch scale. The product rests on ratings being comparable numbers. */
export const RATING_SCALE: Grade[] = [
    { value: 1, label: 'AAA' },
    { value: 2, label: 'AA+' },
    { value: 3, label: 'AA' },
    { value: 4, label: 'AA-' },
    { value: 5, label: 'A+' },
    { value: 6, label: 'A' },
    { value: 7, label: 'A-' },
    { value: 8, label: 'BBB+' },
    { value: 9, label: 'BBB' },
    { value: 10, label: 'BBB-' },
    { value: 11, label: 'BB+' },
];

/** Grades printed on the credit map's Y axis. */
export const AXIS_GRADE_VALUES = [1, 3, 4, 5, 6, 7, 8, 10, 11];

export const RATING_MIN = 1;
export const RATING_MAX = 11;

export function gradeName(value: number): string {
    const found = RATING_SCALE.find((g) => g.value === value);
    return found ? found.label : 'BB+';
}

/** `A- (7)` — always both. */
export function gradeLabel(value: number): string {
    return `${gradeName(value)} (${value})`;
}

/** `AA- (4.2)` — weighted average, name taken from the nearest notch. */
export function weightedGradeLabel(average: number): string {
    return `${gradeName(Math.round(average))} (${average.toFixed(1)})`;
}

/* ------------------------------------------------------------------ */
/* Maturity points                                                     */
/* ------------------------------------------------------------------ */

export interface Term {
    key: TermKey;
    label: string;
}

export const TERMS: Term[] = [
    { key: 'm3', label: '3 months' },
    { key: 'm6', label: '6 months' },
    { key: 'm9', label: '9 months' },
    { key: 'm12', label: '12 months' },
    { key: 'm18', label: '18 months' },
];

/* ------------------------------------------------------------------ */
/* The catalogue — nine invented issuers, five maturities each         */
/* ------------------------------------------------------------------ */

export const CATALOGUE: Issuer[] = [
    {
        name: 'HELVETIA-RE',
        ratingValue: 1,
        source: 'MOODYS',
        coupon: '3.20%',
        maturities: { m3: '2026-11-25', m6: '2027-02-25', m9: '2027-05-27', m12: '2027-08-26', m18: '2028-02-25' },
    },
    {
        name: 'NORDLYS-ENERGI',
        ratingValue: 3,
        source: 'FITCH',
        coupon: '3.65%',
        maturities: { m3: '2026-11-28', m6: '2027-02-28', m9: '2027-05-30', m12: '2027-08-29', m18: '2028-02-28' },
    },
    {
        name: 'KESTREL-RAIL',
        ratingValue: 4,
        source: 'MOODYS',
        coupon: '3.95%',
        maturities: { m3: '2026-12-03', m6: '2027-03-05', m9: '2027-06-04', m12: '2027-09-03', m18: '2028-03-04' },
    },
    {
        name: 'ATLAS-MARITIME',
        ratingValue: 5,
        source: 'FITCH',
        coupon: '4.60%',
        maturities: { m3: '2026-11-22', m6: '2027-02-22', m9: '2027-05-24', m12: '2027-08-23', m18: '2028-02-22' },
    },
    {
        name: 'CALDERA-WATER',
        ratingValue: 6,
        source: 'SPGLOBAL',
        coupon: '4.30%',
        maturities: { m3: '2026-12-06', m6: '2027-03-08', m9: '2027-06-07', m12: '2027-09-06', m18: '2028-03-07' },
    },
    {
        name: 'VERDANT-AGRI',
        ratingValue: 7,
        source: 'SPGLOBAL',
        coupon: '5.05%',
        maturities: { m3: '2026-12-09', m6: '2027-03-11', m9: '2027-06-10', m12: '2027-09-09', m18: '2028-03-10' },
    },
    {
        name: 'ORICON-LOGISTICS',
        ratingValue: 8,
        source: 'MOODYS',
        coupon: '6.10%',
        maturities: { m3: '2026-12-12', m6: '2027-03-14', m9: '2027-06-13', m12: '2027-09-12', m18: '2028-03-13' },
    },
    {
        name: 'SABLE-TEXTILES',
        ratingValue: 10,
        source: 'FITCH',
        coupon: '7.25%',
        maturities: { m3: '2026-11-19', m6: '2027-02-19', m9: '2027-05-21', m12: '2027-08-20', m18: '2028-02-19' },
    },
    {
        name: 'RUBICON-LEISURE',
        ratingValue: 11,
        source: 'SPGLOBAL',
        coupon: '9.40%',
        maturities: { m3: '2026-12-15', m6: '2027-03-17', m9: '2027-06-16', m12: '2027-09-15', m18: '2028-03-16' },
    },
];

/** Every mark on the credit map. */
export const BONDS: Bond[] = CATALOGUE.flatMap((issuer) =>
    TERMS.map((term) => ({
        id: `${issuer.name}-${term.key}`,
        issuer: issuer.name,
        ratingValue: issuer.ratingValue,
        source: issuer.source,
        coupon: issuer.coupon,
        maturity: issuer.maturities[term.key],
        term: term.label,
    })),
);

export function bondId(issuer: string, maturity: string): string {
    const found = BONDS.find((b) => b.issuer === issuer && b.maturity === maturity);
    return found ? found.id : `${issuer}-${maturity}`;
}

/* ------------------------------------------------------------------ */
/* Profiles                                                            */
/* ------------------------------------------------------------------ */

export const PROFILES: Record<ProfileKey, Profile> = {
    conservative: { key: 'conservative', name: 'Conservative', floorValue: 7, maxIssuerShare: '20%' },
    balanced: { key: 'balanced', name: 'Balanced', floorValue: 10, maxIssuerShare: '40%' },
};

export const PROFILE_ORDER: ProfileKey[] = ['conservative', 'balanced'];

/* ------------------------------------------------------------------ */
/* Term sheets — figures given verbatim for a 1,000.00 USDC deposit    */
/* ------------------------------------------------------------------ */

export const SHEET_CONSERVATIVE: Sheet = {
    floorValue: 7,
    holdings: [
        { issuer: 'KESTREL-RAIL', ratingValue: 4, source: 'MOODYS', maturity: '2026-12-03', term: '3 months', amount: 200, share: '20%', coupon: '2.01 USDC', couponNumber: 2.01 },
        { issuer: 'NORDLYS-ENERGI', ratingValue: 3, source: 'FITCH', maturity: '2027-02-28', term: '6 months', amount: 200, share: '20%', coupon: '3.60 USDC', couponNumber: 3.6 },
        { issuer: 'CALDERA-WATER', ratingValue: 6, source: 'SPGLOBAL', maturity: '2027-06-07', term: '9 months', amount: 200, share: '20%', coupon: '6.57 USDC', couponNumber: 6.57 },
        { issuer: 'HELVETIA-RE', ratingValue: 1, source: 'MOODYS', maturity: '2027-08-26', term: '12 months', amount: 200, share: '20%', coupon: '6.29 USDC', couponNumber: 6.29 },
        { issuer: 'VERDANT-AGRI', ratingValue: 7, source: 'SPGLOBAL', maturity: '2028-03-10', term: '18 months', amount: 200, share: '20%', coupon: '15.39 USDC', couponNumber: 15.39 },
    ],
    couponTotal: 33.86,
    weightedRating: 'AA- (4.2)',
    issuerNote: 'Five issuers, none above 20%',
};

export const SHEET_BALANCED: Sheet = {
    floorValue: 10,
    holdings: [
        { issuer: 'KESTREL-RAIL', ratingValue: 4, source: 'MOODYS', maturity: '2026-12-03', term: '3 months', amount: 200, share: '20%', coupon: '2.01 USDC', couponNumber: 2.01 },
        { issuer: 'SABLE-TEXTILES', ratingValue: 10, source: 'FITCH', maturity: '2027-02-19', term: '6 months', amount: 200, share: '20%', coupon: '6.79 USDC', couponNumber: 6.79 },
        { issuer: 'CALDERA-WATER', ratingValue: 6, source: 'SPGLOBAL', maturity: '2027-06-07', term: '9 months', amount: 200, share: '20%', coupon: '6.57 USDC', couponNumber: 6.57 },
        { issuer: 'ORICON-LOGISTICS', ratingValue: 8, source: 'MOODYS', maturity: '2027-09-12', term: '12 months', amount: 200, share: '20%', coupon: '12.57 USDC', couponNumber: 12.57 },
        { issuer: 'VERDANT-AGRI', ratingValue: 7, source: 'SPGLOBAL', maturity: '2028-03-10', term: '18 months', amount: 200, share: '20%', coupon: '15.39 USDC', couponNumber: 15.39 },
    ],
    couponTotal: 43.33,
    weightedRating: 'A- (7.0)',
    issuerNote: 'Five issuers, none above 20%',
};

/**
 * Built when the demo floor is dragged to A (6): exactly five issuers remain
 * eligible, so the position still builds, one issuer per maturity.
 */
export const SHEET_FLOOR_A: Sheet = {
    floorValue: 6,
    holdings: [
        { issuer: 'KESTREL-RAIL', ratingValue: 4, source: 'MOODYS', maturity: '2026-12-03', term: '3 months', amount: 200, share: '20%', coupon: '2.01 USDC', couponNumber: 2.01 },
        { issuer: 'NORDLYS-ENERGI', ratingValue: 3, source: 'FITCH', maturity: '2027-02-28', term: '6 months', amount: 200, share: '20%', coupon: '3.60 USDC', couponNumber: 3.6 },
        { issuer: 'CALDERA-WATER', ratingValue: 6, source: 'SPGLOBAL', maturity: '2027-06-07', term: '9 months', amount: 200, share: '20%', coupon: '6.57 USDC', couponNumber: 6.57 },
        { issuer: 'HELVETIA-RE', ratingValue: 1, source: 'MOODYS', maturity: '2027-08-26', term: '12 months', amount: 200, share: '20%', coupon: '6.29 USDC', couponNumber: 6.29 },
        { issuer: 'ATLAS-MARITIME', ratingValue: 5, source: 'FITCH', maturity: '2028-02-22', term: '18 months', amount: 200, share: '20%', coupon: '13.61 USDC', couponNumber: 13.61 },
    ],
    couponTotal: 32.08,
    weightedRating: 'AA- (3.8)',
    issuerNote: 'Five issuers, none above 20%',
};

/**
 * Which sheet the composer builds for a given floor.
 * Below A (6) fewer than five issuers remain and no position is opened.
 */
export function sheetForFloor(floorValue: number, profile: ProfileKey): Sheet | null {
    if (floorValue <= 5) return null;
    if (floorValue === 6) return SHEET_FLOOR_A;
    if (floorValue >= PROFILES[profile].floorValue) {
        return profile === 'balanced' ? SHEET_BALANCED : SHEET_CONSERVATIVE;
    }
    return SHEET_CONSERVATIVE;
}

/** Issuers whose rating sits at or above the floor. */
export function eligibleIssuers(floorValue: number): Issuer[] {
    return CATALOGUE.filter((i) => i.ratingValue <= floorValue);
}

/* ------------------------------------------------------------------ */
/* Deposit limits                                                      */
/* ------------------------------------------------------------------ */

export const DEPOSIT = {
    defaultAmount: 1000,
    minimum: 100,
    minimumLabel: '100.00 USDC',
    maximum: 10000,
    maximumLabel: '10,000.00 USDC',
    walletBalance: 'Wallet balance 2,500.00 USDC',
};

export const REFUSALS = {
    belowMinimum: 'Minimum deposit is 100.00 USDC. Nothing has been moved.',
    aboveMaximum: 'This vault is holding 10,000.00 USDC and cannot take more. Nothing has been moved.',
};

const COUNT_WORDS = ['no', 'one', 'two', 'three', 'four'];

export function tooFewIssuersRefusal(floorValue: number): string {
    const count = eligibleIssuers(floorValue).length;
    const word = COUNT_WORDS[count] ?? String(count);
    const noun = count === 1 ? 'issuer meets' : 'issuers meet';
    return `Only ${word} ${noun} a floor of ${gradeLabel(floorValue)}. A position needs five, one per maturity, and is never opened partially. Nothing has been moved.`;
}

/* ------------------------------------------------------------------ */
/* Screen 2 — the held position                                        */
/* ------------------------------------------------------------------ */

export const POSITION = {
    valueLabel: '1,004.35 USDC',
    valueNumber: 1004.35,
    openedOn: '2026-09-01',
    readOn: '2026-10-16',
    daysHeld: 45,
    profileName: 'Conservative',
    floorValue: 7,
    weightedRating: 'AA- (4.2)',
    averageRemainingTerm: '0.68 years',
    nextMaturity: '2026-12-03 · KESTREL-RAIL · 200.00 USDC',
};

export const HELD_ROWS: HeldRow[] = [
    { issuer: 'KESTREL-RAIL', ratingValue: 4, maturity: '2026-12-03', daysRemaining: '48', amount: '200.00 USDC', accrued: '0.97 USDC' },
    { issuer: 'NORDLYS-ENERGI', ratingValue: 3, maturity: '2027-02-28', daysRemaining: '135', amount: '200.00 USDC', accrued: '0.90 USDC' },
    { issuer: 'CALDERA-WATER', ratingValue: 6, maturity: '2027-06-07', daysRemaining: '234', amount: '200.00 USDC', accrued: '1.06 USDC' },
    { issuer: 'HELVETIA-RE', ratingValue: 1, maturity: '2027-08-26', daysRemaining: '314', amount: '200.00 USDC', accrued: '0.79 USDC' },
    { issuer: 'VERDANT-AGRI', ratingValue: 7, maturity: '2028-03-10', daysRemaining: '511', amount: '200.00 USDC', accrued: '1.25 USDC' },
];

export const RECONCILIATION = {
    deposited: { label: 'Deposited', figure: '1,000.00 USDC' },
    coupon: { label: 'Coupon accrued', figure: '+ 4.97 USDC' },
    fee: {
        label: 'Management fee accrued',
        figure: '− 0.62 USDC',
        note: '0.5% per year, charged on the next operation, not yet taken',
    },
    value: { label: 'Position value', figure: '1,004.35 USDC' },
};

/* ------------------------------------------------------------------ */
/* Screen 3 — redemption                                               */
/* ------------------------------------------------------------------ */

/** The 100% row: every off-preset size on the slider is scaled from it. */
export const REDEMPTION_FULL: RedemptionQuote = {
    percent: 100, positionValue: '1,004.35 USDC', positionValueNumber: 1004.35, spread: '13.66 USDC', spreadNumber: 13.66, receive: '990.69 USDC', receiveNumber: 990.69, remainderEach: '0.00 USDC',
};

export const REDEMPTION_PRESETS: RedemptionQuote[] = [
    { percent: 25, positionValue: '251.09 USDC', positionValueNumber: 251.09, spread: '3.41 USDC', spreadNumber: 3.41, receive: '247.68 USDC', receiveNumber: 247.68, remainderEach: '150.00 USDC' },
    { percent: 50, positionValue: '502.18 USDC', positionValueNumber: 502.18, spread: '6.83 USDC', spreadNumber: 6.83, receive: '495.35 USDC', receiveNumber: 495.35, remainderEach: '100.00 USDC' },
    { percent: 75, positionValue: '753.26 USDC', positionValueNumber: 753.26, spread: '10.24 USDC', spreadNumber: 10.24, receive: '743.02 USDC', receiveNumber: 743.02, remainderEach: '50.00 USDC' },
    REDEMPTION_FULL,
];

export const REDEMPTION = {
    spreadPercent: '1.36%',
    averageRemainingTerm: '0.68 years',
    spreadNote:
        'You are asking the pool to hold your bonds to maturity. The spread pays for that wait, and shrinks as the bonds mature.',
    poolDefault: 1200,
    nextMaturityDate: '2026-12-03',
    nextMaturityFrees: '202.01 USDC',
};

/* ------------------------------------------------------------------ */
/* Screen 4 — register of events                                       */
/* ------------------------------------------------------------------ */

export const REGISTER: RegisterEntry[] = [
    {
        date: '2026-12-30',
        event: 'Rating breach',
        description:
            'VERDANT-AGRI downgraded A- (7) → BBB+ (8), one notch below the Conservative floor. Marked for exit; no further funds will be routed into it.',
        amount: '—',
        illustration: 'rating-breach',
    },
    {
        date: '2026-12-03',
        event: 'Maintenance reward',
        description: 'Paid to whoever triggered the roll.',
        amount: '0.20 USDC',
    },
    {
        date: '2026-12-03',
        event: 'Fee charged',
        description: 'Management fee accrued over 93 days, settled during the roll.',
        amount: '1.27 USDC',
    },
    {
        date: '2026-12-03',
        event: 'Maturity rolled',
        description:
            'KESTREL-RAIL matured. Principal and coupon reinvested at the 18-month point: ATLAS-MARITIME, A+ (5), maturing 2028-05-25.',
        amount: '202.01 USDC',
    },
    {
        date: '2026-09-01',
        event: 'Position opened',
        description: 'Conservative, five maturities, 200.00 USDC against each.',
        amount: '1,000.00 USDC',
    },
];

/**
 * The miniature credit map printed beside the rating-breach entry: the same
 * five holdings, with VERDANT-AGRI shown one notch below the Conservative floor.
 */
export const BREACH_MARKS = SHEET_CONSERVATIVE.holdings.map((h) => ({
    id: bondId(h.issuer, h.maturity),
    issuer: h.issuer,
    ratingValue: h.issuer === 'VERDANT-AGRI' ? 8 : h.ratingValue,
    maturity: h.maturity,
}));

export const BREACH_FLOOR_VALUE = 7;

export const REGISTER_PREAMBLE =
    'Maintenance needs no permission and no privileged key — anyone may trigger it, and whoever does earns a small part of the amount serviced.';

/* ------------------------------------------------------------------ */
/* Chrome                                                              */
/* ------------------------------------------------------------------ */

/** Credit map horizontal domain. */
export const CHART_X_MIN = '2026-09-01';
export const CHART_X_MAX = '2028-04-01';

export const CHART_X_TICKS = ['2026-12-01', '2027-03-01', '2027-06-01', '2027-09-01', '2027-12-01', '2028-03-01'];
