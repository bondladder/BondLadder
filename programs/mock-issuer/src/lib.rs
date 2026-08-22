use anchor_lang::prelude::*;

declare_id!("EX1tNj2MLTacJPfAVzbBW8ejFsnSp7AsnZvnRLmDy3vK");

/// ДЕМО-ЗАГЛУШКА. Випускає токенізовані інструменти за USDC і викуповує їх
/// ЛИШЕ після дати погашення (FR-026). На mainnet її місце займає справжній
/// маршрут ліквідності — межа проходить по внутрішньому інтерфейсу з FR-021.
#[program]
pub mod mock_issuer {}
