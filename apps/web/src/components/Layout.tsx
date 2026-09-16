import { NavLink, Outlet } from 'react-router-dom';
import { BALANCE_CHIP, BANNER } from '@/lib/source';

const NAV = [
    { to: '/', label: 'Compose', end: true },
    { to: '/position', label: 'Statement', end: false },
    { to: '/exit', label: 'Redemption', end: false },
    { to: '/history', label: 'Register', end: false },
];

export default function Layout() {
    return (
        <div className="min-h-screen bg-paper">
            <div className="border-b border-rule bg-paper-sunk">
                <p className="mx-auto max-w-[1180px] px-4 py-2 text-[11px] leading-relaxed text-ink-muted sm:px-8">
                    {BANNER}
                </p>
            </div>

            <header className="border-b border-rule-strong">
                <div className="mx-auto flex max-w-[1180px] flex-wrap items-baseline justify-between gap-x-8 gap-y-3 px-4 py-5 sm:px-8">
                    <div className="flex items-baseline gap-6">
                        <span className="font-display text-[22px] tracking-tight">BondLadder</span>
                        <nav className="flex items-baseline gap-5">
                            {NAV.map((item) => (
                                <NavLink
                                    key={item.to}
                                    to={item.to}
                                    end={item.end}
                                    className={({ isActive }) =>
                                        [
                                            'text-[11px] uppercase tracking-[0.12em] pb-0.5 border-b',
                                            isActive
                                                ? 'text-ink border-mark'
                                                : 'text-ink-faint border-transparent hover:text-ink-muted',
                                        ].join(' ')
                                    }
                                >
                                    {item.label}
                                </NavLink>
                            ))}
                        </nav>
                    </div>
                    <span className="figure border border-rule-strong px-2.5 py-1 text-[11px] tracking-wide text-ink-muted">
                        {BALANCE_CHIP}
                    </span>
                </div>
            </header>

            <main className="mx-auto max-w-[1180px] px-4 pb-24 pt-8 sm:px-8">
                <Outlet />
            </main>
        </div>
    );
}
