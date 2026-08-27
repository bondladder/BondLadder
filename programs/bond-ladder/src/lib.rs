use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;
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
}
