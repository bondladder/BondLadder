//! Розкладка `open_ladder` на дроті, звірена зі спільним фікстуром.
//!
//! Той самий файл читає `packages/shared/src/instructions.test.ts`. Веб не має
//! ані IDL, ані згенерованих типів — `target/` не комітиться, — тому кодує
//! інструкцію сам. Без цього пину перейменована інструкція чи переставлений
//! акаунт виявились би відмовою транзакції на devnet, а не червоним тестом.

use anchor_lang::prelude::{AccountMeta, Pubkey};
use anchor_lang::{Discriminator, InstructionData, ToAccountMetas};
use bond_ladder::accounts::{ExitLadder, OpenLadder};
use bond_ladder::instruction::{ExitLadder as ExitLadderArgs, OpenLadder as OpenLadderArgs};
use bond_ladder::profiles::RiskProfile;
use bond_ladder::state::{BackstopHolding, Position, Vault};
use serde_json::Value;

const SHARED_FIXTURE: &str = include_str!("../../../fixtures/instructions.json");

fn fixture() -> Value {
    serde_json::from_str(SHARED_FIXTURE).expect("fixtures/instructions.json — валідний JSON")
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn profile_named(name: &str) -> RiskProfile {
    match name {
        "conservative" => RiskProfile::Conservative,
        "balanced" => RiskProfile::Balanced,
        other => panic!("у фікстурі невідомий профіль {other}"),
    }
}

/// Кожен акаунт отримує адресу, виведену з його імені у фікстурі. Порядок
/// метаданих тоді доводить не лише права, а й те, який саме акаунт стоїть на
/// місці: переставлені поля структури дадуть чужий маркер, а не збіг прав.
fn marker(name: &str) -> Pubkey {
    let mut bytes = [0u8; 32];
    bytes[..name.len().min(32)].copy_from_slice(&name.as_bytes()[..name.len().min(32)]);
    Pubkey::new_from_array(bytes)
}

fn metas() -> Vec<AccountMeta> {
    OpenLadder {
        vault: marker("vault"),
        position: marker("position"),
        owner: marker("owner"),
        owner_usdc: marker("ownerUsdc"),
        oracle_config: marker("oracleConfig"),
        issuer_program: marker("issuerProgram"),
        issuer_config: marker("issuerConfig"),
        issuer_treasury: marker("issuerTreasury"),
        token_program: marker("tokenProgram"),
        system_program: marker("systemProgram"),
    }
    .to_account_metas(None)
}

fn exit_metas() -> Vec<AccountMeta> {
    ExitLadder {
        vault: marker("vault"),
        position: marker("position"),
        owner: marker("owner"),
        owner_usdc: marker("ownerUsdc"),
        backstop_usdc: marker("backstopUsdc"),
        token_program: marker("tokenProgram"),
        system_program: marker("systemProgram"),
    }
    .to_account_metas(None)
}

fn assert_slots(observed: &[AccountMeta], expected: &Value) {
    let expected = expected.as_array().expect("accounts is an array");
    assert_eq!(observed.len(), expected.len());

    for (index, slot) in expected.iter().enumerate() {
        let name = slot["name"].as_str().expect("name is a string");
        let meta = &observed[index];

        assert_eq!(meta.pubkey, marker(name), "slot {index} is not {name}");
        assert_eq!(
            meta.is_signer,
            slot["signer"].as_bool().expect("signer is a bool"),
            "signer on {name}"
        );
        assert_eq!(
            meta.is_writable,
            slot["writable"].as_bool().expect("writable is a bool"),
            "writable on {name}"
        );
    }
}

#[test]
fn exit_ladder_data_matches_the_shared_fixture() {
    let fixture = fixture();
    let exit_ladder = &fixture["exitLadder"];

    assert_eq!(
        hex(ExitLadderArgs::DISCRIMINATOR),
        exit_ladder["discriminator"]
            .as_str()
            .expect("discriminator is a string")
    );

    let cases = exit_ladder["cases"].as_array().expect("cases is an array");
    assert!(!cases.is_empty());

    for entry in cases {
        let args = ExitLadderArgs {
            share_bps: u16::try_from(entry["shareBps"].as_u64().expect("shareBps is a number"))
                .expect("shareBps fits u16"),
            min_payout_micro: entry["minPayoutMicro"]
                .as_str()
                .expect("minPayoutMicro is a string")
                .parse()
                .expect("minPayoutMicro fits u64"),
        };

        assert_eq!(
            hex(&args.data()),
            entry["data"].as_str().expect("data is a string"),
            "case {}",
            entry["case"].as_str().expect("case is a string")
        );
    }
}

#[test]
fn exit_ladder_accounts_match_the_shared_fixture() {
    assert_slots(&exit_metas(), &fixture()["exitLadder"]["accounts"]);
}

#[test]
fn open_ladder_data_matches_the_shared_fixture() {
    let fixture = fixture();
    let open_ladder = &fixture["openLadder"];

    assert_eq!(
        hex(OpenLadderArgs::DISCRIMINATOR),
        open_ladder["discriminator"]
            .as_str()
            .expect("discriminator — рядок")
    );

    let cases = open_ladder["cases"].as_array().expect("cases — масив");
    assert!(!cases.is_empty());

    for entry in cases {
        let args = OpenLadderArgs {
            profile: profile_named(entry["profile"].as_str().expect("профіль — рядок")),
            deposit_micro: entry["depositMicro"]
                .as_str()
                .expect("депозит у фікстурі — рядок")
                .parse()
                .expect("64-бітне число"),
        };

        assert_eq!(
            hex(&args.data()),
            entry["data"].as_str().expect("data — рядок"),
            "випадок {}",
            entry["case"].as_str().expect("case — рядок")
        );
    }
}

#[test]
fn open_ladder_accounts_match_the_shared_fixture() {
    let fixture = fixture();
    let expected = fixture["openLadder"]["accounts"]
        .as_array()
        .expect("accounts — масив");
    let observed = metas();

    assert_eq!(observed.len(), expected.len());

    for (index, slot) in expected.iter().enumerate() {
        let name = slot["name"].as_str().expect("name — рядок");
        let meta = &observed[index];

        assert_eq!(meta.pubkey, marker(name), "місце {index} займає не {name}");
        assert_eq!(
            meta.is_signer,
            slot["signer"].as_bool().expect("signer — true/false"),
            "підпис у {name}"
        );
        assert_eq!(
            meta.is_writable,
            slot["writable"].as_bool().expect("writable — true/false"),
            "запис у {name}"
        );
    }
}

#[test]
fn seeds_and_profile_bytes_match_the_shared_fixture() {
    let fixture = fixture();
    let seeds = &fixture["seeds"];

    assert_eq!(Vault::SEED, seeds["vault"].as_str().unwrap().as_bytes());
    assert_eq!(
        Position::SEED,
        seeds["position"].as_str().unwrap().as_bytes()
    );
    assert_eq!(
        rating_oracle::state::OracleConfig::SEED,
        seeds["oracle"].as_str().unwrap().as_bytes()
    );
    assert_eq!(
        mock_issuer::state::IssuerConfig::SEED,
        seeds["issuer"].as_str().unwrap().as_bytes()
    );
    assert_eq!(
        mock_issuer::state::Instrument::SEED,
        seeds["instrument"].as_str().unwrap().as_bytes()
    );
    assert_eq!(
        rating_oracle::state::RatingRecord::SEED,
        seeds["rating"].as_str().unwrap().as_bytes()
    );
    assert_eq!(
        BackstopHolding::SEED,
        seeds["backstop"].as_str().unwrap().as_bytes()
    );

    for entry in fixture["profileSeedBytes"]
        .as_array()
        .expect("profileSeedBytes — масив")
    {
        let profile = profile_named(entry["profile"].as_str().expect("профіль — рядок"));

        assert_eq!(
            u64::from(profile.seed_byte()),
            entry["seedByte"].as_u64().expect("seedByte — число")
        );
    }
}
