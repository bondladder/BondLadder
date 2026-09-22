import { useState } from 'react';
import { Link } from 'react-router-dom';
import { usdc } from '@/lib/format';
import { POSITION, REDEMPTION, REDEMPTION_FULL, REDEMPTION_PRESETS, type RedemptionQuote } from '@/lib/source';

/**
 * Figures are looked up, never derived from a rate. The four preset marks are
 * given verbatim; any other size on the slider is read off the 100% row in the
 * same proportions.
 */
function quoteFor(percent: number): RedemptionQuote {
    const preset = REDEMPTION_PRESETS.find((p) => p.percent === percent);
    if (preset) return preset;

    const full = REDEMPTION_FULL;
    const share = percent / 100;
    const value = Math.round(full.positionValueNumber * share * 100) / 100;
    const spread = Math.round(full.spreadNumber * share * 100) / 100;
    const receive = Math.round((value - spread) * 100) / 100;

    return {
        percent,
        positionValue: usdc(value),
        positionValueNumber: value,
        spread: usdc(spread),
        spreadNumber: spread,
        receive: usdc(receive),
        receiveNumber: receive,
        remainderEach: usdc(Math.round(200 * (1 - share) * 100) / 100),
    };
}

export default function Redemption() {
    const [percent, setPercent] = useState<number>(100);
    const [poolText, setPoolText] = useState<string>('1200.00');
    const [settled, setSettled] = useState<boolean>(false);

    const quote = quoteFor(percent);

    const parsedPool = Number.parseFloat(poolText);
    const poolFree = Number.isFinite(parsedPool) ? parsedPool : 0;
    const poolShort = quote.receiveNumber > poolFree;

    const changeSize = (next: number) => {
        setPercent(next);
        setSettled(false);
    };

    return (
        <div className="space-y-10">
            <section>
                <div className="mb-5 flex flex-wrap items-baseline justify-between gap-3">
                    <h1 className="font-display text-[26px] leading-tight">Redemption</h1>
                    <p className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">
                        Quoted before anything is signed
                    </p>
                </div>
                <p className="max-w-[62ch] text-[14px] leading-relaxed text-ink-muted">
                    Selling the position back before maturity. Choose how much of it to redeem; the quote below is read
                    top to bottom.
                </p>
            </section>

            <section className="border-y border-rule-strong py-6">
                <label htmlFor="size" className="col-label mb-3 block">
                    How much of the position to redeem
                </label>
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-8">
                    <div className="flex items-baseline gap-2">
                        <input
                            id="size"
                            type="number"
                            min={1}
                            max={100}
                            value={percent}
                            onChange={(e) => {
                                const next = Number(e.target.value);
                                if (Number.isFinite(next)) changeSize(Math.min(100, Math.max(1, Math.round(next))));
                            }}
                            className="figure w-20 border-b border-ink bg-transparent pb-1 text-right font-display text-[22px] outline-none focus:border-mark"
                        />
                        <span className="text-[13px] text-ink-muted">%</span>
                    </div>
                    <div className="w-full max-w-lg">
                        <input
                            type="range"
                            className="paper-range"
                            min={1}
                            max={100}
                            step={1}
                            value={percent}
                            onChange={(e) => changeSize(Number(e.target.value))}
                        />
                        <div className="figure mt-1 flex justify-between text-[11px] text-ink-faint">
                            {REDEMPTION_PRESETS.map((p) => (
                                <button
                                    key={p.percent}
                                    type="button"
                                    onClick={() => changeSize(p.percent)}
                                    className="transition-colors duration-200 hover:text-ink"
                                >
                                    {p.percent}%
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            </section>

            {settled ? (
                <section className="max-w-[38rem]">
                    <h2 className="section-heading">Settled</h2>
                    <p className="figure border-b border-rule py-6 font-display text-[20px]">
                        {quote.receive} sent to your wallet
                    </p>
                    <Link
                        to="/history"
                        className="mt-4 inline-block border-b border-rule-strong pb-0.5 text-[13px] text-ink-muted transition-colors duration-200 hover:border-mark hover:text-ink"
                    >
                        Register of events
                    </Link>
                </section>
            ) : poolShort ? (
                <section className="max-w-[46rem]">
                    <h2 className="section-heading">Not available</h2>
                    <p className="border-b border-rule py-6 text-[15px] leading-relaxed">
                        Instant redemption unavailable. The pool holds {usdc(poolFree)} free, less than the{' '}
                        {quote.receive} this redemption needs. Nothing has been charged. The next maturity,{' '}
                        {REDEMPTION.nextMaturityDate}, frees {REDEMPTION.nextMaturityFrees}.
                    </p>
                </section>
            ) : (
                <section className="max-w-[38rem]">
                    <h2 className="section-heading">Quote</h2>
                    <dl className="text-[14px]">
                        <div className="flex items-baseline justify-between gap-6 border-b border-rule py-3">
                            <dt className="text-ink-muted">Position value</dt>
                            <dd className="figure">{quote.positionValue}</dd>
                        </div>
                        <div className="flex items-baseline justify-between gap-6 border-b border-rule py-3">
                            <dt className="text-ink-muted">Average remaining term</dt>
                            <dd className="figure">{REDEMPTION.averageRemainingTerm}</dd>
                        </div>
                        <div className="border-b border-rule py-3">
                            <div className="flex items-baseline justify-between gap-6">
                                <dt className="text-ink-muted">Duration spread</dt>
                                <dd className="figure">
                                    <span>− {quote.spread}</span>
                                    <span className="ml-4 text-ink-faint">{REDEMPTION.spreadPercent}</span>
                                </dd>
                            </div>
                            <p className="mt-1 max-w-[48ch] pl-6 text-[12px] leading-relaxed text-ink-faint">
                                {REDEMPTION.spreadNote}
                            </p>
                        </div>
                        <div className="flex items-baseline justify-between gap-6 border-b-[1.5px] border-ink py-3">
                            <dt className="text-[15px]">You receive</dt>
                            <dd className="figure text-[15px]">{quote.receive}</dd>
                        </div>
                    </dl>

                    {percent < 100 && (
                        <p className="figure mt-3 max-w-[56ch] text-[12px] leading-relaxed text-ink-muted">
                            The remainder stays a position in the same proportions — at {percent}%,{' '}
                            {quote.remainderEach} against each of the five maturities.
                        </p>
                    )}

                    <button
                        type="button"
                        onClick={() => setSettled(true)}
                        className="mt-6 border border-ink bg-ink px-7 py-2.5 text-[13px] tracking-wide text-paper transition-opacity duration-200 hover:opacity-85"
                    >
                        Redeem
                    </button>
                </section>
            )}

            <section className="pt-2">
                <Link
                    to="/position"
                    className="border-b border-rule-strong pb-0.5 text-[13px] text-ink-muted transition-colors duration-200 hover:border-mark hover:text-ink"
                >
                    Back to the statement, opened {POSITION.openedOn}
                </Link>
            </section>

            {/* Demo controls */}
            <section className="border-t border-rule-strong pt-5">
                <h2 className="col-label mb-4">Demo controls</h2>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-baseline sm:gap-8">
                    <label htmlFor="pool" className="w-56 shrink-0 text-[13px] text-ink-muted">
                        Backstop pool, free USDC
                    </label>
                    <input
                        id="pool"
                        type="number"
                        step="0.01"
                        inputMode="decimal"
                        value={poolText}
                        onChange={(e) => {
                            setPoolText(e.target.value);
                            setSettled(false);
                        }}
                        className="figure w-40 border-b border-rule-strong bg-transparent pb-1 text-right text-[14px] outline-none focus:border-mark"
                    />
                    <span className="figure text-[11px] text-ink-faint">This redemption needs {quote.receive}</span>
                </div>
            </section>
        </div>
    );
}
