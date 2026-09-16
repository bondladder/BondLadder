import { Link } from 'react-router-dom';
import CreditMap from '@/components/CreditMap';
import {
    BONDS,
    HELD_ROWS,
    POSITION,
    RECONCILIATION,
    SHEET_CONSERVATIVE,
    bondId,
    gradeLabel,
} from '@/lib/source';

const HEADER_ROWS: Array<[string, string]> = [
    ['Position value', POSITION.valueLabel],
    ['Opened', `${POSITION.openedOn} · ${POSITION.profileName}`],
    ['Weighted rating', POSITION.weightedRating],
    ['Average remaining term', POSITION.averageRemainingTerm],
    ['Next maturity', POSITION.nextMaturity],
];

export default function Statement() {
    const selectedIds = SHEET_CONSERVATIVE.holdings.map((h) => bondId(h.issuer, h.maturity));

    return (
        <div className="space-y-10">
            <section>
                <div className="mb-5 flex flex-wrap items-baseline justify-between gap-3">
                    <h1 className="font-display text-[26px] leading-tight">Statement</h1>
                    <p className="figure text-[11px] uppercase tracking-[0.12em] text-ink-faint">
                        Read {POSITION.readOn} · {POSITION.daysHeld} days held
                    </p>
                </div>

                <dl className="border-t border-rule-strong">
                    {HEADER_ROWS.map(([label, value]) => (
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
                    marks={BONDS}
                    selectedIds={selectedIds}
                    floorValue={POSITION.floorValue}
                    floorCaption={`${POSITION.profileName} floor — ${gradeLabel(POSITION.floorValue)}`}
                    height={340}
                    todayLine={POSITION.readOn}
                />
            </section>

            <section>
                <h2 className="section-heading">Holdings</h2>

                <table className="hidden w-full border-collapse text-[14px] md:table">
                    <thead>
                        <tr className="border-b border-rule">
                            <th className="col-label py-2 text-left">Issuer</th>
                            <th className="col-label py-2 text-left">Rating</th>
                            <th className="col-label py-2 text-left">Maturity</th>
                            <th className="col-label py-2 text-right">Days remaining</th>
                            <th className="col-label py-2 text-right">Amount</th>
                            <th className="col-label py-2 text-right">Coupon accrued</th>
                        </tr>
                    </thead>
                    <tbody>
                        {HELD_ROWS.map((row) => (
                            <tr key={row.issuer} className="border-b border-rule">
                                <td className="py-3 pr-4 font-display text-[15px]">{row.issuer}</td>
                                <td className="figure py-3 pr-4">{gradeLabel(row.ratingValue)}</td>
                                <td className="figure py-3 pr-4">{row.maturity}</td>
                                <td className="figure py-3 pl-4 text-right">{row.daysRemaining}</td>
                                <td className="figure py-3 pl-4 text-right">{row.amount}</td>
                                <td className="figure py-3 pl-4 text-right">{row.accrued}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>

                <div className="md:hidden">
                    {HELD_ROWS.map((row) => (
                        <div key={row.issuer} className="border-b border-rule py-4">
                            <div className="mb-2 flex items-baseline justify-between gap-3">
                                <span className="font-display text-[16px]">{row.issuer}</span>
                                <span className="figure text-[14px]">{gradeLabel(row.ratingValue)}</span>
                            </div>
                            <dl className="space-y-1 text-[13px]">
                                {[
                                    ['Maturity', row.maturity],
                                    ['Days remaining', row.daysRemaining],
                                    ['Amount', row.amount],
                                    ['Coupon accrued', row.accrued],
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
            </section>

            <section className="max-w-[36rem]">
                <h2 className="section-heading">Reconciliation</h2>

                <dl className="text-[14px]">
                    <div className="flex items-baseline justify-between gap-6 border-b border-rule py-3">
                        <dt className="text-ink-muted">{RECONCILIATION.deposited.label}</dt>
                        <dd className="figure">{RECONCILIATION.deposited.figure}</dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-6 border-b border-rule py-3">
                        <dt className="text-ink-muted">{RECONCILIATION.coupon.label}</dt>
                        <dd className="figure">{RECONCILIATION.coupon.figure}</dd>
                    </div>
                    <div className="border-b border-rule py-3">
                        <div className="flex items-baseline justify-between gap-6">
                            <dt className="text-ink-muted">{RECONCILIATION.fee.label}</dt>
                            <dd className="figure">{RECONCILIATION.fee.figure}</dd>
                        </div>
                        <p className="mt-1 max-w-[46ch] pl-6 text-[12px] leading-relaxed text-ink-faint">
                            {RECONCILIATION.fee.note}
                        </p>
                    </div>
                    <div className="flex items-baseline justify-between gap-6 border-b-[1.5px] border-ink py-3">
                        <dt className="text-[15px]">{RECONCILIATION.value.label}</dt>
                        <dd className="figure text-[15px]">{RECONCILIATION.value.figure}</dd>
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
