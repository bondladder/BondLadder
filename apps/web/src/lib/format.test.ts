import { describe, expect, it } from 'vitest';
import {
    maturityDate,
    microFromUsdc,
    notchLabel,
    percentFromBps,
    termLabel,
    usdc,
    usdcFromMicro,
    weightedNotchLabel,
} from './format';

describe('usdcFromMicro', () => {
    it('prints a round figure with two decimals', () => {
        expect(usdcFromMicro(1_000_000_000n)).toBe('1,000.00 USDC');
        expect(usdcFromMicro(200_000_000n)).toBe('200.00 USDC');
        expect(usdcFromMicro(0n)).toBe('0.00 USDC');
    });

    // The screen is read before a signature, so a figure is never rounded up to
    // something the chain will not move: every micro-unit that exists is shown.
    it('keeps every micro-unit the chain would move', () => {
        expect(usdcFromMicro(199_199_363n)).toBe('199.199363 USDC');
        expect(usdcFromMicro(800_637n)).toBe('0.800637 USDC');
        expect(usdcFromMicro(1n)).toBe('0.000001 USDC');
    });

    it('trims trailing zeros no further than two decimals', () => {
        expect(usdcFromMicro(1_500_000n)).toBe('1.50 USDC');
        expect(usdcFromMicro(1_050_000n)).toBe('1.05 USDC');
        expect(usdcFromMicro(1_005_000n)).toBe('1.005 USDC');
    });

    it('separates thousands', () => {
        expect(usdcFromMicro(1_234_567_891_000n)).toBe('1,234,567.891 USDC');
    });
});

describe('maturityDate', () => {
    it('prints the day in UTC, never the reader’s timezone', () => {
        expect(maturityDate(1_764_720_000n)).toBe('2025-12-03');
        expect(maturityDate(0n)).toBe('1970-01-01');
    });

    it('does not roll the day over at the end of a UTC day', () => {
        expect(maturityDate(1_764_806_399n)).toBe('2025-12-03');
        expect(maturityDate(1_764_806_400n)).toBe('2025-12-04');
    });
});

describe('notchLabel', () => {
    it('always prints both the grade and the number', () => {
        expect(notchLabel(1)).toBe('AAA (1)');
        expect(notchLabel(7)).toBe('A- (7)');
        expect(notchLabel(22)).toBe('D (22)');
    });

    // A notch the scale does not know means the record came from a newer scale
    // version; inventing a grade for it would be a lie about credit quality.
    it('prints the bare number for a notch off the scale', () => {
        expect(notchLabel(0)).toBe('(0)');
        expect(notchLabel(23)).toBe('(23)');
    });
});

describe('weightedNotchLabel', () => {
    it('names the average by its nearest notch', () => {
        expect(weightedNotchLabel(4.2)).toBe('AA- (4.2)');
        expect(weightedNotchLabel(7)).toBe('A- (7.0)');
        expect(weightedNotchLabel(6.5)).toBe('A- (6.5)');
    });
});

describe('percentFromBps', () => {
    it('prints basis points as a percentage', () => {
        expect(percentFromBps(395)).toBe('3.95%');
        expect(percentFromBps(50)).toBe('0.50%');
        expect(percentFromBps(10_000)).toBe('100.00%');
        expect(percentFromBps(0)).toBe('0.00%');
    });
});

describe('termLabel', () => {
    it('names the rung by its months', () => {
        expect(termLabel(3)).toBe('3 months');
        expect(termLabel(18)).toBe('18 months');
    });
});

describe('usdc', () => {
    it('still formats the mock’s plain numbers for the screens on mocks', () => {
        expect(usdc(1004.35)).toBe('1,004.35 USDC');
    });
});

describe('microFromUsdc', () => {
    it('reads a plain amount', () => {
        expect(microFromUsdc('1000')).toBe(1_000_000_000n);
        expect(microFromUsdc('1000.00')).toBe(1_000_000_000n);
        expect(microFromUsdc('0.5')).toBe(500_000n);
        expect(microFromUsdc('0.000001')).toBe(1n);
    });

    it('reads what a person pastes', () => {
        expect(microFromUsdc(' 1,000.00 ')).toBe(1_000_000_000n);
    });

    // Parsing money through Number would round 1000.000001 to something the
    // chain never sees; refusing is the only honest answer to more precision
    // than USDC has.
    it('refuses more precision than the token carries', () => {
        expect(microFromUsdc('1000.0000001')).toBeNull();
    });

    it('refuses anything that is not an amount', () => {
        for (const text of ['', ' ', 'abc', '-5', '1.2.3', '.', '1e6', '1 000']) {
            expect(microFromUsdc(text), text).toBeNull();
        }
    });

    it('round-trips through the formatter', () => {
        for (const micro of [1n, 500_000n, 1_000_000_000n, 199_199_363n]) {
            const printed = usdcFromMicro(micro).replace(' USDC', '');

            expect(microFromUsdc(printed), printed).toBe(micro);
        }
    });
});
