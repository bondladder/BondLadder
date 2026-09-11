use anchor_lang::prelude::*;

#[error_code]
pub enum LadderError {
    #[msg("Ставка в базисних пунктах не може перевищувати 100%")]
    InvalidBps,
    #[msg("Мінімальний депозит має бути додатним і не більшим за місткість vault")]
    InvalidDepositBounds,
    #[msg("Очікувалась адреса програми")]
    ExpectedProgram,
    #[msg("Арифметика вийшла за межі розрядності")]
    MathOverflow,
    #[msg("Депозит має бути додатним")]
    ZeroDeposit,
    #[msg("Щабель не належить сітці строків протоколу")]
    RungOutOfGrid,
    #[msg("Рейтинг інструмента нижчий за поріг профілю")]
    RatingBelowFloor,
    #[msg("Дата погашення поза допуском щабля")]
    MaturityOutsideWindow,
    #[msg("Частка емітента перевищує ліміт профілю")]
    IssuerLimitExceeded,
    #[msg("Сума часток не дорівнює депозиту")]
    AllocationSumMismatch,
    #[msg("Маршрут ліквідності витратив більше за виданий бюджет")]
    RouteOverspent,
    #[msg("Маршрут ліквідності не видав жодної одиниці інструмента")]
    RouteFilledNothing,
}
