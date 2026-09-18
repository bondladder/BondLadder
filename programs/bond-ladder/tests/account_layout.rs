//! Розкладка акаунтів на дроті, звірена зі спільним фікстуром.
//!
//! Той самий файл читає `packages/shared/src/schemas.test.ts`: декодер у TS —
//! друга реалізація тієї самої розкладки, і без пину вона мовчки розійдеться з
//! `state.rs` на першому ж доданому полі.
//!
//! Тест живе у `bond-ladder`, хоча перевіряє акаунти всіх трьох програм: це
//! єдиний крейт, який уже бачить обидва сусідні (через `cpi` для CPI-викликів),
//! і саме його клієнт читає всі п'ять типів.

use std::str::FromStr;

use anchor_lang::prelude::Pubkey;
use anchor_lang::AccountSerialize;
use bond_ladder::profiles::RiskProfile;
use bond_ladder::state::{Position, Rung, Vault};
use mock_issuer::state::{Instrument, IssuerConfig};
use rating_oracle::state::{OracleConfig, RatingRecord};
use serde_json::Value;

const SHARED_FIXTURE: &str = include_str!("../../../fixtures/accounts.json");

fn fixture() -> Value {
    serde_json::from_str(SHARED_FIXTURE).expect("fixtures/accounts.json — валідний JSON")
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn bytes_from_hex(text: &str) -> Vec<u8> {
    assert!(text.len().is_multiple_of(2), "hex непарної довжини: {text}");

    (0..text.len())
        .step_by(2)
        .map(|start| u8::from_str_radix(&text[start..start + 2], 16).expect("hex-байт"))
        .collect()
}

fn serialized<T: AccountSerialize>(account: &T) -> String {
    let mut buffer = Vec::new();
    account.try_serialize(&mut buffer).expect("серіалізація");
    hex(&buffer)
}

fn address(value: &Value) -> Pubkey {
    Pubkey::from_str(value.as_str().expect("адреса — рядок")).expect("адреса у base58")
}

fn small<T: TryFrom<u64>>(value: &Value) -> T {
    T::try_from(value.as_u64().expect("очікувалось число"))
        .unwrap_or_else(|_| panic!("число не влазить у поле: {value}"))
}

fn wide(value: &Value) -> u64 {
    value
        .as_str()
        .expect("64-бітне число у фікстурі — рядок")
        .parse()
        .expect("64-бітне число")
}

fn signed(value: &Value) -> i64 {
    value
        .as_str()
        .expect("64-бітне число у фікстурі — рядок")
        .parse()
        .expect("64-бітне число")
}

fn flag(value: &Value) -> bool {
    value.as_bool().expect("очікувалось true/false")
}

/// Мітка на дроті — ASCII, доповнений нулями до повної довжини.
fn tag<const N: usize>(value: &Value) -> [u8; N] {
    let text = value.as_str().expect("мітка — рядок");
    assert!(text.len() <= N, "мітка {text} не влазить у [u8; {N}]");

    let mut buffer = [0u8; N];
    buffer[..text.len()].copy_from_slice(text.as_bytes());
    buffer
}

fn vault(decoded: &Value) -> Vault {
    Vault {
        admin: address(&decoded["admin"]),
        usdc_mint: address(&decoded["usdcMint"]),
        rating_oracle: address(&decoded["ratingOracle"]),
        issuer_program: address(&decoded["issuerProgram"]),
        fee_bps: small(&decoded["feeBps"]),
        spread_coef_bps: small(&decoded["spreadCoefBps"]),
        crank_reward_bps: small(&decoded["crankRewardBps"]),
        min_deposit: wide(&decoded["minDeposit"]),
        capacity_usdc: wide(&decoded["capacityUsdc"]),
        total_principal_usdc: wide(&decoded["totalPrincipalUsdc"]),
        backstop_free_usdc: wide(&decoded["backstopFreeUsdc"]),
        backstop_locked_value: wide(&decoded["backstopLockedValue"]),
        paused: flag(&decoded["paused"]),
        bump: small(&decoded["bump"]),
    }
}

fn rung(decoded: &Value) -> Rung {
    Rung {
        target_months: small(&decoded["targetMonths"]),
        instrument: address(&decoded["instrument"]),
        amount: wide(&decoded["amount"]),
        entry_price_micro: wide(&decoded["entryPriceMicro"]),
        entry_notch: small(&decoded["entryNotch"]),
        maturity_ts: signed(&decoded["maturityTs"]),
        flagged: flag(&decoded["flagged"]),
    }
}

fn position(decoded: &Value) -> Position {
    let rungs: Vec<Rung> = decoded["rungs"]
        .as_array()
        .expect("щаблі — масив")
        .iter()
        .map(rung)
        .collect();

    Position {
        owner: address(&decoded["owner"]),
        profile: match decoded["profile"].as_str().expect("профіль — рядок") {
            "conservative" => RiskProfile::Conservative,
            "balanced" => RiskProfile::Balanced,
            other => panic!("у фікстурі невідомий профіль {other}"),
        },
        rungs: rungs.try_into().expect("у позиції рівно п'ять щаблів"),
        principal_usdc: wide(&decoded["principalUsdc"]),
        fee_accrued: wide(&decoded["feeAccrued"]),
        last_fee_ts: signed(&decoded["lastFeeTs"]),
        opened_at: signed(&decoded["openedAt"]),
        bump: small(&decoded["bump"]),
    }
}

fn oracle_config(decoded: &Value) -> OracleConfig {
    OracleConfig {
        authority: address(&decoded["authority"]),
        max_age_secs: signed(&decoded["maxAgeSecs"]),
        bump: small(&decoded["bump"]),
    }
}

fn rating_record(decoded: &Value) -> RatingRecord {
    RatingRecord {
        instrument_mint: address(&decoded["instrumentMint"]),
        notch: small(&decoded["notch"]),
        scale_version: small(&decoded["scaleVersion"]),
        agency_code: tag(&decoded["agencyCode"]),
        updated_at: signed(&decoded["updatedAt"]),
        bump: small(&decoded["bump"]),
    }
}

fn issuer_config(decoded: &Value) -> IssuerConfig {
    IssuerConfig {
        authority: address(&decoded["authority"]),
        usdc_mint: address(&decoded["usdcMint"]),
        bump: small(&decoded["bump"]),
    }
}

fn instrument(decoded: &Value) -> Instrument {
    Instrument {
        mint: address(&decoded["mint"]),
        issuer_id: tag(&decoded["issuerId"]),
        maturity_ts: signed(&decoded["maturityTs"]),
        coupon_bps: small(&decoded["couponBps"]),
        price_micro: wide(&decoded["priceMicro"]),
        bump: small(&decoded["bump"]),
    }
}

#[test]
fn account_layouts_match_the_shared_fixture() {
    let fixture = fixture();
    let accounts = fixture["accounts"].as_array().expect("accounts — масив");
    assert_eq!(accounts.len(), 9);

    for entry in accounts {
        let case = entry["case"].as_str().expect("case — рядок");
        let decoded = &entry["decoded"];

        let observed = match entry["account"].as_str().expect("account — рядок") {
            "Vault" => serialized(&vault(decoded)),
            "OracleConfig" => serialized(&oracle_config(decoded)),
            "RatingRecord" => serialized(&rating_record(decoded)),
            "IssuerConfig" => serialized(&issuer_config(decoded)),
            "Instrument" => serialized(&instrument(decoded)),
            "Position" => serialized(&position(decoded)),
            other => panic!("у фікстурі невідомий акаунт {other}"),
        };

        assert_eq!(
            observed,
            entry["data"].as_str().expect("data — рядок"),
            "випадок {case}"
        );
    }
}

/// base58 у TS написаний з нуля, тож вектори з провідними нулями і з максимумом
/// беруться від того, хто вже вміє: `Pubkey` серіалізує адресу сам.
#[test]
fn addresses_match_the_shared_fixture() {
    let fixture = fixture();
    let addresses = fixture["addresses"].as_array().expect("addresses — масив");
    assert!(!addresses.is_empty());

    for entry in addresses {
        let raw = entry["bytes"].as_str().expect("bytes — рядок");
        let bytes: [u8; 32] = bytes_from_hex(raw).try_into().expect("адреса — 32 байти");

        assert_eq!(
            Pubkey::new_from_array(bytes).to_string(),
            entry["address"].as_str().expect("address — рядок"),
            "байти {raw}"
        );
    }
}
