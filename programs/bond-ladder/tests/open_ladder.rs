//! Депозит (FR-008, FR-009, FR-010, FR-032) наскрізь: клієнтська пропозиція
//! перевіряється заново, п'ять щаблів купуються через маршрут, а неподільна
//! решта не списується з гаманця власника взагалі.

use {
    anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, Space},
    bond_ladder::{
        profiles::{RiskProfile, RUNG_COUNT, RUNG_MONTHS},
        state::{Position, Vault, VaultParams},
    },
    mock_issuer::state::{Instrument, IssuerConfig},
    mollusk_svm::{
        program::{
            create_program_account_loader_v3, keyed_account_for_system_program, loader_keys,
        },
        result::{Check, InstructionResult},
        Mollusk,
    },
    rating_oracle::{
        scale::SCALE_VERSION,
        state::{OracleConfig, RatingRecord},
    },
    solana_account::Account,
    solana_address::Address as Pubkey,
    solana_instruction::{AccountMeta, Instruction},
    solana_program_error::ProgramError,
    solana_program_option::COption,
    solana_program_pack::Pack,
    spl_token_interface::state::{Account as SplTokenAccount, AccountState, Mint},
    std::{path::Path, sync::Once},
};

const NOW: i64 = 1_800_000_000;
const DAY: i64 = 86_400;
const MAX_AGE_SECS: i64 = DAY;

const USDC_MINT: Pubkey = Pubkey::new_from_array([7u8; 32]);
const ADMIN: Pubkey = Pubkey::new_from_array([42u8; 32]);
const OWNER: Pubkey = Pubkey::new_from_array([31u8; 32]);
const OWNER_USDC: Pubkey = Pubkey::new_from_array([32u8; 32]);
const ISSUER_TREASURY: Pubkey = Pubkey::new_from_array([33u8; 32]);

const DEPOSIT: u64 = 1_000_000_000;
const OWNER_USDC_BALANCE: u64 = 1_500_000_000;
const MIN_DEPOSIT: u64 = 100_000_000;
const CAPACITY: u64 = 10_000_000_000;

/// Ціль щабля з `selection.rs`: round(міс × 365 / 12) днів, половина вгору.
const TARGET_DAYS: [i64; RUNG_COUNT] = [91, 183, 274, 365, 548];
const PRICES: [u64; RUNG_COUNT] = [990_000, 985_000, 1_000_000, 995_000, 1_010_000];
const NOTCH: u8 = 5;

const ERR_MATURITY_OUTSIDE_WINDOW: u32 = 6007;
const ERR_VAULT_PAUSED: u32 = 6012;
const ERR_DEPOSIT_BELOW_MINIMUM: u32 = 6013;
const ERR_VAULT_CAPACITY_EXCEEDED: u32 = 6014;
const ERR_RATING_UNUSABLE: u32 = 6016;
const ERR_CUSTODY_NOT_OWNED_BY_VAULT: u32 = 6020;
const ERR_RATING_BELOW_FLOOR: u32 = 6006;

fn program_id() -> Pubkey {
    Pubkey::new_from_array(bond_ladder::ID.to_bytes())
}

fn oracle_id() -> Pubkey {
    Pubkey::new_from_array(rating_oracle::ID.to_bytes())
}

fn issuer_id() -> Pubkey {
    Pubkey::new_from_array(mock_issuer::ID.to_bytes())
}

fn anchor_key(key: Pubkey) -> anchor_lang::prelude::Pubkey {
    anchor_lang::prelude::Pubkey::new_from_array(key.to_bytes())
}

fn vault_pda() -> (Pubkey, u8) {
    Pubkey::find_program_address(&[Vault::SEED], &program_id())
}

fn position_pda(profile: RiskProfile) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[Position::SEED, OWNER.as_ref(), &[profile.seed_byte()]],
        &program_id(),
    )
}

fn oracle_config_pda() -> (Pubkey, u8) {
    Pubkey::find_program_address(&[OracleConfig::SEED], &oracle_id())
}

fn issuer_config_pda() -> (Pubkey, u8) {
    Pubkey::find_program_address(&[IssuerConfig::SEED], &issuer_id())
}

fn instrument_mint(index: usize) -> Pubkey {
    Pubkey::new_from_array([100 + index as u8; 32])
}

fn custody(index: usize) -> Pubkey {
    Pubkey::new_from_array([120 + index as u8; 32])
}

fn instrument_pda(index: usize) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[Instrument::SEED, instrument_mint(index).as_ref()],
        &issuer_id(),
    )
}

fn rating_pda(index: usize) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[RatingRecord::SEED, instrument_mint(index).as_ref()],
        &oracle_id(),
    )
}

fn issuer_tag(index: usize) -> [u8; 16] {
    let mut id = [0u8; 16];
    id[0] = b'I';
    id[1] = b'0' + index as u8;
    id
}

fn maturity(index: usize) -> i64 {
    NOW + TARGET_DAYS[index] * DAY
}

fn point_mollusk_at_the_built_programs() {
    static ONCE: Once = Once::new();

    ONCE.call_once(|| {
        if std::env::var_os("SBF_OUT_DIR").is_none() {
            let deploy = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/deploy");
            std::env::set_var("SBF_OUT_DIR", deploy);
        }
    });
}

/// Емітента додаємо справжнім байткодом: депозит — це CPI у нього, і
/// підроблений маршрут не довів би ані руху коштів, ані звіту про обмін.
fn setup() -> Mollusk {
    point_mollusk_at_the_built_programs();

    let mut mollusk = Mollusk::new(&program_id(), "bond_ladder");
    mollusk.add_program_with_loader(&issuer_id(), "mock_issuer", &loader_keys::LOADER_V3);
    mollusk_svm_programs_token::token::add_program(&mut mollusk);
    mollusk.sysvars.clock.unix_timestamp = NOW;
    mollusk
}

fn payer() -> Account {
    Account::new(10_000_000_000, 0, &Pubkey::default())
}

fn account_owned_by<T: AccountSerialize + Space>(value: &T, owner: Pubkey) -> Account {
    let mut data = Vec::new();
    value.try_serialize(&mut data).expect("стан серіалізується");
    data.resize(8 + T::INIT_SPACE, 0);

    Account {
        lamports: 2_000_000,
        data,
        owner,
        executable: false,
        rent_epoch: 0,
    }
}

fn token_account(mint: Pubkey, owner: Pubkey, amount: u64) -> Account {
    mollusk_svm_programs_token::token::create_account_for_token_account(SplTokenAccount {
        mint,
        owner,
        amount,
        delegate: COption::None,
        state: AccountState::Initialized,
        is_native: COption::None,
        delegated_amount: 0,
        close_authority: COption::None,
    })
}

fn mint_account() -> Account {
    let (issuer_config, _) = issuer_config_pda();

    mollusk_svm_programs_token::token::create_account_for_mint(Mint {
        mint_authority: COption::Some(issuer_config),
        supply: 0,
        decimals: 0,
        is_initialized: true,
        freeze_authority: COption::None,
    })
}

fn vault_account(paused: bool, total_principal_usdc: u64) -> Account {
    let (_, bump) = vault_pda();
    let cfg = VaultParams {
        fee_bps: 50,
        spread_coef_bps: 200,
        crank_reward_bps: 10,
        min_deposit: MIN_DEPOSIT,
        capacity_usdc: CAPACITY,
    };

    account_owned_by(
        &Vault {
            admin: anchor_key(ADMIN),
            usdc_mint: anchor_key(USDC_MINT),
            rating_oracle: anchor_key(oracle_id()),
            issuer_program: anchor_key(issuer_id()),
            fee_bps: cfg.fee_bps,
            spread_coef_bps: cfg.spread_coef_bps,
            crank_reward_bps: cfg.crank_reward_bps,
            min_deposit: cfg.min_deposit,
            capacity_usdc: cfg.capacity_usdc,
            total_principal_usdc,
            backstop_free_usdc: 0,
            backstop_locked_value: 0,
            paused,
            bump,
        },
        program_id(),
    )
}

fn oracle_config_account() -> Account {
    let (_, bump) = oracle_config_pda();

    account_owned_by(
        &OracleConfig {
            authority: anchor_key(ADMIN),
            max_age_secs: MAX_AGE_SECS,
            bump,
        },
        oracle_id(),
    )
}

fn issuer_config_account() -> Account {
    let (_, bump) = issuer_config_pda();

    account_owned_by(
        &IssuerConfig {
            authority: anchor_key(ADMIN),
            usdc_mint: anchor_key(USDC_MINT),
            bump,
        },
        issuer_id(),
    )
}

fn instrument_account(index: usize, maturity_ts: i64) -> Account {
    let (_, bump) = instrument_pda(index);

    account_owned_by(
        &Instrument {
            mint: anchor_key(instrument_mint(index)),
            issuer_id: issuer_tag(index),
            maturity_ts,
            coupon_bps: 400,
            price_micro: PRICES[index],
            bump,
        },
        issuer_id(),
    )
}

fn rating_account(index: usize, notch: u8, updated_at: i64) -> Account {
    let (_, bump) = rating_pda(index);

    account_owned_by(
        &RatingRecord {
            instrument_mint: anchor_key(instrument_mint(index)),
            notch,
            scale_version: SCALE_VERSION,
            agency_code: *b"MOODYS\0\0",
            updated_at,
            bump,
        },
        oracle_id(),
    )
}

fn open_ladder_ix(profile: RiskProfile, deposit_micro: u64) -> Instruction {
    let (vault, _) = vault_pda();
    let (position, _) = position_pda(profile);
    let (oracle_config, _) = oracle_config_pda();
    let (issuer_config, _) = issuer_config_pda();

    let mut metas = vec![
        AccountMeta::new(vault, false),
        AccountMeta::new(position, false),
        AccountMeta::new(OWNER, true),
        AccountMeta::new(OWNER_USDC, false),
        AccountMeta::new_readonly(oracle_config, false),
        AccountMeta::new_readonly(issuer_id(), false),
        AccountMeta::new_readonly(issuer_config, false),
        AccountMeta::new(ISSUER_TREASURY, false),
        AccountMeta::new_readonly(mollusk_svm_programs_token::token::ID, false),
        AccountMeta::new_readonly(Pubkey::default(), false),
    ];

    for index in 0..RUNG_COUNT {
        metas.push(AccountMeta::new_readonly(instrument_pda(index).0, false));
        metas.push(AccountMeta::new_readonly(rating_pda(index).0, false));
        metas.push(AccountMeta::new(instrument_mint(index), false));
        metas.push(AccountMeta::new(custody(index), false));
    }

    Instruction::new_with_bytes(
        program_id(),
        &bond_ladder::instruction::OpenLadder {
            profile,
            deposit_micro,
        }
        .data(),
        metas,
    )
}

fn open_accounts(profile: RiskProfile) -> Vec<(Pubkey, Account)> {
    let (vault, _) = vault_pda();
    let (position, _) = position_pda(profile);
    let (oracle_config, _) = oracle_config_pda();
    let (issuer_config, _) = issuer_config_pda();

    let mut accounts = vec![
        (vault, vault_account(false, 0)),
        (position, Account::default()),
        (OWNER, payer()),
        (
            OWNER_USDC,
            token_account(USDC_MINT, OWNER, OWNER_USDC_BALANCE),
        ),
        (oracle_config, oracle_config_account()),
        (issuer_id(), create_program_account_loader_v3(&issuer_id())),
        (issuer_config, issuer_config_account()),
        (ISSUER_TREASURY, token_account(USDC_MINT, issuer_config, 0)),
        mollusk_svm_programs_token::token::keyed_account(),
        keyed_account_for_system_program(),
    ];

    for index in 0..RUNG_COUNT {
        accounts.push((
            instrument_pda(index).0,
            instrument_account(index, maturity(index)),
        ));
        accounts.push((rating_pda(index).0, rating_account(index, NOTCH, NOW)));
        accounts.push((instrument_mint(index), mint_account()));
        accounts.push((
            custody(index),
            token_account(instrument_mint(index), vault, 0),
        ));
    }

    accounts
}

fn replacing(profile: RiskProfile, key: Pubkey, account: Account) -> Vec<(Pubkey, Account)> {
    let mut accounts = open_accounts(profile);
    let slot = accounts
        .iter_mut()
        .find(|(existing, _)| *existing == key)
        .expect("акаунт є у наборі");
    slot.1 = account;

    accounts
}

fn token_balance(result: &InstructionResult, key: &Pubkey) -> u64 {
    let account = result.get_account(key).expect("токен-акаунт існує");

    SplTokenAccount::unpack(&account.data)
        .expect("токен-акаунт розпаковується")
        .amount
}

fn expected_spend() -> [u64; RUNG_COUNT] {
    let share = DEPOSIT / RUNG_COUNT as u64;
    let mut spend = [0u64; RUNG_COUNT];

    for (index, slot) in spend.iter_mut().enumerate() {
        let amount = if index == RUNG_COUNT - 1 {
            DEPOSIT - share * (RUNG_COUNT as u64 - 1)
        } else {
            share
        };
        *slot = amount - amount % PRICES[index];
    }

    spend
}

#[test]
fn open_ladder_buys_five_rungs_and_leaves_the_indivisible_change_with_the_owner() {
    let mollusk = setup();
    let profile = RiskProfile::Conservative;
    let (vault, _) = vault_pda();
    let (position, bump) = position_pda(profile);

    let spend = expected_spend();
    let principal: u64 = spend.iter().sum();

    let result = mollusk.process_and_validate_instruction(
        &open_ladder_ix(profile, DEPOSIT),
        &open_accounts(profile),
        &[Check::success()],
    );

    assert!(
        principal < DEPOSIT,
        "решта має бути неподільною, а не нулем"
    );
    assert_eq!(
        token_balance(&result, &OWNER_USDC),
        OWNER_USDC_BALANCE - principal,
        "з гаманця пішло більше, ніж вкладено"
    );
    assert_eq!(token_balance(&result, &ISSUER_TREASURY), principal);

    let stored = result.get_account(&position).expect("позицію створено");
    let decoded = Position::try_deserialize(&mut stored.data.as_slice()).expect("позиція");

    assert_eq!(decoded.owner, anchor_key(OWNER));
    assert_eq!(decoded.profile, profile);
    assert_eq!(decoded.principal_usdc, principal);
    assert_eq!(decoded.fee_accrued, 0);
    assert_eq!(decoded.last_fee_ts, NOW);
    assert_eq!(decoded.opened_at, NOW);
    assert_eq!(decoded.bump, bump);

    for index in 0..RUNG_COUNT {
        let rung = decoded.rungs[index];
        let units = spend[index] / PRICES[index];

        assert_eq!(rung.target_months, RUNG_MONTHS[index], "щабель {index}");
        assert_eq!(
            rung.instrument,
            anchor_key(instrument_mint(index)),
            "щабель {index}"
        );
        assert_eq!(rung.amount, units, "щабель {index}");
        assert_eq!(rung.entry_price_micro, PRICES[index], "щабель {index}");
        assert_eq!(rung.entry_notch, NOTCH, "щабель {index}");
        assert_eq!(rung.maturity_ts, maturity(index), "щабель {index}");
        assert!(!rung.flagged, "щабель {index}");

        assert_eq!(
            token_balance(&result, &custody(index)),
            units,
            "щабель {index}"
        );
    }

    let stored_vault = result.get_account(&vault).expect("vault існує");
    let vault_state = Vault::try_deserialize(&mut stored_vault.data.as_slice()).expect("vault");

    assert_eq!(vault_state.total_principal_usdc, principal);
}

#[test]
fn open_ladder_refuses_a_deposit_below_the_minimum() {
    let mollusk = setup();
    let profile = RiskProfile::Conservative;

    mollusk.process_and_validate_instruction(
        &open_ladder_ix(profile, MIN_DEPOSIT - 1),
        &open_accounts(profile),
        &[Check::err(ProgramError::Custom(ERR_DEPOSIT_BELOW_MINIMUM))],
    );
}

#[test]
fn open_ladder_refuses_a_deposit_that_does_not_fit_the_capacity() {
    let mollusk = setup();
    let profile = RiskProfile::Conservative;
    let (vault, _) = vault_pda();

    mollusk.process_and_validate_instruction(
        &open_ladder_ix(profile, DEPOSIT),
        &replacing(profile, vault, vault_account(false, CAPACITY - DEPOSIT + 1)),
        &[Check::err(ProgramError::Custom(
            ERR_VAULT_CAPACITY_EXCEEDED,
        ))],
    );
}

#[test]
fn open_ladder_refuses_while_the_vault_is_paused() {
    let mollusk = setup();
    let profile = RiskProfile::Conservative;
    let (vault, _) = vault_pda();

    mollusk.process_and_validate_instruction(
        &open_ladder_ix(profile, DEPOSIT),
        &replacing(profile, vault, vault_account(true, 0)),
        &[Check::err(ProgramError::Custom(ERR_VAULT_PAUSED))],
    );
}

#[test]
fn open_ladder_refuses_a_rating_older_than_the_oracle_allows() {
    let mollusk = setup();
    let profile = RiskProfile::Conservative;

    mollusk.process_and_validate_instruction(
        &open_ladder_ix(profile, DEPOSIT),
        &replacing(
            profile,
            rating_pda(2).0,
            rating_account(2, NOTCH, NOW - MAX_AGE_SECS - 1),
        ),
        &[Check::err(ProgramError::Custom(ERR_RATING_UNUSABLE))],
    );
}

#[test]
fn open_ladder_refuses_a_rating_below_the_profile_floor() {
    let mollusk = setup();
    let profile = RiskProfile::Conservative;
    let below = profile.worst_allowed_notch() + 1;

    mollusk.process_and_validate_instruction(
        &open_ladder_ix(profile, DEPOSIT),
        &replacing(profile, rating_pda(3).0, rating_account(3, below, NOW)),
        &[Check::err(ProgramError::Custom(ERR_RATING_BELOW_FLOOR))],
    );
}

/// Без цієї перевірки клієнт вказав би кастодією власний рахунок і забрав би
/// куплені інструменти з-під vault, лишивши позицію порожнім записом.
#[test]
fn open_ladder_refuses_custody_that_does_not_belong_to_the_vault() {
    let mollusk = setup();
    let profile = RiskProfile::Conservative;

    mollusk.process_and_validate_instruction(
        &open_ladder_ix(profile, DEPOSIT),
        &replacing(
            profile,
            custody(1),
            token_account(instrument_mint(1), OWNER, 0),
        ),
        &[Check::err(ProgramError::Custom(
            ERR_CUSTODY_NOT_OWNED_BY_VAULT,
        ))],
    );
}

#[test]
fn open_ladder_refuses_a_maturity_outside_the_rung_window() {
    let mollusk = setup();
    let profile = RiskProfile::Conservative;

    mollusk.process_and_validate_instruction(
        &open_ladder_ix(profile, DEPOSIT),
        &replacing(
            profile,
            instrument_pda(0).0,
            instrument_account(0, maturity(0) + 60 * DAY),
        ),
        &[Check::err(ProgramError::Custom(
            ERR_MATURITY_OUTSIDE_WINDOW,
        ))],
    );
}
