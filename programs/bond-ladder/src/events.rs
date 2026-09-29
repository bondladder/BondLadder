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

/// The pool after the transfer rides along, so the free balance can be
/// followed from the logs alone.
#[event]
pub struct BackstopFunded {
    pub admin: Pubkey,
    pub amount_micro: u64,
    pub backstop_free_usdc: u64,
}

/// The floor the withdrawal was held to rides along with the balance it left,
/// so the logs show it stayed above the open positions (FR-027).
#[event]
pub struct BackstopWithdrawn {
    pub admin: Pubkey,
    pub destination: Pubkey,
    pub amount_micro: u64,
    pub backstop_free_usdc: u64,
    pub obligations_usdc: u64,
}

/// One rung's share of an exit. Price and rating are read at the exit rather
/// than copied from the entry: they are what the pool took the risk on at.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ExitedRung {
    pub instrument: Pubkey,
    pub units: u64,
    pub price_micro: u64,
    pub notch: u8,
    pub scale_version: u8,
    /// A stale rating does not hold up an exit (FR-023), so its age rides
    /// along for whoever reads the event to judge.
    pub rated_at: i64,
}

/// Fee, spread and payout add up to the gross value, so the logs show where
/// every micro-USDC of it went. The pool's free balance after the payout
/// rides along, as it does on funding and withdrawal.
#[event]
#[derive(Clone)]
pub struct LadderExited {
    pub owner: Pubkey,
    pub profile: RiskProfile,
    pub share_bps: u16,
    pub rungs: [ExitedRung; RUNG_COUNT],
    pub gross_value_micro: u64,
    pub fee_charged_micro: u64,
    /// Owed by what remains of the position; nonzero only on a partial exit
    /// too thin to cover the fee.
    pub fee_carried_micro: u64,
    pub wrd_days: u64,
    pub spread_micro: u64,
    pub payout_micro: u64,
    pub principal_micro: u64,
    pub backstop_free_usdc: u64,
    pub exited_at: i64,
}
