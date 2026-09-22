import { maxIssuerBps, type RiskProfile, worstAllowedNotch } from '@bondladder/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import CreditMap from '@/components/CreditMap';
import {
    maturityDate,
    microFromUsdc,
    notchLabel,
    percentFromBps,
    termLabel,
    usdcFromMicro,
    weightedNotchLabel,
} from '@/lib/format';
import {
    type Catalogue,
    chartDomain,
    explorerTx,
    loadCatalogue,
    openPosition,
    type Proposal,
    proposeDeposit,
    ratingAxis,
    readUsdcBalance,
} from '@/lib/source';
import { useWallet } from '@/lib/walletContext';

const PROFILE_NAMES: Record<RiskProfile, string> = {
    conservative: 'Conservative',
    balanced: 'Balanced',
};

const PROFILE_ORDER: readonly RiskProfile[] = ['conservative', 'balanced'];

type Submission =
    | { kind: 'idle' }
    | { kind: 'custody' }
    | { kind: 'signing' }
    | { kind: 'done'; signature: string }
    | { kind: 'failed'; reason: string };

interface Loaded {
    readonly catalogue: Catalogue;
    readonly nowTs: bigint;
}

function reason(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export default function Compose() {
    const { connected, sign } = useWallet();
    const [profile, setProfile] = useState<RiskProfile>('conservative');
    const [amountText, setAmountText] = useState('1000.00');
    const [loaded, setLoaded] = useState<Loaded | null>(null);
    const [loadFailure, setLoadFailure] = useState<string | null>(null);
    const [balanceMicro, setBalanceMicro] = useState<bigint | null>(null);
    const [submission, setSubmission] = useState<Submission>({ kind: 'idle' });

    // The moment the catalogue was read is the moment the maturity windows are
    // measured from, so it is taken once beside the read and not on each render.
    useEffect(() => {
        let alive = true;
        const nowTs = BigInt(Math.floor(Date.now() / 1000));

        loadCatalogue(nowTs)
            .then((catalogue) => alive && setLoaded({ catalogue, nowTs }))
            .catch((failure: unknown) => alive && setLoadFailure(reason(failure)));

        return () => {
            alive = false;
        };
    }, []);

    useEffect(() => {
        if (loaded === null || connected === null) {
            setBalanceMicro(null);
            return;
        }

        let alive = true;
        readUsdcBalance(loaded.catalogue, connected.address)
            .then((balance) => alive && setBalanceMicro(balance))
            .catch(() => alive && setBalanceMicro(null));

        return () => {
            alive = false;
        };
    }, [loaded, connected]);

    const depositMicro = microFromUsdc(amountText);

    const outcome = useMemo(() => {
        if (loaded === null || depositMicro === null) {
            return null;
        }

        return proposeDeposit(loaded.catalogue, profile, depositMicro, loaded.nowTs);
    }, [loaded, depositMicro, profile]);

    const submit = useCallback(
        async (catalogue: Catalogue, proposal: Proposal, deposit: bigint) => {
            if (connected === null) {
                return;
            }

            try {
                const signature = await openPosition(
                    catalogue,
                    proposal,
                    profile,
                    deposit,
                    connected.address,
                    sign,
                    (step) => setSubmission({ kind: step === 'custody' ? 'custody' : 'signing' }),
                );

                setSubmission({ kind: 'done', signature });
            } catch (failure) {
                setSubmission({ kind: 'failed', reason: reason(failure) });
            }
        },
        [connected, profile, sign],
    );

    const floorNotch = worstAllowedNotch(profile);
    const entries = loaded?.catalogue.entries ?? [];
    const selected = outcome?.ok === true ? outcome.proposal.sheet.rows : [];
    const selectedIds = selected.map((row) => row.entry.mint);

    const domain = useMemo(() => {
        const nowTs = loaded?.nowTs ?? BigInt(Math.floor(Date.now() / 1000));

        return {
            ...chartDomain(
                entries.map((entry) => entry.maturityTs),
                nowTs,
            ),
            ...ratingAxis(
                entries.map((entry) => entry.notch),
                floorNotch,
            ),
        };
    }, [entries, loaded, floorNotch]);

    if (loadFailure !== null) {
        return (
            <section>
                <h1 className="font-display text-[26px] leading-tight">The chain is out of reach</h1>
                <p className="mt-4 max-w-[68ch] text-[15px] leading-relaxed">{loadFailure}</p>
                <p className="mt-3 max-w-[68ch] text-[13px] leading-relaxed text-ink-muted">
                    Nothing has been moved. The catalogue, the ratings and the vault are all read from the network
                    before anything is offered.
                </p>
            </section>
        );
    }

    if (loaded === null) {
        return <p className="text-[13px] text-ink-muted">Reading the vault, the catalogue and the ratings…</p>;
    }

    const sheet = outcome?.ok === true ? outcome.proposal.sheet : null;
    const refusal = outcome !== null && !outcome.ok ? outcome.refusal : null;
    const malformed = depositMicro === null ? 'That is not an amount of USDC.' : null;
    const shortOfBalance = balanceMicro !== null && depositMicro !== null && depositMicro > balanceMicro;

    return (
        <div className="space-y-10">
            <section>
                <div className="mb-3 flex items-baseline justify-between gap-4">
                    <h1 className="font-display text-[26px] leading-tight">The credit map</h1>
                    <p className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">
                        Rating against maturity date
                    </p>
                </div>
                <CreditMap
                    marks={entries.map((entry) => ({
                        id: entry.mint,
                        issuer: entry.issuerId,
                        ratingValue: entry.notch,
                        maturity: maturityDate(entry.maturityTs),
                    }))}
                    selectedIds={selectedIds}
                    floorValue={floorNotch}
                    floorCaption={`${PROFILE_NAMES[profile]} floor — ${notchLabel(floorNotch)}`}
                    height={400}
                    domain={domain}
                />
                <p className="mt-3 max-w-[62ch] text-[12px] leading-relaxed text-ink-muted">
                    Filled marks are the position: five issuers, one at each maturity, joined left to right. Hollow
                    marks sit below the floor and are never bought.
                </p>
                <p className="figure mt-2 text-[11px] text-ink-faint">
                    {entries.length} of {loaded.catalogue.instrumentCount} instruments carry a usable rating today
                </p>
            </section>

            {/* Controls */}
            <section className="border-y border-rule-strong">
                <div className="flex flex-col gap-8 py-6 lg:flex-row lg:items-end lg:justify-between">
                    <div>
                        <label htmlFor="amount" className="col-label mb-2 block">
                            Amount
                        </label>
                        <div className="flex items-baseline gap-2">
                            <input
                                id="amount"
                                type="text"
                                inputMode="decimal"
                                value={amountText}
                                onChange={(event) => setAmountText(event.target.value)}
                                className="figure w-[9.5rem] border-b border-ink bg-transparent pb-1 text-right font-display text-[22px] outline-none focus:border-mark"
                            />
                            <span className="text-[13px] text-ink-muted">USDC</span>
                        </div>
                        <p className="figure mt-2 text-[11px] text-ink-faint">
                            {balanceMicro === null
                                ? 'Connect a wallet to see your balance'
                                : `Wallet balance ${usdcFromMicro(balanceMicro)}`}
                        </p>
                    </div>

                    <div>
                        <span className="col-label mb-2 block">Profile</span>
                        <div className="inline-flex border border-ink">
                            {PROFILE_ORDER.map((key) => (
                                <button
                                    key={key}
                                    type="button"
                                    onClick={() => setProfile(key)}
                                    className={[
                                        'px-5 py-2 text-[13px] transition-colors duration-200',
                                        key === profile
                                            ? 'bg-ink text-paper'
                                            : 'bg-transparent text-ink-muted hover:text-ink',
                                    ].join(' ')}
                                >
                                    {PROFILE_NAMES[key]}
                                </button>
                            ))}
                        </div>
                        <p className="figure mt-2 text-[11px] text-ink-faint">
                            Floor {notchLabel(worstAllowedNotch(profile))} · max {percentFromBps(maxIssuerBps(profile))}{' '}
                            of one issuer
                        </p>
                    </div>

                    <div className="lg:text-right">
                        <button
                            type="button"
                            disabled={
                                sheet === null ||
                                connected === null ||
                                shortOfBalance ||
                                submission.kind === 'custody' ||
                                submission.kind === 'signing'
                            }
                            onClick={() => {
                                if (outcome?.ok === true && depositMicro !== null) {
                                    void submit(loaded.catalogue, outcome.proposal, depositMicro);
                                }
                            }}
                            className="border border-ink bg-ink px-7 py-2.5 text-[13px] tracking-wide text-paper transition-opacity duration-200 hover:opacity-85 disabled:cursor-not-allowed disabled:border-rule-strong disabled:bg-transparent disabled:text-ink-faint disabled:opacity-100"
                        >
                            {submission.kind === 'custody'
                                ? 'Preparing custody…'
                                : submission.kind === 'signing'
                                  ? 'Waiting for your wallet…'
                                  : 'Open position'}
                        </button>
                        <p className="figure mt-2 text-[11px] text-ink-faint lg:text-right">
                            {connected === null
                                ? 'Connect a wallet in the header first'
                                : shortOfBalance
                                  ? 'More than this wallet holds'
                                  : 'One transaction, signed by you'}
                        </p>
                    </div>
                </div>
            </section>

            {submission.kind === 'done' && (
                <section className="border-b border-rule pb-6">
                    <h2 className="section-heading">Position opened</h2>
                    <p className="max-w-[68ch] text-[15px] leading-relaxed">
                        The ladder was opened in one transaction.{' '}
                        <a
                            href={explorerTx(submission.signature)}
                            target="_blank"
                            rel="noreferrer"
                            className="border-b border-mark text-mark"
                        >
                            See it on the explorer
                        </a>
                        , or read it back on the{' '}
                        <Link to="/position" className="border-b border-rule-strong">
                            statement
                        </Link>
                        .
                    </p>
                </section>
            )}

            {submission.kind === 'failed' && (
                <section className="border-b border-rule pb-6">
                    <h2 className="section-heading">Not opened</h2>
                    <p className="max-w-[68ch] text-[15px] leading-relaxed">{submission.reason}</p>
                </section>
            )}

            {/* Term sheet or refusal */}
            {sheet === null ? (
                <section>
                    <h2 className="section-heading">Not opened</h2>
                    <p className="max-w-[68ch] border-b border-rule py-6 text-[15px] leading-relaxed">
                        {malformed ?? refusal}
                    </p>
                </section>
            ) : (
                <section>
                    <h2 className="section-heading">Term sheet</h2>

                    {/* Ruled table */}
                    <table className="hidden w-full border-collapse text-[14px] md:table">
                        <thead>
                            <tr className="border-b border-rule">
                                <th className="col-label py-2 text-left">Issuer</th>
                                <th className="col-label py-2 text-left">Rating</th>
                                <th className="col-label py-2 text-left">Source</th>
                                <th className="col-label py-2 text-left">Maturity</th>
                                <th className="col-label py-2 text-left">Term</th>
                                <th className="col-label py-2 text-right">Coupon</th>
                                <th className="col-label py-2 text-right">Unit price</th>
                                <th className="col-label py-2 text-right">Units</th>
                                <th className="col-label py-2 text-right">Amount</th>
                            </tr>
                        </thead>
                        <tbody>
                            {sheet.rows.map((row) => (
                                <tr key={row.entry.mint} className="border-b border-rule">
                                    <td className="py-3 pr-4 font-display text-[15px]">{row.entry.issuerId}</td>
                                    <td className="figure py-3 pr-4">{notchLabel(row.entry.notch)}</td>
                                    <td className="py-3 pr-4 text-[12px] tracking-wide text-ink-muted">
                                        {row.entry.agencyCode}
                                    </td>
                                    <td className="figure py-3 pr-4">{maturityDate(row.entry.maturityTs)}</td>
                                    <td className="py-3 pr-4 text-ink-muted">{termLabel(row.rungMonths)}</td>
                                    <td className="figure py-3 pl-4 text-right">
                                        {percentFromBps(row.entry.couponBps)}
                                    </td>
                                    <td className="figure py-3 pl-4 text-right">
                                        {usdcFromMicro(row.entry.priceMicro)}
                                    </td>
                                    <td className="figure py-3 pl-4 text-right">{row.units.toString()}</td>
                                    <td className="figure py-3 pl-4 text-right">{usdcFromMicro(row.spentMicro)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>

                    {/* Stacked definition lists */}
                    <div className="md:hidden">
                        {sheet.rows.map((row) => (
                            <div key={row.entry.mint} className="border-b border-rule py-4">
                                <div className="mb-2 flex items-baseline justify-between gap-3">
                                    <span className="font-display text-[16px]">{row.entry.issuerId}</span>
                                    <span className="figure text-[14px]">{notchLabel(row.entry.notch)}</span>
                                </div>
                                <dl className="space-y-1 text-[13px]">
                                    {[
                                        ['Source', row.entry.agencyCode],
                                        ['Maturity', maturityDate(row.entry.maturityTs)],
                                        ['Term', termLabel(row.rungMonths)],
                                        ['Coupon', percentFromBps(row.entry.couponBps)],
                                        ['Unit price', usdcFromMicro(row.entry.priceMicro)],
                                        ['Units', row.units.toString()],
                                        ['Amount', usdcFromMicro(row.spentMicro)],
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

                    <p className="figure mt-4 text-[13px] leading-relaxed text-ink-muted">
                        Deposit {usdcFromMicro(sheet.depositMicro)} · Invested {usdcFromMicro(sheet.investedMicro)} ·
                        Weighted rating {weightedNotchLabel(sheet.weightedNotch)} · {sheet.issuerCount} issuers, none
                        above {percentFromBps(sheet.largestIssuerBps)}
                    </p>
                    {sheet.returnedMicro > 0n && (
                        <p className="figure mt-1 text-[13px] leading-relaxed text-ink-muted">
                            {usdcFromMicro(sheet.returnedMicro)} stays in your wallet: the route buys whole units, and
                            that tail does not reach the price of one.
                        </p>
                    )}
                </section>
            )}
        </div>
    );
}
