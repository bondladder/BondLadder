import type { RiskProfile } from '@bondladder/shared';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
    dayCount,
    maturityDate,
    percentFromBps,
    signedPercentFromPpm,
    signedUsdcFromMicro,
    solFromLamports,
    termLabel,
    usdcFromMicro,
} from '@/lib/format';
import {
    driftPpm,
    type ExitDesk,
    type ExitQuoteView,
    type ExitReceipt,
    exitPosition,
    explorerTx,
    holdingsToCreate,
    loadExitDesk,
    type PositionStatement,
    QUOTE_TOLERANCE_BPS,
    quoteExit,
} from '@/lib/source';
import { useWallet } from '@/lib/walletContext';

const PROFILE_NAMES: Record<RiskProfile, string> = {
    conservative: 'Conservative',
    balanced: 'Balanced',
};

const PRESETS = [25, 50, 75, 100];

const SECONDS_PER_DAY = 86_400n;

type Submission =
    | { kind: 'idle' }
    | { kind: 'checking' }
    | { kind: 'signing' }
    | { kind: 'confirming' }
    | { kind: 'done'; receipt: ExitReceipt }
    | { kind: 'failed'; reason: string };

const WAITING: Record<'checking' | 'signing' | 'confirming', string> = {
    checking: 'Running the exit against the program before your wallet sees it…',
    signing: 'Waiting for your wallet to sign…',
    confirming: 'Signed. Waiting for the network to confirm…',
};

interface Loaded {
    readonly desk: ExitDesk;
    readonly nowTs: bigint;
}

function reason(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function Nothing({ heading, children }: { heading: string; children: ReactNode }) {
    return (
        <section>
            <h1 className="font-display text-[26px] leading-tight">{heading}</h1>
            <div className="mt-4 max-w-[68ch] space-y-3 text-[15px] leading-relaxed">{children}</div>
        </section>
    );
}

function Line({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
    return (
        <div
            className={[
                'flex items-baseline justify-between gap-6 py-3',
                strong ? 'border-b-[1.5px] border-ink' : 'border-b border-rule',
            ].join(' ')}
        >
            <dt className={strong ? 'text-[15px]' : 'text-ink-muted'}>{label}</dt>
            <dd className={strong ? 'figure whitespace-nowrap text-[15px]' : 'figure whitespace-nowrap'}>{value}</dd>
        </div>
    );
}

function Quote({
    quote,
    statement,
    desk,
    percent,
}: {
    quote: ExitQuoteView;
    statement: PositionStatement;
    desk: ExitDesk;
    percent: number;
}) {
    const { settlement } = quote;
    const spreadShareBps =
        quote.netValueMicro === 0n ? 0 : Number((settlement.spreadMicro * 10_000n) / quote.netValueMicro);
    const created = holdingsToCreate(statement, settlement.units, desk.heldByPool);

    return (
        <>
            <dl className="text-[14px]">
                <Line label="Value at today's prices" value={usdcFromMicro(settlement.grossValueMicro)} />
                <Line
                    label="Management fee due, settled by this exit"
                    value={signedUsdcFromMicro(-settlement.feeChargedMicro)}
                />
                <Line label="Current value, net of the fee" value={usdcFromMicro(quote.netValueMicro)} />
                <Line label="Average remaining term" value={dayCount(settlement.wrdDays * SECONDS_PER_DAY)} />
                <div className="border-b border-rule py-3">
                    <div className="flex items-baseline justify-between gap-6">
                        <dt className="text-ink-muted">Duration spread</dt>
                        <dd className="figure">
                            <span>{signedUsdcFromMicro(-settlement.spreadMicro)}</span>
                            <span className="ml-4 text-ink-faint">{percentFromBps(spreadShareBps)}</span>
                        </dd>
                    </div>
                    <p className="mt-1 max-w-[52ch] pl-6 text-[12px] leading-relaxed text-ink-faint">
                        {percentFromBps(desk.vault.state.spreadCoefBps)} a year of remaining term. The pool holds these
                        instruments to maturity; the spread pays for that wait and shrinks as they mature.
                    </p>
                </div>
                <Line label="You receive" value={usdcFromMicro(settlement.payoutMicro)} strong />
            </dl>

            <div className="mt-3 max-w-[60ch] space-y-2 text-[12px] leading-relaxed text-ink-muted">
                <p className="figure">
                    Signed with a floor of {usdcFromMicro(quote.floorMicro)}, {QUOTE_TOLERANCE_BPS / 100}% under the
                    quote. Should the exit pay less, the program refuses it rather than settle.
                </p>
                {settlement.feeCarriedMicro > 0n && (
                    <p className="figure">
                        This share is worth less than the fee due; {usdcFromMicro(settlement.feeCarriedMicro)} of it
                        stays owed by what remains.
                    </p>
                )}
                {percent < 100 && (
                    <p className="figure">
                        The rest stays a position in the same proportions:{' '}
                        {statement.rows
                            .map(
                                (row, index) =>
                                    `${(row.units - (settlement.units[index] ?? 0n)).toLocaleString('en-US')} units at ${termLabel(row.rungMonths)}`,
                            )
                            .join(', ')}
                        .
                    </p>
                )}
                {created > 0 && (
                    <p className="figure">
                        The pool has no record yet of {created === 1 ? 'one instrument' : `${created} instruments`} this
                        exit hands it; opening {created === 1 ? 'it' : 'them'} costs{' '}
                        {solFromLamports(desk.holdingRentLamports * BigInt(created))} in rent from your wallet.
                    </p>
                )}
            </div>
        </>
    );
}

function Settled({ receipt, onAgain }: { receipt: ExitReceipt; onAgain: () => void }) {
    return (
        <section className="max-w-[38rem]">
            <h2 className="section-heading">Settled</h2>
            <dl className="text-[14px]">
                <Line label="Received in your wallet" value={usdcFromMicro(receipt.receivedMicro)} strong />
                <Line label="Quoted before signing" value={usdcFromMicro(receipt.quotedMicro)} />
                <Line
                    label="Difference"
                    value={signedPercentFromPpm(driftPpm(receipt.quotedMicro, receipt.receivedMicro))}
                />
            </dl>
            <div className="mt-4 flex flex-wrap items-baseline gap-6 text-[13px]">
                <a
                    href={explorerTx(receipt.signature)}
                    target="_blank"
                    rel="noreferrer"
                    className="border-b border-rule-strong pb-0.5 text-ink-muted transition-colors duration-200 hover:border-mark hover:text-ink"
                >
                    The transaction in the explorer
                </a>
                <button
                    type="button"
                    onClick={onAgain}
                    className="border-b border-rule-strong pb-0.5 text-ink-muted transition-colors duration-200 hover:border-mark hover:text-ink"
                >
                    Read the position again
                </button>
            </div>
        </section>
    );
}

export default function Exit() {
    const { connected, sign } = useWallet();
    const [loaded, setLoaded] = useState<Loaded | null>(null);
    const [loadFailure, setLoadFailure] = useState<string | null>(null);
    const [reads, setReads] = useState(0);
    const [shown, setShown] = useState<RiskProfile | null>(null);
    const [percent, setPercent] = useState(100);
    const [submission, setSubmission] = useState<Submission>({ kind: 'idle' });

    // The quote is priced at the moment of the read, so the clock is taken
    // beside it and not on each render.
    useEffect(() => {
        setLoaded(null);
        setLoadFailure(null);
        if (connected === null) {
            return;
        }

        let alive = true;
        const nowTs = BigInt(Math.floor(Date.now() / 1000));
        void reads;

        loadExitDesk(connected.address, nowTs)
            .then((desk) => alive && setLoaded({ desk, nowTs }))
            .catch((failure: unknown) => alive && setLoadFailure(reason(failure)));

        return () => {
            alive = false;
        };
    }, [connected, reads]);

    const statement = useMemo(() => {
        const statements = loaded?.desk.statements ?? [];

        return statements.find((held) => held.profile === shown) ?? statements[0] ?? null;
    }, [loaded, shown]);

    const outcome = useMemo(() => {
        if (loaded === null || statement === null) {
            return null;
        }

        return quoteExit(statement, loaded.desk.vault.state, percent, loaded.nowTs);
    }, [loaded, statement, percent]);

    const changeSize = (next: number) => {
        setPercent(Math.min(100, Math.max(1, Math.round(next))));
        setSubmission({ kind: 'idle' });
    };

    const readAgain = () => {
        setSubmission({ kind: 'idle' });
        setReads((count) => count + 1);
    };

    const submit = useCallback(
        async (desk: ExitDesk, held: PositionStatement, quote: ExitQuoteView) => {
            if (connected === null) {
                return;
            }

            try {
                const receipt = await exitPosition(desk, held, quote, connected.address, sign, (step) =>
                    setSubmission({ kind: step }),
                );
                setSubmission({ kind: 'done', receipt });
            } catch (failure) {
                setSubmission({ kind: 'failed', reason: reason(failure) });
            }
        },
        [connected, sign],
    );

    if (connected === null) {
        return (
            <Nothing heading="No wallet connected">
                <p>
                    Only the wallet that opened a position can redeem it, so there is nothing to quote until one is
                    here.
                </p>
                <p className="text-[13px] text-ink-muted">Connect a wallet in the header.</p>
            </Nothing>
        );
    }

    if (loadFailure !== null) {
        return (
            <Nothing heading="The chain is out of reach">
                <p>{loadFailure}</p>
                <p className="text-[13px] text-ink-muted">
                    Nothing has been moved. The quote is priced from the position, the issuer's prices and the vault,
                    all read from the network.
                </p>
            </Nothing>
        );
    }

    if (loaded === null) {
        return <p className="text-[13px] text-ink-muted">Reading your position, today's prices and the pool…</p>;
    }

    if (submission.kind === 'done') {
        return <Settled receipt={submission.receipt} onAgain={readAgain} />;
    }

    if (statement === null || outcome === null) {
        return (
            <Nothing heading="Nothing to redeem">
                <p>This wallet holds no ladder under either profile.</p>
                <p className="text-[13px] text-ink-muted">
                    <Link to="/" className="border-b border-rule-strong">
                        Compose one
                    </Link>{' '}
                    first.
                </p>
            </Nothing>
        );
    }

    const busy = submission.kind === 'checking' || submission.kind === 'signing' || submission.kind === 'confirming';

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
                    Selling the position back to the backstop pool before maturity, for USDC in the same transaction.
                    Choose how much of it to redeem; the quote below is read top to bottom.
                </p>
            </section>

            {loaded.desk.statements.length > 1 && (
                <div className="inline-flex border border-ink">
                    {loaded.desk.statements.map((held) => (
                        <button
                            key={held.profile}
                            type="button"
                            disabled={busy}
                            onClick={() => {
                                setShown(held.profile);
                                setSubmission({ kind: 'idle' });
                            }}
                            className={[
                                'px-5 py-2 text-[13px] transition-colors duration-200',
                                held.profile === statement.profile
                                    ? 'bg-ink text-paper'
                                    : 'bg-transparent text-ink-muted hover:text-ink',
                            ].join(' ')}
                        >
                            {PROFILE_NAMES[held.profile]}
                        </button>
                    ))}
                </div>
            )}

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
                            disabled={busy}
                            onChange={(e) => {
                                const next = Number(e.target.value);
                                if (Number.isFinite(next)) changeSize(next);
                            }}
                            className="figure w-20 border-b border-ink bg-transparent pb-1 text-right font-display text-[22px] outline-none focus:border-mark"
                        />
                        <span className="text-[13px] text-ink-muted">%</span>
                    </div>
                    <div className="w-full max-w-lg">
                        <input
                            type="range"
                            aria-label="Share of the position"
                            className="paper-range"
                            min={1}
                            max={100}
                            step={1}
                            value={percent}
                            disabled={busy}
                            onChange={(e) => changeSize(Number(e.target.value))}
                        />
                        <div className="figure mt-1 flex justify-between text-[11px] text-ink-faint">
                            {PRESETS.map((preset) => (
                                <button
                                    key={preset}
                                    type="button"
                                    disabled={busy}
                                    onClick={() => changeSize(preset)}
                                    className="transition-colors duration-200 hover:text-ink"
                                >
                                    {preset}%
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            </section>

            {outcome.ok ? (
                <section className="max-w-[38rem]">
                    <h2 className="section-heading">Quote</h2>
                    <Quote quote={outcome.quote} statement={statement} desk={loaded.desk} percent={percent} />

                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => void submit(loaded.desk, statement, outcome.quote)}
                        className="mt-6 border border-ink bg-ink px-7 py-2.5 text-[13px] tracking-wide text-paper transition-opacity duration-200 hover:opacity-85 disabled:opacity-50"
                    >
                        Redeem {percent}%
                    </button>
                    {busy && (
                        <p className="mt-3 text-[13px] text-ink-muted">
                            {WAITING[submission.kind as keyof typeof WAITING]}
                        </p>
                    )}
                    {submission.kind === 'failed' && (
                        <p className="mt-3 max-w-[60ch] text-[13px] leading-relaxed text-mark">{submission.reason}</p>
                    )}
                </section>
            ) : (
                <section className="max-w-[46rem]">
                    <h2 className="section-heading">Not available</h2>
                    <p className="border-b border-rule py-6 text-[15px] leading-relaxed">{outcome.refusal}</p>
                    {outcome.coveredPercent !== null && (
                        <button
                            type="button"
                            onClick={() => changeSize(outcome.coveredPercent ?? 100)}
                            className="mt-4 border-b border-rule-strong pb-0.5 text-[13px] text-ink-muted transition-colors duration-200 hover:border-mark hover:text-ink"
                        >
                            Quote {outcome.coveredPercent}% instead — the largest share the pool covers today
                        </button>
                    )}
                </section>
            )}

            <section className="pt-2">
                <Link
                    to="/position"
                    className="border-b border-rule-strong pb-0.5 text-[13px] text-ink-muted transition-colors duration-200 hover:border-mark hover:text-ink"
                >
                    Back to the statement, opened {maturityDate(statement.openedAt)}
                </Link>
            </section>
        </div>
    );
}
