import { NavLink, Outlet } from 'react-router-dom';
import { shortAddress, useWallet } from '@/lib/walletContext';

const NAV = [
    { to: '/', label: 'Compose', end: true },
    { to: '/position', label: 'Statement', end: false },
    { to: '/exit', label: 'Redemption', end: false },
    { to: '/history', label: 'Register', end: false },
];

// Two claims, because the app is now part way onto the chain: Compose and
// Statement read the deployed vault and open and report real positions, the
// other two screens are still the illustrative figures they were built with.
const BANNER =
    'Demo on Solana devnet. Compose and Statement read the deployed vault and work on real positions with demo ' +
    'USDC; Redemption and Register are still illustrative figures. Not real securities, ratings, or offers.';

function WalletChip() {
    const { wallets, connected, busy, disconnect, connect } = useWallet();

    if (connected !== null) {
        return (
            <button
                type="button"
                onClick={() => void disconnect()}
                title={connected.address}
                className="figure border border-rule-strong px-2.5 py-1 text-[11px] tracking-wide text-ink-muted transition-colors duration-200 hover:text-ink"
            >
                {connected.name} · {shortAddress(connected.address)}
            </button>
        );
    }

    if (wallets.length === 0) {
        return (
            <span className="figure border border-rule px-2.5 py-1 text-[11px] tracking-wide text-ink-faint">
                No Solana wallet found
            </span>
        );
    }

    return (
        <span className="flex flex-wrap items-baseline gap-2">
            {wallets.map((wallet) => (
                <button
                    key={wallet.name}
                    type="button"
                    disabled={busy}
                    onClick={() => void connect(wallet.name)}
                    className="figure border border-rule-strong px-2.5 py-1 text-[11px] tracking-wide text-ink-muted transition-colors duration-200 hover:text-ink disabled:text-ink-faint"
                >
                    Connect {wallet.name}
                </button>
            ))}
        </span>
    );
}

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
                    <WalletChip />
                </div>
            </header>

            <main className="mx-auto max-w-[1180px] px-4 pb-24 pt-8 sm:px-8">
                <Outlet />
            </main>
        </div>
    );
}
