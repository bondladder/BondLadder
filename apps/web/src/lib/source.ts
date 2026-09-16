/**
 * BondLadder — the boundary the screens read through.
 *
 * `LadderSource` is what the four screens need; `mockSource` is the one
 * implementation of it that exists today. Switching the app to the chain is
 * meant to be the re-export below pointing at an RPC module instead, and
 * nothing else — so no screen may import `mockSource` directly.
 *
 * The shapes live here rather than beside the data on purpose: the contract
 * belongs to whoever consumes it. A future RPC module has to satisfy this
 * file, not the mock.
 */

/* ------------------------------------------------------------------ */
/* Shapes                                                              */
/* ------------------------------------------------------------------ */

export type TermKey = 'm3' | 'm6' | 'm9' | 'm12' | 'm18';

export type ProfileKey = 'conservative' | 'balanced';

export interface Issuer {
    name: string;
    ratingValue: number;
    source: 'MOODYS' | 'FITCH' | 'SPGLOBAL';
    coupon: string;
    maturities: Record<TermKey, string>;
}

/** One mark on the credit map. */
export interface Bond {
    id: string;
    issuer: string;
    ratingValue: number;
    source: string;
    coupon: string;
    maturity: string;
    term: string;
}

export interface Profile {
    key: ProfileKey;
    name: string;
    floorValue: number;
    maxIssuerShare: string;
}

export interface Holding {
    issuer: string;
    ratingValue: number;
    source: string;
    maturity: string;
    term: string;
    /** Share of the deposit, fixed at one fifth per maturity. */
    amount: number;
    share: string;
    coupon: string;
    couponNumber: number;
}

export interface Sheet {
    /** Rating floor this sheet was built against. */
    floorValue: number;
    holdings: Holding[];
    couponTotal: number;
    weightedRating: string;
    issuerNote: string;
}

export interface HeldRow {
    issuer: string;
    ratingValue: number;
    maturity: string;
    daysRemaining: string;
    amount: string;
    accrued: string;
}

export interface RedemptionQuote {
    percent: number;
    positionValue: string;
    positionValueNumber: number;
    spread: string;
    spreadNumber: number;
    receive: string;
    receiveNumber: number;
    /** Remaining amount held against each of the five maturities. */
    remainderEach: string;
}

export interface RegisterEntry {
    date: string;
    event: string;
    description: string;
    amount: string;
    illustration?: 'rating-breach';
}

export interface DepositLimits {
    defaultAmount: number;
    minimum: number;
    minimumLabel: string;
    maximum: number;
    maximumLabel: string;
    walletBalance: string;
}

export interface Refusals {
    belowMinimum: string;
    aboveMaximum: string;
}

export interface PositionSummary {
    valueLabel: string;
    valueNumber: number;
    openedOn: string;
    readOn: string;
    daysHeld: number;
    profileName: string;
    floorValue: number;
    weightedRating: string;
    averageRemainingTerm: string;
    nextMaturity: string;
}

export interface ReconciliationLine {
    label: string;
    figure: string;
    note?: string;
}

export interface Reconciliation {
    deposited: ReconciliationLine;
    coupon: ReconciliationLine;
    fee: ReconciliationLine;
    value: ReconciliationLine;
}

export interface RedemptionTerms {
    spreadPercent: string;
    averageRemainingTerm: string;
    spreadNote: string;
    poolDefault: number;
    nextMaturityDate: string;
    nextMaturityFrees: string;
}

/** A holding drawn on the miniature map beside the rating-breach entry. */
export interface BreachMark {
    id: string;
    issuer: string;
    ratingValue: number;
    maturity: string;
}

/* ------------------------------------------------------------------ */
/* The contract                                                        */
/* ------------------------------------------------------------------ */

/**
 * Everything the screens read, and nothing else. Anything a source exports
 * beyond this is its own business and no screen may reach for it.
 */
export interface LadderSource {
    /* Catalogue and rating scale */
    BONDS: Bond[];
    AXIS_GRADE_VALUES: number[];
    RATING_MIN: number;
    RATING_MAX: number;
    gradeLabel(value: number): string;
    bondId(issuer: string, maturity: string): string;
    eligibleIssuers(floorValue: number): Issuer[];

    /* Composing a position */
    PROFILES: Record<ProfileKey, Profile>;
    PROFILE_ORDER: ProfileKey[];
    DEPOSIT: DepositLimits;
    REFUSALS: Refusals;
    sheetForFloor(floorValue: number, profile: ProfileKey): Sheet | null;
    tooFewIssuersRefusal(floorValue: number): string;

    /* The held position */
    POSITION: PositionSummary;
    HELD_ROWS: HeldRow[];
    RECONCILIATION: Reconciliation;
    /** The sheet behind the held position — mock and chain alike. */
    SHEET_CONSERVATIVE: Sheet;

    /* Redemption */
    REDEMPTION: RedemptionTerms;
    REDEMPTION_FULL: RedemptionQuote;
    REDEMPTION_PRESETS: RedemptionQuote[];

    /* Register of events */
    REGISTER: RegisterEntry[];
    REGISTER_PREAMBLE: string;
    BREACH_MARKS: BreachMark[];
    BREACH_FLOOR_VALUE: number;

    /* Chrome */
    BANNER: string;
    BALANCE_CHIP: string;
    CHART_X_MIN: string;
    CHART_X_MAX: string;
    CHART_X_TICKS: string[];
}

/* ------------------------------------------------------------------ */
/* The implementation in use                                           */
/* ------------------------------------------------------------------ */

export * from './mockSource';

/**
 * Compile-time proof that the module above covers the contract. A plain
 * conditional type would quietly collapse to `never`; this one refuses to
 * type-check, which is the point.
 */
type Implements<T extends LadderSource> = T;
type _Contract = Implements<typeof import('./mockSource')>;
