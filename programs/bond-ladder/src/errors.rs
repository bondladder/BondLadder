use anchor_lang::prelude::*;

#[error_code]
pub enum LadderError {
    #[msg("Ставка в базисних пунктах не може перевищувати 100%")]
    InvalidBps,
    #[msg("Мінімальний депозит має бути додатним і не більшим за місткість vault")]
    InvalidDepositBounds,
    #[msg("Очікувалась адреса програми")]
    ExpectedProgram,
}
