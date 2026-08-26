use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct IssuerConfig {
    pub authority: Pubkey,
    pub usdc_mint: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Instrument {
    pub mint: Pubkey,
    pub issuer_id: [u8; 16],
    pub maturity_ts: i64,
    pub coupon_bps: u16,
    pub price_micro: u64,
    pub bump: u8,
}

impl IssuerConfig {
    pub const SEED: &'static [u8] = b"issuer";
}

impl Instrument {
    pub const SEED: &'static [u8] = b"instrument";
}
