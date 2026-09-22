/**
 * The connected wallet, shared between the header and the screens.
 *
 * The registry in `wallet.ts` is a window-event affair with no React in it;
 * this is the thin layer that lets two components see one connection. It holds
 * no balances and no chain state — those belong to whoever knows which mint
 * they are asking about.
 */

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { CHAIN } from './program';
import {
    type ConnectedWallet,
    connect as connectWallet,
    disconnect as disconnectWallet,
    listWallets,
    onWalletsChanged,
    signAndSend,
    type WalletHandle,
} from './wallet';

interface WalletState {
    readonly wallets: readonly WalletHandle[];
    readonly connected: ConnectedWallet | null;
    readonly busy: boolean;
    readonly error: string | null;
    connect(name: string): Promise<void>;
    disconnect(): Promise<void>;
    sign(transaction: Uint8Array): Promise<string>;
}

const WalletContext = createContext<WalletState | null>(null);

function reason(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function WalletProvider({ children }: { children: ReactNode }) {
    const [wallets, setWallets] = useState<readonly WalletHandle[]>([]);
    const [connected, setConnected] = useState<ConnectedWallet | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        setWallets(listWallets(CHAIN));

        return onWalletsChanged(() => setWallets(listWallets(CHAIN)));
    }, []);

    const connect = useCallback(async (name: string) => {
        setBusy(true);
        setError(null);
        try {
            setConnected(await connectWallet(name, CHAIN));
        } catch (failure) {
            setError(reason(failure));
        } finally {
            setBusy(false);
        }
    }, []);

    const disconnect = useCallback(async () => {
        if (connected === null) {
            return;
        }
        try {
            await disconnectWallet(connected.name);
        } finally {
            setConnected(null);
        }
    }, [connected]);

    // Refusing here rather than handing `signAndSend` a null account keeps the
    // "no wallet" case a message instead of a stack trace mid-signature.
    const sign = useCallback(
        async (transaction: Uint8Array) => {
            if (connected === null) {
                throw new Error('No wallet is connected.');
            }

            return signAndSend(connected, CHAIN, transaction);
        },
        [connected],
    );

    const value = useMemo<WalletState>(
        () => ({ wallets, connected, busy, error, connect, disconnect, sign }),
        [wallets, connected, busy, error, connect, disconnect, sign],
    );

    return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
    const value = useContext(WalletContext);
    if (value === null) {
        throw new Error('useWallet is only usable inside <WalletProvider>');
    }

    return value;
}

/** `D1bB…tfQS` — enough to recognise the account, short enough for the header. */
export function shortAddress(address: string): string {
    return `${address.slice(0, 4)}…${address.slice(-4)}`;
}
