/**
 * BondLadder — гаманець користувача через Wallet Standard.
 *
 * Реєстр гаманців стандарту живе у подіях `window`, а не в бібліотеці: сторінка
 * оголошує себе готовою, гаманці відгукуються, і кожен приходить як звичайний
 * об'єкт. Тому тут немає ані адаптера, ані React-контексту — самі перевірки
 * того, що прийшло.
 *
 * Усе з реєстру — чуже: гаманець може віддати об'єкт без потрібної можливості
 * або зі списком мереж без нашої. Такий гаманець просто не потрапляє у список,
 * а не падає посеред підпису.
 */

import { encodeBase58 } from '@bondladder/shared';

const CONNECT = 'standard:connect';
const DISCONNECT = 'standard:disconnect';
const SIGN_AND_SEND = 'solana:signAndSendTransaction';

const REGISTER_EVENT = 'wallet-standard:register-wallet';
const APP_READY_EVENT = 'wallet-standard:app-ready';

export class WalletError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'WalletError';
    }
}

/** Гаманець, придатний до роботи: має обидві потрібні можливості й нашу мережу. */
export interface WalletHandle {
    readonly name: string;
    readonly icon: string;
    readonly addresses: readonly string[];
}

export interface ConnectedWallet {
    readonly name: string;
    readonly address: string;
}

type Wallet = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Wallet {
    return typeof value === 'object' && value !== null;
}

function strings(value: unknown): readonly string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((item): item is string => typeof item === 'string');
}

function walletName(candidate: unknown): string | null {
    if (!isRecord(candidate) || typeof candidate.name !== 'string' || !isRecord(candidate.features)) {
        return null;
    }
    return candidate.name;
}

/**
 * Рахунки читаються з живого об'єкта гаманця щоразу: після `connect` гаманець
 * дописує їх у свій же масив, і знімок, зроблений на реєстрації, лишився б
 * порожнім назавжди.
 */
function accountsOf(wallet: Wallet, chain: string): readonly Wallet[] {
    if (!Array.isArray(wallet.accounts)) {
        return [];
    }

    return wallet.accounts
        .filter(isRecord)
        .filter((account) => typeof account.address === 'string')
        .filter((account) => strings(account.chains).includes(chain));
}

function method(wallet: Wallet, feature: string, name: string): unknown {
    const carrier = isRecord(wallet.features) ? wallet.features[feature] : null;
    if (!isRecord(carrier)) {
        return null;
    }

    const candidate = carrier[name];
    return typeof candidate === 'function' ? candidate : null;
}

const registry = new Map<string, Wallet>();
const listeners = new Set<() => void>();

function announce(): void {
    for (const listener of listeners) {
        listener();
    }
}

function register(...candidates: readonly unknown[]): () => void {
    const added: string[] = [];

    for (const candidate of candidates) {
        const name = walletName(candidate);
        if (name !== null && isRecord(candidate)) {
            registry.set(name, candidate);
            added.push(name);
        }
    }

    if (added.length > 0) {
        announce();
    }

    return () => {
        for (const name of added) {
            registry.delete(name);
        }
        announce();
    };
}

let listening = false;

/**
 * Гаманець міг завантажитись і до нас, і після: перший випадок закриває подія
 * готовності, другий — слухач реєстрації. Обидва потрібні.
 */
function listen(): void {
    if (listening || typeof window === 'undefined') {
        return;
    }
    listening = true;

    window.addEventListener(REGISTER_EVENT, (event: Event) => {
        const detail: unknown = event instanceof CustomEvent ? event.detail : null;
        if (typeof detail === 'function') {
            (detail as (api: { register: typeof register }) => void)({ register });
        }
    });

    window.dispatchEvent(new CustomEvent(APP_READY_EVENT, { detail: { register } }));
}

function usable(wallet: Wallet, chain: string): boolean {
    return (
        strings(wallet.chains).includes(chain) &&
        method(wallet, CONNECT, 'connect') !== null &&
        method(wallet, SIGN_AND_SEND, 'signAndSendTransaction') !== null
    );
}

function address(account: Wallet): string {
    return typeof account.address === 'string' ? account.address : '';
}

export function listWallets(chain: string): readonly WalletHandle[] {
    listen();

    return Array.from(registry.entries())
        .filter(([, wallet]) => usable(wallet, chain))
        .map(([name, wallet]) => ({
            name,
            icon: typeof wallet.icon === 'string' ? wallet.icon : '',
            addresses: accountsOf(wallet, chain).map(address),
        }));
}

/** Список приходить із подій, тож екран мусить дізнатися про пізній гаманець. */
export function onWalletsChanged(listener: () => void): () => void {
    listen();
    listeners.add(listener);

    return () => {
        listeners.delete(listener);
    };
}

function known(name: string): Wallet {
    const wallet = registry.get(name);
    if (wallet === undefined) {
        throw new WalletError(`гаманця ${name} немає серед зареєстрованих`);
    }
    return wallet;
}

export async function connect(name: string, chain: string): Promise<ConnectedWallet> {
    const wallet = known(name);
    const connectMethod = method(wallet, CONNECT, 'connect');
    if (connectMethod === null) {
        throw new WalletError(`${name} не вміє під'єднуватись за стандартом`);
    }

    await (connectMethod as (input?: unknown) => Promise<unknown>)();

    const account = accountsOf(wallet, chain)[0];
    if (account === undefined) {
        throw new WalletError(`${name} не дав жодного рахунку в мережі ${chain}`);
    }

    return { name, address: address(account) };
}

export async function disconnect(name: string): Promise<void> {
    const disconnectMethod = method(known(name), DISCONNECT, 'disconnect');
    if (disconnectMethod !== null) {
        await (disconnectMethod as () => Promise<unknown>)();
    }
}

/**
 * Підпис і відправку робить гаманець: сторінка не бачить ключа і не тримає
 * власного з'єднання для відправки. Рахунок передається тим самим об'єктом,
 * який дав гаманець, — у ньому є ще й публічний ключ, і підміна його власною
 * копією ламає гаманці, що звіряють рахунок за тотожністю.
 */
export async function signAndSend(connected: ConnectedWallet, chain: string, transaction: Uint8Array): Promise<string> {
    const wallet = known(connected.name);
    const send = method(wallet, SIGN_AND_SEND, 'signAndSendTransaction');
    if (send === null) {
        throw new WalletError(`${connected.name} не вміє підписувати транзакції Solana`);
    }

    const account = accountsOf(wallet, chain).find((candidate) => address(candidate) === connected.address);
    if (account === undefined) {
        throw new WalletError(`${connected.name} більше не тримає рахунок ${connected.address}`);
    }

    const results: unknown = await (send as (input: unknown) => Promise<unknown>)({
        account,
        chain,
        transaction,
    });

    const first: unknown = Array.isArray(results) ? results[0] : results;
    if (!isRecord(first) || !(first.signature instanceof Uint8Array)) {
        throw new WalletError(`${connected.name} не повернув підпис транзакції`);
    }

    return encodeBase58(first.signature);
}
