use {
    anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, Space},
    mock_issuer::state::{Instrument, IssuerConfig},
    mollusk_svm::{program::keyed_account_for_system_program, result::Check, Mollusk},
    solana_account::Account,
    solana_address::Address as Pubkey,
    solana_instruction::{AccountMeta, Instruction},
    solana_program_error::ProgramError,
    solana_program_option::COption,
    solana_program_pack::Pack,
    spl_token_interface::state::Mint,
    std::{path::Path, sync::Once},
};

const NOW: i64 = 1_800_000_000;
const YEAR_SECS: i64 = 31_536_000;

const USDC_MINT: Pubkey = Pubkey::new_from_array([7u8; 32]);
const INSTRUMENT_MINT: Pubkey = Pubkey::new_from_array([9u8; 32]);
const STRANGER: Pubkey = Pubkey::new_from_array([13u8; 32]);
const AUTHORITY: Pubkey = Pubkey::new_from_array([42u8; 32]);
const ISSUER_ID: [u8; 16] = *b"ACME-TREASURY-01";

const ERR_INVALID_PRICE: u32 = 6000;
const ERR_MATURITY_IN_THE_PAST: u32 = 6001;
const ERR_ANCHOR_HAS_ONE: u32 = 2001;

fn program_id() -> Pubkey {
    Pubkey::new_from_array(mock_issuer::ID.to_bytes())
}

fn anchor_key(key: Pubkey) -> anchor_lang::prelude::Pubkey {
    anchor_lang::prelude::Pubkey::new_from_array(key.to_bytes())
}

fn config_pda() -> (Pubkey, u8) {
    Pubkey::find_program_address(&[IssuerConfig::SEED], &program_id())
}

fn instrument_pda(mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[Instrument::SEED, mint.as_ref()], &program_id())
}

/// mollusk шукає `.so` лише у `SBF_OUT_DIR`, а `anchor build` кладе його у
/// `target/deploy` воркспейса. Без цього тест проходив би тільки з-під
/// `cargo build-sbf` і падав би з-під звичайного `cargo test`.
fn point_mollusk_at_the_built_program() {
    static ONCE: Once = Once::new();

    ONCE.call_once(|| {
        if std::env::var_os("SBF_OUT_DIR").is_none() {
            let deploy = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/deploy");
            std::env::set_var("SBF_OUT_DIR", deploy);
        }
    });
}

fn setup() -> Mollusk {
    point_mollusk_at_the_built_program();

    let mut mollusk = Mollusk::new(&program_id(), "mock_issuer");
    mollusk_svm_programs_token::token::add_program(&mut mollusk);
    mollusk.sysvars.clock.unix_timestamp = NOW;
    mollusk
}

fn payer() -> Account {
    Account::new(10_000_000_000, 0, &Pubkey::default())
}

fn usdc_mint_account() -> Account {
    mollusk_svm_programs_token::token::create_account_for_mint(Mint {
        mint_authority: COption::Some(AUTHORITY),
        supply: 0,
        decimals: 6,
        is_initialized: true,
        freeze_authority: COption::None,
    })
}

/// Акаунт із уже записаним станом. Решта тестів не має залежати від того, чи
/// відпрацював `initialize` саме в цьому прогоні.
fn account_holding<T: AccountSerialize + Space>(value: &T) -> Account {
    let mut data = Vec::new();
    value.try_serialize(&mut data).expect("стан серіалізується");
    data.resize(8 + T::INIT_SPACE, 0);

    Account {
        lamports: 2_000_000,
        data,
        owner: program_id(),
        executable: false,
        rent_epoch: 0,
    }
}

fn initialized_config() -> Account {
    let (_, bump) = config_pda();

    account_holding(&IssuerConfig {
        authority: anchor_key(AUTHORITY),
        usdc_mint: anchor_key(USDC_MINT),
        bump,
    })
}

fn registered_instrument(bump: u8) -> Account {
    account_holding(&Instrument {
        mint: anchor_key(INSTRUMENT_MINT),
        issuer_id: ISSUER_ID,
        maturity_ts: NOW + YEAR_SECS,
        coupon_bps: 425,
        price_micro: 990_000,
        bump,
    })
}

fn initialize_ix() -> Instruction {
    let (config, _) = config_pda();

    Instruction::new_with_bytes(
        program_id(),
        &mock_issuer::instruction::Initialize {}.data(),
        vec![
            AccountMeta::new(config, false),
            AccountMeta::new_readonly(USDC_MINT, false),
            AccountMeta::new(AUTHORITY, true),
            AccountMeta::new_readonly(Pubkey::default(), false),
        ],
    )
}

fn register_ix(rent: Pubkey, maturity_ts: i64, price_micro: u64) -> Instruction {
    let (config, _) = config_pda();
    let (instrument, _) = instrument_pda(&INSTRUMENT_MINT);

    Instruction::new_with_bytes(
        program_id(),
        &mock_issuer::instruction::RegisterInstrument {
            issuer_id: ISSUER_ID,
            maturity_ts,
            coupon_bps: 425,
            price_micro,
        }
        .data(),
        vec![
            AccountMeta::new_readonly(config, false),
            AccountMeta::new(INSTRUMENT_MINT, true),
            AccountMeta::new(instrument, false),
            AccountMeta::new(AUTHORITY, true),
            AccountMeta::new_readonly(mollusk_svm_programs_token::token::ID, false),
            AccountMeta::new_readonly(Pubkey::default(), false),
            AccountMeta::new_readonly(rent, false),
        ],
    )
}

fn set_price_ix(authority: Pubkey, price_micro: u64) -> Instruction {
    let (config, _) = config_pda();
    let (instrument, _) = instrument_pda(&INSTRUMENT_MINT);

    Instruction::new_with_bytes(
        program_id(),
        &mock_issuer::instruction::SetPrice { price_micro }.data(),
        vec![
            AccountMeta::new_readonly(config, false),
            AccountMeta::new(instrument, false),
            AccountMeta::new_readonly(authority, true),
        ],
    )
}

fn register_accounts(mollusk: &Mollusk) -> Vec<(Pubkey, Account)> {
    let (config, _) = config_pda();
    let (instrument, _) = instrument_pda(&INSTRUMENT_MINT);

    vec![
        (config, initialized_config()),
        (INSTRUMENT_MINT, Account::default()),
        (instrument, Account::default()),
        (AUTHORITY, payer()),
        mollusk_svm_programs_token::token::keyed_account(),
        keyed_account_for_system_program(),
        mollusk.sysvars.keyed_account_for_rent_sysvar(),
    ]
}

#[test]
fn initialize_records_the_authority_and_the_usdc_mint() {
    let mollusk = setup();
    let (config, bump) = config_pda();

    let result = mollusk.process_and_validate_instruction(
        &initialize_ix(),
        &[
            (config, Account::default()),
            (USDC_MINT, usdc_mint_account()),
            (AUTHORITY, payer()),
            keyed_account_for_system_program(),
        ],
        &[
            Check::success(),
            Check::account(&config).owner(&program_id()).build(),
        ],
    );

    let stored = result.get_account(&config).expect("конфіг створено");
    let decoded =
        IssuerConfig::try_deserialize(&mut stored.data.as_slice()).expect("конфіг декодується");

    assert_eq!(decoded.authority, anchor_key(AUTHORITY));
    assert_eq!(decoded.usdc_mint, anchor_key(USDC_MINT));
    assert_eq!(decoded.bump, bump);
}

#[test]
fn register_instrument_refuses_a_maturity_that_has_already_passed() {
    let mollusk = setup();
    let rent = mollusk.sysvars.keyed_account_for_rent_sysvar().0;

    mollusk.process_and_validate_instruction(
        &register_ix(rent, NOW - 1, 990_000),
        &register_accounts(&mollusk),
        &[Check::err(ProgramError::Custom(ERR_MATURITY_IN_THE_PAST))],
    );
}

#[test]
fn register_instrument_refuses_a_zero_price() {
    let mollusk = setup();
    let rent = mollusk.sysvars.keyed_account_for_rent_sysvar().0;

    mollusk.process_and_validate_instruction(
        &register_ix(rent, NOW + YEAR_SECS, 0),
        &register_accounts(&mollusk),
        &[Check::err(ProgramError::Custom(ERR_INVALID_PRICE))],
    );
}

#[test]
fn register_instrument_creates_a_mint_the_issuer_controls() {
    let mollusk = setup();
    let rent = mollusk.sysvars.keyed_account_for_rent_sysvar().0;
    let (config, _) = config_pda();
    let (instrument, bump) = instrument_pda(&INSTRUMENT_MINT);
    let maturity = NOW + YEAR_SECS;

    let result = mollusk.process_and_validate_instruction(
        &register_ix(rent, maturity, 990_000),
        &register_accounts(&mollusk),
        &[Check::success()],
    );

    let stored = result
        .get_account(&instrument)
        .expect("інструмент створено");
    let decoded =
        Instrument::try_deserialize(&mut stored.data.as_slice()).expect("інструмент декодується");

    assert_eq!(decoded.mint, anchor_key(INSTRUMENT_MINT));
    assert_eq!(decoded.issuer_id, ISSUER_ID);
    assert_eq!(decoded.maturity_ts, maturity);
    assert_eq!(decoded.coupon_bps, 425);
    assert_eq!(decoded.price_micro, 990_000);
    assert_eq!(decoded.bump, bump);

    let minted = result.get_account(&INSTRUMENT_MINT).expect("мінт створено");
    let minted = Mint::unpack(&minted.data).expect("мінт розпаковується");

    // Саме заради цього мінт створює програма, а не скрипт: право випуску
    // належить емітенту за побудовою, а не за домовленістю.
    assert_eq!(minted.mint_authority, COption::Some(config));
    assert_eq!(minted.decimals, 0);
}

#[test]
fn set_price_is_closed_to_anyone_but_the_authority() {
    let mollusk = setup();
    let (config, _) = config_pda();
    let (instrument, bump) = instrument_pda(&INSTRUMENT_MINT);

    mollusk.process_and_validate_instruction(
        &set_price_ix(STRANGER, 995_000),
        &[
            (config, initialized_config()),
            (instrument, registered_instrument(bump)),
            (STRANGER, payer()),
        ],
        &[Check::err(ProgramError::Custom(ERR_ANCHOR_HAS_ONE))],
    );
}

#[test]
fn set_price_moves_the_price_for_the_authority() {
    let mollusk = setup();
    let (config, _) = config_pda();
    let (instrument, bump) = instrument_pda(&INSTRUMENT_MINT);

    let result = mollusk.process_and_validate_instruction(
        &set_price_ix(AUTHORITY, 995_000),
        &[
            (config, initialized_config()),
            (instrument, registered_instrument(bump)),
            (AUTHORITY, payer()),
        ],
        &[Check::success()],
    );

    let stored = result.get_account(&instrument).expect("інструмент існує");
    let decoded =
        Instrument::try_deserialize(&mut stored.data.as_slice()).expect("інструмент декодується");

    assert_eq!(decoded.price_micro, 995_000);
}
