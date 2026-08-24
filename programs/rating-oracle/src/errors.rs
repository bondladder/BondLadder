use anchor_lang::prelude::*;

#[error_code]
pub enum OracleError {
    #[msg("Строк свіжості має бути додатним")]
    InvalidMaxAge,
    #[msg("Мітка рейтингу не належить шкалі протоколу")]
    UnknownRatingLabel,
}
