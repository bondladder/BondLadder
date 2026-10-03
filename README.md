# BondLadder

Automated bond ladders for stablecoin holders.

Deposit USDC, pick a risk profile, and the vault spreads it across five tokenized
debt instruments with staggered maturities — selected by on-chain credit rating.
Exit any time before maturity through a liquidity backstop, with the spread priced
off the position's remaining duration.

## Status

Early development, devnet only. Not audited. Not for production funds.

What runs today, on devnet and in the web app: a deposit opens a five-rung ladder in a
single transaction that reconciles with the allocation shown before signing; the position
screen reads the ladder back with the fee accrued so far; and an exit, full or partial, is
quoted before signing and paid from the backstop pool in the same transaction, or refused
whole when the pool cannot pay.

Measured against the public devnet endpoint, worst run rather than average: the ladder on
screen in 0.85 s, a deposit confirmed in 0.58 s, the first position screen in 0.94 s, and
USDC in the wallet 4.07 s after signing an exit. Over 100 exits of different sizes the
largest gap between quote and payout was 8 micro-USDC.

Not there yet: matured rungs are not rolled, nothing reacts to a rating downgrade, the
maintenance keeper is not running, and the history screen still shows illustrative data.

What is mocked and will stay mocked in the demo: the instrument issuer and the credit
ratings. Both are our own programs seeded with fictional issuers.

## Requirements

- Node >= 22, pnpm 9.15
- Rust 1.97.1, Agave (solana-cli) 4.2.0, Anchor 0.32.1 — the programs build with the
  Solana toolchain on Linux, macOS or WSL

## Getting started

```bash
pnpm install
cp .env.example .env         # devnet defaults; only VITE_* reach the browser
anchor build                 # programs; also writes target/idl and target/types
pnpm gate                    # lint + typecheck + TS tests
cargo test --workspace       # program unit tests + mollusk instruction tests
```

`anchor build` comes first on a fresh clone: `scripts` typechecks against the generated
`target/types`, and the mollusk tests load the compiled `.so` from `target/deploy`.
`anchor test` is not wired up — on-chain tests live in Rust.

## Devnet

| Program | Address |
|---|---|
| bond_ladder | `5aKvW5hFUGw5hKzpz5DRYBK26EADqRHHgknmCU1EGNHe` |
| rating_oracle | `EWhJjvNVb5mh1Jb9DTzvTwk7BeS9qdZdK7a6vdneQPa9` |
| mock_issuer | `EX1tNj2MLTacJPfAVzbBW8ejFsnSp7AsnZvnRLmDy3vK` |

Demo USDC mint: `8dd8kVyShvfPXs4XFipTWSYL1PzH35kfr3KNc6qpVtdP` (6 decimals, minted by
the deployer on demand — it is not real USDC).

```bash
cd scripts
DEPLOYER_KEYPAIR_PATH=/path/to/deployer.json pnpm run deploy:devnet   # idempotent; also refreshes rating timestamps
DEPLOYER_KEYPAIR_PATH=/path/to/deployer.json pnpm run demo:deposit    # one deposit, one transaction, reconciled
```

Ratings expire after 30 days; re-running `deploy:devnet` is what refreshes them.

## Hosting

GitHub Pages from `main` through `.github/workflows/pages.yml`: the landing page
(`apps/landing`, static, no build) at `/<repository>/` and the web app, built under
`/<repository>/app/`, beside it. The root `404.html` is the app's shell, so a deep link
into the app loads it, and a link from before the app moved under `app/` is sent to the
same route there. Once in the repository settings, set **Pages → Source → GitHub
Actions**. The workflow falls back to the public devnet RPC and the program ids above; a
repository secret `VITE_SOLANA_RPC_URL` overrides the RPC (a key restricted to the Pages
origin, since every `VITE_*` value ends up in the bundle).

## Layout

```
programs/bond-ladder     vault, ladders, positions, the management fee, the backstop pool and exits
programs/rating-oracle   normalized credit ratings on a 22-notch scale, readable by any program
programs/mock-issuer     demo-only instrument issuer (redeems at maturity only)
packages/shared          TS mirrors of the program logic: rating scale, profiles, ladder
                         selection, fee math, account decoders, instruction encoders
apps/landing             the landing page: static HTML and CSS, no build
apps/web                 deposit, position and exit screens; chain client in src/lib
apps/keeper              permissionless maintenance crank (placeholder)
scripts                  devnet deployment, demo catalogue, demo deposit, backstop top-up,
                         latency and quote measurements
fixtures                 JSON read by both Rust and TS tests
```

## Fixtures

Every piece of logic that exists on both sides of the wire — the rating scale, profile
thresholds, fee arithmetic, account layouts, instruction encoding — is tested in Rust and
in TypeScript against the same file under `fixtures/`. A change to an account struct or
an instruction fails the Rust layout test before the TS decoder can drift.

## License

Apache-2.0
