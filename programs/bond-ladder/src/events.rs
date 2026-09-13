//! Події руху коштів (FR-022): достатні, щоб відтворити стан позиції ззовні
//! з логів транзакції, без індексатора і без читання акаунтів.

use anchor_lang::prelude::*;

use crate::profiles::{RiskProfile, RUNG_COUNT};
use crate::state::Rung;

/// Щаблі несе той самий `Rung`, що лягає в позицію: подія має відтворювати
/// записане, а власна структура була б другою правдою, яку довелось би
/// тримати синхронною вручну.
#[event]
pub struct LadderOpened {
    pub owner: Pubkey,
    pub profile: RiskProfile,
    /// Внесене і вкладене різняться на неподільну решту, яка лишається
    /// власнику (FR-032). Обидва числа в події, інакше здача читається з
    /// логів як загублені кошти.
    pub deposit_micro: u64,
    pub principal_usdc: u64,
    pub rungs: [Rung; RUNG_COUNT],
    pub opened_at: i64,
}
