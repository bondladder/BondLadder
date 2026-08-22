use anchor_lang::prelude::*;

declare_id!("EWhJjvNVb5mh1Jb9DTzvTwk7BeS9qdZdK7a6vdneQPa9");

/// Джерело нормалізованих кредитних рейтингів. Самостійна програма, а не поле
/// у vault: FR-002 вимагає конфігурованої адреси джерела, FR-024 — читання
/// стороннім протоколом без позиції у vault.
#[program]
pub mod rating_oracle {}
