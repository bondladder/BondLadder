# BondLadder

Automated bond ladders for stablecoin holders.

Deposit USDC, pick a risk profile, and the vault spreads it across five tokenized
debt instruments with staggered maturities — selected by on-chain credit rating.
Exit any time before maturity through a liquidity backstop, with the spread priced
off the position's remaining duration.

## Status

Early development. Not audited. Not for production funds.

## Requirements

- Node >= 22, pnpm 9.15
- Rust 1.97.1, Agave (solana-cli) 4.2.0, Anchor 0.32.1

## Commands

```bash
pnpm install
pnpm gate        # lint + typecheck + test
pnpm dev         # all apps
anchor build     # on-chain programs
```

## Layout

```
programs/bond-ladder     vault, ladders, backstop, fees
programs/rating-oracle   normalized credit ratings, readable by any program
programs/mock-issuer     demo-only instrument issuer (redeems at maturity only)
apps/web                 dashboard
apps/keeper              permissionless maintenance crank
packages/shared          rating scale, ladder selection, schemas
```

## License

Apache-2.0
