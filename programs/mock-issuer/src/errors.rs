use anchor_lang::prelude::*;

#[error_code]
pub enum IssuerError {
    #[msg("Ціна інструмента має бути додатною")]
    InvalidPrice,
    #[msg("Дата погашення вже настала")]
    MaturityInThePast,
    #[msg("Суми не вистачає навіть на одну одиницю інструмента")]
    AmountBelowUnitPrice,
    #[msg("Розрахунок ведеться лише в оголошеному USDC")]
    WrongUsdcMint,
    #[msg("Скарбниця має належати емітенту")]
    TreasuryNotOwnedByIssuer,
}
