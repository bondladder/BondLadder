import CreditMap from '@/components/CreditMap';
import {
    BREACH_FLOOR_VALUE,
    BREACH_MARKS,
    REGISTER,
    REGISTER_PREAMBLE,
    gradeLabel,
} from '@/lib/mockSource';

export default function Register() {
    return (
        <div className="space-y-8">
            <section>
                <h1 className="mb-4 font-display text-[26px] leading-tight">Register of events</h1>
                <p className="max-w-[68ch] text-[14px] leading-relaxed text-ink-muted">{REGISTER_PREAMBLE}</p>
            </section>

            <section className="border-t border-rule-strong">
                {REGISTER.map((entry) => (
                    <article
                        key={`${entry.date}-${entry.event}`}
                        className="border-b border-rule py-5 sm:grid sm:grid-cols-[7.5rem_1fr_9rem] sm:gap-6"
                    >
                        <div className="figure mb-1 text-[13px] text-ink-muted sm:mb-0">{entry.date}</div>

                        <div>
                            <h2 className="mb-1 text-[11px] uppercase tracking-[0.14em] text-ink">{entry.event}</h2>
                            <p className="max-w-[64ch] text-[14px] leading-relaxed">{entry.description}</p>

                            {entry.illustration === 'rating-breach' && (
                                <div className="mt-4 border-t border-rule pt-3">
                                    <CreditMap
                                        marks={BREACH_MARKS}
                                        selectedIds={BREACH_MARKS.map((m) => m.id)}
                                        floorValue={BREACH_FLOOR_VALUE}
                                        floorCaption={`Conservative floor — ${gradeLabel(BREACH_FLOOR_VALUE)}`}
                                        height={110}
                                        mini
                                    />
                                </div>
                            )}
                        </div>

                        <div className="figure mt-2 text-[14px] sm:mt-0 sm:text-right">{entry.amount}</div>
                    </article>
                ))}
            </section>
        </div>
    );
}
