use anchor_lang::prelude::*;

#[error_code]
pub enum IssuerError {
    #[msg("Ціна інструмента має бути додатною")]
    InvalidPrice,
    #[msg("Дата погашення вже настала")]
    MaturityInThePast,
}
