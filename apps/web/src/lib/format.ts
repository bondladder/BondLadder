/**
 * Turning chain values into what a screen prints.
 *
 * The chain speaks in micro-USDC, unix seconds, basis points and rating
 * notches; none of those belong in a table cell. This is the only place that
 * translates, so the RPC source can stay numbers all the way (T027) and the
 * mock's ready-made strings can retire screen by screen.
 */

import { labelForNotch } from '@bondladder/shared';

const MICRO_PER_USDC = 1_000_000n;
const MICRO_DIGITS = 6;
const MINIMUM_DECIMALS = 2;

const TRIM_TO_MINIMUM = new RegExp(`(\\d{${MINIMUM_DECIMALS}})(\\d*?)0*$`);

/**
 * `1,000.00 USDC`, `199.199363 USDC`, `0.000001 USDC`.
 *
 * Never rounds. This figure is read before a signature and reconciled against
 * what the program recorded afterwards, so a cent rounded up would be a
 * discrepancy about money — two decimals is a floor on what is shown, not a
 * cap on precision.
 */
export function usdcFromMicro(micro: bigint): string {
    const negative = micro < 0n;
    const absolute = negative ? -micro : micro;
    const fraction = (absolute % MICRO_PER_USDC)
        .toString()
        .padStart(MICRO_DIGITS, '0')
        .replace(TRIM_TO_MINIMUM, '$1$2');

    const whole = (absolute / MICRO_PER_USDC).toLocaleString('en-US');

    return `${negative ? '−' : ''}${whole}.${fraction} USDC`;
}

const AMOUNT = /^(\d+)(?:\.(\d{1,6}))?$/;

/**
 * The typed amount, in micro-USDC, or `null` when it is not an amount.
 *
 * Deliberately not `Number`: `1000.000001` does not survive a float, and the
 * figure parsed here is the one the wallet is asked to sign for. More decimals
 * than USDC carries is refused rather than rounded — rounding would move a
 * different sum than the one on screen.
 */
export function microFromUsdc(text: string): bigint | null {
    const match = AMOUNT.exec(text.trim().replaceAll(',', ''));
    if (match === null) {
        return null;
    }

    const [, whole = '0', fraction = ''] = match;

    return BigInt(whole) * MICRO_PER_USDC + BigInt(fraction.padEnd(MICRO_DIGITS, '0'));
}

/** `2026-12-03` — the day in UTC, because the maturity is a chain timestamp. */
export function maturityDate(unixSeconds: bigint): string {
    return new Date(Number(unixSeconds) * 1000).toISOString().slice(0, 10);
}

/**
 * `A- (7)` — always both. A notch the scale does not know is printed bare:
 * the record then comes from a scale this build cannot read, and naming a
 * grade for it would invent credit quality.
 */
export function notchLabel(notch: number): string {
    const label = labelForNotch(notch);

    return label === null ? `(${notch})` : `${label} (${notch})`;
}

/** `AA- (4.2)` — a weighted average, named by the notch it sits nearest. */
export function weightedNotchLabel(average: number): string {
    const label = labelForNotch(Math.round(average));
    const figure = average.toFixed(1);

    return label === null ? `(${figure})` : `${label} (${figure})`;
}

export function percentFromBps(bps: number): string {
    return `${(bps / 100).toFixed(2)}%`;
}

export function termLabel(months: number): string {
    return `${months} months`;
}

/** Amount formatting: `1,004.35 USDC` — two decimals, thousands separator, always the unit. */
export function usdc(value: number): string {
    return `${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC`;
}

/** Plain number with two decimals and a thousands separator, no unit. */
export function amount(value: number): string {
    return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const SECONDS_PER_DAY = 86_400n;

/**
 * `48 days`, `1 day`, `less than a day`.
 *
 * Whole days, floored. A rung maturing in nineteen hours has not matured, and
 * `0 days` beside it would read as if it had.
 */
export function dayCount(seconds: bigint): string {
    const days = seconds / SECONDS_PER_DAY;

    if (days === 0n) {
        return 'less than a day';
    }

    return `${days.toLocaleString('en-US')} ${days === 1n ? 'day' : 'days'}`;
}

/** `+ 4.35 USDC`, `− 0.62 USDC` — on a reconciliation line the sign is the point. */
export function signedUsdcFromMicro(micro: bigint): string {
    if (micro === 0n) {
        return usdcFromMicro(0n);
    }

    return `${micro < 0n ? '−' : '+'} ${usdcFromMicro(micro < 0n ? -micro : micro)}`;
}
