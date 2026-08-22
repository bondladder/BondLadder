use anchor_lang::prelude::*;

declare_id!("5aKvW5hFUGw5hKzpz5DRYBK26EADqRHHgknmCU1EGNHe");

/// Vault, що тримає лествиці облігацій, беквстоп-пул і комісію за управління.
/// Інструкції з'являються у Фазі 4 разом зі своїми тестами.
#[program]
pub mod bond_ladder {}
