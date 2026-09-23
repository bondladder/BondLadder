import { type RiskProfile, worstAllowedNotch } from '@bondladder/shared';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import CreditMap from '@/components/CreditMap';
import {
    dayCount,
    maturityDate,
    notchLabel,
    percentFromBps,
    signedUsdcFromMicro,
    usdcFromMicro,
    weightedNotchLabel,
} from '@/lib/format';
import { chartDomain, type PositionStatement, ratingAxis, readStatements, type StatementRow } from '@/lib/source';
import { useWallet } from '@/lib/walletContext';

const PROFILE_NAMES: Record<RiskProfile, string> = {
    conservative: 'Conservative',
    balanced: 'Balanced',
};

interface Loaded {
    readonly statements: readonly PositionStatement[];
    readonly nowTs: bigint;
}

function reason(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function ratingCell(row: StatementRow): string {
    if (row.notch === null) {
        return 'no usable rating';
    }

    return row.notch === row.entryNotch
        ? notchLabel(row.notch)
        : `${notchLabel(row.notch)} · entered ${notchLabel(row.entryNotch)}`;
}

function nextMaturityLabel(statement: PositionStatement): string {
    const next = statement.nextMaturity;
    if (next === null) {
        return '—';
    }

    return `${maturityDate(next.maturityTs)} · ${next.issuerId} · ${usdcFromMicro(next.valueMicro)}`;
}

function headerRows(statement: PositionStatement): Array<[string, string]> {
    return [
        ['Position value', usdcFromMicro(statement.netValueMicro)],
        ['Opened', `${maturityDate(statement.openedAt)} · ${PROFILE_NAMES[statement.profile]}`],
        [
            'Weighted rating',
            statement.weightedNotch === null
                ? `unknown — ${statement.unratedCount} of ${statement.rows.length} rungs unrated today`
                : weightedNotchLabel(statement.weightedNotch),
        ],
        ['Average remaining term', dayCount(statement.averageRemainingSeconds)],
        ['Next maturity', nextMaturityLabel(statement)],
    ];
}

function Dashboard({ statement, nowTs }: { statement: PositionStatement; nowTs: bigint }) {
    // Only a rung the oracle has something usable to say about has a grade to
    // be drawn at; the rest are counted out loud below the plot instead of
    // being placed at the grade they were bought at.
    const rated = statement.rows.filter((row) => row.notch !== null);
    const floorNotch = worstAllowedNotch(statement.profile);
    const domain = {
        ...chartDomain(
            statement.rows.map((row) => row.maturityTs),
            nowTs,
        ),
        ...ratingAxis(
            rated.map((row) => row.notch ?? row.entryNotch),
            floorNotch,
        ),
    };
    const changeMicro = statement.grossValueMicro - statement.principalMicro;

    return (
        <div className="space-y-10">
            <section>
                <div className="mb-5 flex flex-wrap items-baseline justify-between gap-3">
                    <h1 className="font-display text-[26px] leading-tight">Statement</h1>
                    <p className="figure text-[11px] uppercase tracking-[0.12em] text-ink-faint">
                        Read {maturityDate(nowTs)} · {dayCount(statement.heldSeconds)} held
                    </p>
                </div>

                <dl className="border-t border-rule-strong">
                    {headerRows(statement).map(([label, value]) => (
                        <div
                            key={label}
                            className="flex flex-col gap-0.5 border-b border-rule py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6"
                        >
                            <dt className="text-[13px] text-ink-muted">{label}</dt>
                            <dd className="figure text-[15px] sm:text-right">{value}</dd>
                        </div>
                    ))}
                </dl>
            </section>

            <section>
                <h2 className="section-heading mb-4">Held position</h2>
                <CreditMap
                    marks={rated.map((row) => ({
                        id: row.mint,
                        issuer: row.issuerId,
                        ratingValue: row.notch ?? row.entryNotch,
                        maturity: maturityDate(row.maturityTs),
                    }))}
                    selectedIds={rated.map((row) => row.mint)}
                    floorValue={floorNotch}
                    floorCaption={`${PROFILE_NAMES[statement.profile]} floor — ${notchLabel(floorNotch)}`}
                    height={340}
                    todayLine={maturityDate(nowTs)}
                    domain={domain}
                />
                {rated.length < statement.rows.length && (
                    <p className="figure mt-3 text-[11px] text-ink-faint">
                        {statement.rows.length - rated.length} of {statement.rows.length} rungs carry no usable rating
                        today and are not drawn
                    </p>
                )}
            </section>

            <section>
                <h2 className="section-heading">Holdings</h2>

                <table className="hidden w-full border-collapse text-[14px] md:table">
                    <thead>
                        <tr className="border-b border-rule">
                            <th className="col-label py-2 text-left">Issuer</th>
                            <th className="col-label py-2 text-left">Rating</th>
                            <th className="col-label py-2 text-left">Maturity</th>
                            <th className="col-label py-2 text-right">Remaining</th>
                            <th className="col-label py-2 text-right">Coupon</th>
                            <th className="col-label py-2 text-right">Units</th>
                            <th className="col-label py-2 text-right">Unit price</th>
                            <th className="col-label py-2 text-right">Value</th>
                        </tr>
                    </thead>
                    <tbody>
                        {statement.rows.map((row) => (
                            <tr key={row.mint} className="border-b border-rule">
                                <td className="py-3 pr-4 font-display text-[15px]">
                                    {row.issuerId}
                                    {row.flagged && <span className="ml-2 text-[11px] text-mark">flagged</span>}
                                </td>
                                <td className="figure py-3 pr-4">{ratingCell(row)}</td>
                                <td className="figure py-3 pr-4">{maturityDate(row.maturityTs)}</td>
                                <td className="figure py-3 pl-4 text-right">{dayCount(row.remainingSeconds)}</td>
                                <td className="figure py-3 pl-4 text-right">{percentFromBps(row.couponBps)}</td>
                                <td className="figure py-3 pl-4 text-right">{row.units.toString()}</td>
                                <td className="figure py-3 pl-4 text-right">{usdcFromMicro(row.priceMicro)}</td>
                                <td className="figure py-3 pl-4 text-right">{usdcFromMicro(row.valueMicro)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>

                <div className="md:hidden">
                    {statement.rows.map((row) => (
                        <div key={row.mint} className="border-b border-rule py-4">
                            <div className="mb-2 flex items-baseline justify-between gap-3">
                                <span className="font-display text-[16px]">{row.issuerId}</span>
                                <span className="figure text-[14px]">{ratingCell(row)}</span>
                            </div>
                            <dl className="space-y-1 text-[13px]">
                                {[
                                    ['Maturity', maturityDate(row.maturityTs)],
                                    ['Remaining', dayCount(row.remainingSeconds)],
                                    ['Coupon', percentFromBps(row.couponBps)],
                                    ['Units', row.units.toString()],
                                    ['Unit price', usdcFromMicro(row.priceMicro)],
                                    ['Value', usdcFromMicro(row.valueMicro)],
                                ].map(([label, value]) => (
                                    <div key={label} className="flex items-baseline justify-between gap-4">
                                        <dt className="text-ink-faint">{label}</dt>
                                        <dd className="figure">{value}</dd>
                                    </div>
                                ))}
                            </dl>
                        </div>
                    ))}
                </div>

                <p className="mt-4 max-w-[62ch] text-[12px] leading-relaxed text-ink-muted">
                    Coupon is the instrument's stated rate. Nothing on this chain accrues it, so no accrued coupon is
                    shown: a rung is worth its units at the issuer's price today, and that is the figure above.
                </p>
            </section>

            <section className="max-w-[36rem]">
                <h2 className="section-heading">Reconciliation</h2>

                <dl className="text-[14px]">
                    <div className="flex items-baseline justify-between gap-6 border-b border-rule py-3">
                        <dt className="text-ink-muted">Invested</dt>
                        <dd className="figure">{usdcFromMicro(statement.principalMicro)}</dd>
                    </div>
                    <div className="border-b border-rule py-3">
                        <div className="flex items-baseline justify-between gap-6">
                            <dt className="text-ink-muted">Value change</dt>
                            <dd className="figure">{signedUsdcFromMicro(changeMicro)}</dd>
                        </div>
                        <p className="mt-1 max-w-[46ch] pl-6 text-[12px] leading-relaxed text-ink-faint">
                            the issuer's price today against the price each rung was bought at
                        </p>
                    </div>
                    <div className="border-b border-rule py-3">
                        <div className="flex items-baseline justify-between gap-6">
                            <dt className="text-ink-muted">Management fee accrued</dt>
                            <dd className="figure">{signedUsdcFromMicro(-statement.feeAccruedMicro)}</dd>
                        </div>
                        <p className="mt-1 max-w-[46ch] pl-6 text-[12px] leading-relaxed text-ink-faint">
                            {percentFromBps(statement.feeBps)} per year, charged on the next operation, not yet taken
                        </p>
                    </div>
                    <div className="flex items-baseline justify-between gap-6 border-b-[1.5px] border-ink py-3">
                        <dt className="text-[15px]">Position value</dt>
                        <dd className="figure text-[15px]">{usdcFromMicro(statement.netValueMicro)}</dd>
                    </div>
                </dl>
            </section>

            <section className="flex flex-wrap items-center gap-6 pt-2">
                <Link
                    to="/exit"
                    className="border border-ink bg-ink px-7 py-2.5 text-[13px] tracking-wide text-paper transition-opacity duration-200 hover:opacity-85"
                >
                    Redeem early
                </Link>
                <Link
                    to="/history"
                    className="border-b border-rule-strong pb-0.5 text-[13px] text-ink-muted transition-colors duration-200 hover:border-mark hover:text-ink"
                >
                    Register of events
                </Link>
            </section>
        </div>
    );
}

function Nothing({ heading, children }: { heading: string; children: ReactNode }) {
    return (
        <section>
            <h1 className="font-display text-[26px] leading-tight">{heading}</h1>
            <div className="mt-4 max-w-[68ch] space-y-3 text-[15px] leading-relaxed">{children}</div>
        </section>
    );
}

export default function Statement() {
    const { connected } = useWallet();
    const [loaded, setLoaded] = useState<Loaded | null>(null);
    const [loadFailure, setLoadFailure] = useState<string | null>(null);
    const [shown, setShown] = useState<RiskProfile | null>(null);

    useEffect(() => {
        setLoaded(null);
        setLoadFailure(null);
        if (connected === null) {
            return;
        }

        let alive = true;
        const nowTs = BigInt(Math.floor(Date.now() / 1000));

        readStatements(connected.address, nowTs)
            .then((statements) => alive && setLoaded({ statements, nowTs }))
            .catch((failure: unknown) => alive && setLoadFailure(reason(failure)));

        return () => {
            alive = false;
        };
    }, [connected]);

    const statement = useMemo(() => {
        const statements = loaded?.statements ?? [];

        return statements.find((held) => held.profile === shown) ?? statements[0] ?? null;
    }, [loaded, shown]);

    if (connected === null) {
        return (
            <Nothing heading="No wallet connected">
                <p>A position belongs to the wallet that opened it, so there is nothing to read until one is here.</p>
                <p className="text-[13px] text-ink-muted">
                    Connect a wallet in the header, or{' '}
                    <Link to="/" className="border-b border-rule-strong">
                        compose a position
                    </Link>{' '}
                    first.
                </p>
            </Nothing>
        );
    }

    if (loadFailure !== null) {
        return (
            <Nothing heading="The chain is out of reach">
                <p>{loadFailure}</p>
                <p className="text-[13px] text-ink-muted">
                    Nothing has been moved. The position, the instruments behind it and their ratings are all read from
                    the network.
                </p>
            </Nothing>
        );
    }

    if (loaded === null) {
        return <p className="text-[13px] text-ink-muted">Reading your position, its instruments and their ratings…</p>;
    }

    if (statement === null) {
        return (
            <Nothing heading="No position yet">
                <p>This wallet holds no ladder under either profile. That is a state, not a failure.</p>
                <p className="text-[13px] text-ink-muted">
                    <Link to="/" className="border-b border-rule-strong">
                        Compose one
                    </Link>{' '}
                    and it will show up here the moment the deposit confirms.
                </p>
            </Nothing>
        );
    }

    return (
        <div className="space-y-6">
            {loaded.statements.length > 1 && (
                <div className="inline-flex border border-ink">
                    {loaded.statements.map((held) => (
                        <button
                            key={held.profile}
                            type="button"
                            onClick={() => setShown(held.profile)}
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
            <Dashboard statement={statement} nowTs={loaded.nowTs} />
        </div>
    );
}
