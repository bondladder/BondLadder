use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};

use crate::errors::IssuerError;
use crate::state::{Fill, Instrument, IssuerConfig};

/// Скільки цілих одиниць дає бюджет і скільки з нього піде насправді.
///
/// Винесено з обміну, бо цю саму відповідь має показати екран депозиту до
/// підпису (FR-007): скільки одиниць буде куплено і який неподільний хвіст
/// лишиться платнику (FR-032). Дзеркало — `fillForShare` у
/// `packages/shared/src/ladder.ts`, спільний фікстур — `fixtures/ladder.json`.
///
/// Округлення вниз тут — відкидання залишку, а не множення: жодна дія не може
/// вийти за u64. Ціна нуля не буває — її відхиляє викликач.
pub fn fill_for_share(budget_micro: u64, price_micro: u64) -> Fill {
    let spent_micro = budget_micro - budget_micro % price_micro;

    Fill {
        units: spent_micro / price_micro,
        spent_micro,
    }
}

pub fn handler(ctx: Context<MintForUsdc>, amount_micro: u64) -> Result<Fill> {
    let price_micro = ctx.accounts.instrument.price_micro;
    require!(price_micro > 0, IssuerError::InvalidPrice);
    require!(
        Clock::get()?.unix_timestamp < ctx.accounts.instrument.maturity_ts,
        IssuerError::MaturityInThePast
    );

    let Fill { units, spent_micro } = fill_for_share(amount_micro, price_micro);
    require!(units > 0, IssuerError::AmountBelowUnitPrice);

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.buyer_usdc.to_account_info(),
                to: ctx.accounts.treasury.to_account_info(),
                authority: ctx.accounts.buyer.to_account_info(),
            },
        ),
        spent_micro,
    )?;

    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.buyer_instrument.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            &[&[IssuerConfig::SEED, &[ctx.accounts.config.bump]]],
        ),
        units,
    )?;

    Ok(Fill { units, spent_micro })
}

#[derive(Accounts)]
pub struct MintForUsdc<'info> {
    #[account(
        seeds = [IssuerConfig::SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, IssuerConfig>,

    #[account(
        seeds = [Instrument::SEED, instrument.mint.as_ref()],
        bump = instrument.bump,
        has_one = mint,
    )]
    pub instrument: Account<'info, Instrument>,

    #[account(mut)]
    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = buyer_usdc.mint == config.usdc_mint @ IssuerError::WrongUsdcMint,
    )]
    pub buyer_usdc: Account<'info, TokenAccount>,

    // Без перевірки власника покупець вказав би скарбницею власний рахунок:
    // USDC не вийшов би з-під його контролю, а інструмент він отримав би.
    #[account(
        mut,
        constraint = treasury.mint == config.usdc_mint @ IssuerError::WrongUsdcMint,
        constraint = treasury.owner == config.key() @ IssuerError::TreasuryNotOwnedByIssuer,
    )]
    pub treasury: Account<'info, TokenAccount>,

    #[account(mut)]
    pub buyer_instrument: Account<'info, TokenAccount>,

    pub buyer: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Той самий файл читає packages/shared/src/ladder.test.ts. Розійшовшись,
    /// екран показав би до підпису не ту кількість одиниць, яку видасть
    /// маршрут, — а це вже розбіжність про гроші, не про верстку.
    const SHARED_FIXTURE: &str = include_str!("../../../../fixtures/ladder.json");

    fn fixture() -> serde_json::Value {
        serde_json::from_str(SHARED_FIXTURE).expect("fixtures/ladder.json — валідний JSON")
    }

    /// Величини в u64 записані рядками: u64::MAX не переживає числа JSON.
    fn wide(value: &serde_json::Value) -> u64 {
        value
            .as_str()
            .expect("очікувався рядок")
            .parse()
            .expect("очікувалось число в межах u64")
    }

    #[test]
    fn the_fill_matches_the_shared_fixture() {
        let fixture = fixture();
        let cases = fixture["fill"].as_array().expect("fill — масив");
        assert_eq!(
            cases.len(),
            7,
            "фікстур наповнення схуд — випадок загубився"
        );

        for entry in cases {
            let case = entry["case"].as_str().expect("case — рядок");
            let fill = fill_for_share(wide(&entry["shareMicro"]), wide(&entry["priceMicro"]));

            assert_eq!(fill.units, wide(&entry["units"]), "{case}: одиниці");
            assert_eq!(
                fill.spent_micro,
                wide(&entry["spentMicro"]),
                "{case}: витрачено"
            );
        }
    }

    #[test]
    fn the_fill_never_overspends_the_budget() {
        for entry in fixture()["fill"].as_array().expect("fill — масив") {
            let case = entry["case"].as_str().expect("case — рядок");
            let budget = wide(&entry["shareMicro"]);
            let price = wide(&entry["priceMicro"]);
            let fill = fill_for_share(budget, price);

            assert!(fill.spent_micro <= budget, "{case}: витрачено понад бюджет");
            assert_eq!(fill.units * price, fill.spent_micro, "{case}: цілі одиниці");
            assert!(budget - fill.spent_micro < price, "{case}: хвіст завеликий");
        }
    }

    #[test]
    fn a_budget_below_the_unit_price_buys_nothing() {
        let fill = fill_for_share(999, 1_000);

        assert_eq!(fill.units, 0);
        assert_eq!(fill.spent_micro, 0);
    }
}
