import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import CreditMap from '@/components/CreditMap';
import { usdc } from '@/lib/format';
import {
    BONDS,
    DEPOSIT,
    PROFILES,
    PROFILE_ORDER,
    RATING_MAX,
    RATING_MIN,
    REFUSALS,
    bondId,
    eligibleIssuers,
    gradeLabel,
    sheetForFloor,
    tooFewIssuersRefusal,
    type ProfileKey,
} from '@/lib/source';

export default function Compose() {
    const navigate = useNavigate();
    const [profile, setProfile] = useState<ProfileKey>('conservative');
    const [floor, setFloor] = useState<number>(PROFILES.conservative.floorValue);
    const [amountText, setAmountText] = useState<string>('1000.00');

    const chooseProfile = (key: ProfileKey) => {
        setProfile(key);
        setFloor(PROFILES[key].floorValue);
    };

    const parsed = Number.parseFloat(amountText);
    const amount = Number.isFinite(parsed) ? parsed : 0;

    const sheet = sheetForFloor(floor, profile);

    let refusal: string | null = null;
    if (!Number.isFinite(parsed) || amount < DEPOSIT.minimum) refusal = REFUSALS.belowMinimum;
    else if (amount > DEPOSIT.maximum) refusal = REFUSALS.aboveMaximum;
    else if (!sheet) refusal = tooFewIssuersRefusal(floor);

    const holdings = !refusal && sheet ? sheet.holdings : [];
    const factor = amount / 1000;

    const selectedIds = holdings.map((h) => bondId(h.issuer, h.maturity));

    const floorCaption =
        floor === PROFILES[profile].floorValue
            ? `${PROFILES[profile].name} floor — ${gradeLabel(floor)}`
            : `Rating floor — ${gradeLabel(floor)}`;

    const eligibleCount = eligibleIssuers(floor).length;

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
                    marks={BONDS}
                    selectedIds={selectedIds}
                    floorValue={floor}
                    floorCaption={floorCaption}
                    height={400}
                />
                <p className="mt-3 max-w-[62ch] text-[12px] leading-relaxed text-ink-muted">
                    Filled marks are the position: five issuers, one at each maturity, joined left to right. Hollow
                    marks sit below the floor and are never bought.
                </p>
            </section>

            {/* Controls */}
            <section className="border-y border-rule-strong">
                <div className="flex flex-col gap-8 py-6 lg:flex-row lg:items-end lg:justify-between">
                    <div>
                        <label
                            htmlFor="amount"
                            className="col-label mb-2 block"
                        >
                            Amount
                        </label>
                        <div className="flex items-baseline gap-2">
                            <input
                                id="amount"
                                type="number"
                                step="0.01"
                                inputMode="decimal"
                                value={amountText}
                                onChange={(e) => setAmountText(e.target.value)}
                                className="figure w-[9.5rem] border-b border-ink bg-transparent pb-1 text-right font-display text-[22px] outline-none focus:border-mark"
                            />
                            <span className="text-[13px] text-ink-muted">USDC</span>
                        </div>
                        <p className="figure mt-2 text-[11px] text-ink-faint">{DEPOSIT.walletBalance}</p>
                    </div>

                    <div>
                        <span className="col-label mb-2 block">Profile</span>
                        <div className="inline-flex border border-ink">
                            {PROFILE_ORDER.map((key) => {
                                const active = key === profile;
                                return (
                                    <button
                                        key={key}
                                        type="button"
                                        onClick={() => chooseProfile(key)}
                                        className={[
                                            'px-5 py-2 text-[13px] transition-colors duration-200',
                                            active ? 'bg-ink text-paper' : 'bg-transparent text-ink-muted hover:text-ink',
                                        ].join(' ')}
                                    >
                                        {PROFILES[key].name}
                                    </button>
                                );
                            })}
                        </div>
                        <p className="figure mt-2 text-[11px] text-ink-faint">
                            Floor {gradeLabel(PROFILES[profile].floorValue)} · max {PROFILES[profile].maxIssuerShare} of
                            one issuer
                        </p>
                    </div>

                    <div className="lg:text-right">
                        <button
                            type="button"
                            disabled={Boolean(refusal)}
                            onClick={() => navigate('/position')}
                            className="border border-ink bg-ink px-7 py-2.5 text-[13px] tracking-wide text-paper transition-opacity duration-200 hover:opacity-85 disabled:cursor-not-allowed disabled:border-rule-strong disabled:bg-transparent disabled:text-ink-faint disabled:opacity-100"
                        >
                            Open position
                        </button>
                    </div>
                </div>
            </section>

            {/* Term sheet or refusal */}
            {refusal ? (
                <section>
                    <h2 className="section-heading">Not opened</h2>
                    <p className="max-w-[68ch] border-b border-rule py-6 text-[15px] leading-relaxed">{refusal}</p>
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
                                <th className="col-label py-2 text-right">Amount</th>
                                <th className="col-label py-2 text-right">Share</th>
                                <th className="col-label py-2 text-right">Coupon to maturity</th>
                            </tr>
                        </thead>
                        <tbody>
                            {holdings.map((h) => (
                                <tr key={h.issuer} className="border-b border-rule">
                                    <td className="py-3 pr-4 font-display text-[15px]">{h.issuer}</td>
                                    <td className="figure py-3 pr-4">{gradeLabel(h.ratingValue)}</td>
                                    <td className="py-3 pr-4 text-[12px] tracking-wide text-ink-muted">{h.source}</td>
                                    <td className="figure py-3 pr-4">{h.maturity}</td>
                                    <td className="py-3 pr-4 text-ink-muted">{h.term}</td>
                                    <td className="figure py-3 pl-4 text-right">{usdc(h.amount * factor)}</td>
                                    <td className="figure py-3 pl-4 text-right">{h.share}</td>
                                    <td className="figure py-3 pl-4 text-right">{usdc(h.couponNumber * factor)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>

                    {/* Stacked definition lists */}
                    <div className="md:hidden">
                        {holdings.map((h) => (
                            <div key={h.issuer} className="border-b border-rule py-4">
                                <div className="mb-2 flex items-baseline justify-between gap-3">
                                    <span className="font-display text-[16px]">{h.issuer}</span>
                                    <span className="figure text-[14px]">{gradeLabel(h.ratingValue)}</span>
                                </div>
                                <dl className="space-y-1 text-[13px]">
                                    {[
                                        ['Source', h.source],
                                        ['Maturity', h.maturity],
                                        ['Term', h.term],
                                        ['Amount', usdc(h.amount * factor)],
                                        ['Share', h.share],
                                        ['Coupon to maturity', usdc(h.couponNumber * factor)],
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

                    {sheet && (
                        <p className="figure mt-4 text-[13px] leading-relaxed text-ink-muted">
                            Total {usdc(amount)} · Coupon to maturity {usdc(sheet.couponTotal * factor)} · Weighted
                            rating {sheet.weightedRating} · {sheet.issuerNote}
                        </p>
                    )}
                </section>
            )}

            {/* Demo controls */}
            <section className="border-t border-rule-strong pt-5">
                <h2 className="col-label mb-4">Demo controls</h2>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-8">
                    <label htmlFor="floor" className="w-40 shrink-0 text-[13px] text-ink-muted">
                        Rating floor
                    </label>
                    <input
                        id="floor"
                        type="range"
                        className="paper-range max-w-md"
                        min={RATING_MIN}
                        max={RATING_MAX}
                        step={1}
                        value={floor}
                        onChange={(e) => setFloor(Number(e.target.value))}
                    />
                    <span className="figure shrink-0 text-[13px]">
                        {gradeLabel(floor)} · {eligibleCount} of 9 issuers eligible
                    </span>
                </div>
                <p className="figure mt-2 text-[11px] text-ink-faint">
                    {gradeLabel(RATING_MIN)} → {gradeLabel(RATING_MAX)}
                </p>
            </section>
        </div>
    );
}
