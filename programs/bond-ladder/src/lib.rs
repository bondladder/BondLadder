use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod math;
pub mod profiles;
pub mod route;
pub mod selection;
pub mod state;

use instructions::*;
use profiles::RiskProfile;
use state::VaultParams;

declare_id!("5aKvW5hFUGw5hKzpz5DRYBK26EADqRHHgknmCU1EGNHe");

/// Vault, що тримає лествиці облігацій, беквстоп-пул і комісію за управління.
/// Пауза (FR-023) тут лише оголошується прапорцем: зупиняють нею депозити й
/// обслуговування, а не вихід, тому guard'и живуть у самих цих інструкціях.
#[program]
pub mod bond_ladder {
    use super::*;

    pub fn initialize_vault(ctx: Context<InitializeVault>, params: VaultParams) -> Result<()> {
        instructions::initialize_vault::handler(ctx, params)
    }

    pub fn set_rating_oracle(ctx: Context<SetRatingOracle>) -> Result<()> {
        instructions::set_config::set_rating_oracle(ctx)
    }

    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        instructions::set_config::set_paused(ctx, paused)
    }

    /// Пропозиція з п'яти інструментів передається у `remaining_accounts`
    /// четвірками: інструмент, рейтинг, мінт, кастодія vault.
    pub fn open_ladder<'info>(
        ctx: Context<'_, '_, '_, 'info, OpenLadder<'info>>,
        profile: RiskProfile,
        deposit_micro: u64,
    ) -> Result<()> {
        instructions::open_ladder::open_ladder(ctx, profile, deposit_micro)
    }
}
