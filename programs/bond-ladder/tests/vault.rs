use {
    anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, Space},
    bond_ladder::state::{Vault, VaultParams, BPS_DENOMINATOR},
    mollusk_svm::{
        program::{create_program_account_loader_v3, keyed_account_for_system_program},
        result::Check,
        Mollusk,
    },
    solana_account::Account,
    solana_address::Address as Pubkey,
    solana_instruction::{AccountMeta, Instruction},
    solana_program_error::ProgramError,
    solana_program_option::COption,
    spl_token_interface::state::Mint,
    std::{path::Path, sync::Once},
};

const USDC_MINT: Pubkey = Pubkey::new_from_array([7u8; 32]);
const STRANGER: Pubkey = Pubkey::new_from_array([13u8; 32]);
const ADMIN: Pubkey = Pubkey::new_from_array([42u8; 32]);

const ERR_INVALID_BPS: u32 = 6000;
const ERR_INVALID_DEPOSIT_BOUNDS: u32 = 6001;
const ERR_EXPECTED_PROGRAM: u32 = 6002;
const ERR_ANCHOR_HAS_ONE: u32 = 2001;

fn program_id() -> Pubkey {
    Pubkey::new_from_array(bond_ladder::ID.to_bytes())
}

fn rating_oracle_id() -> Pubkey {
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

/// mollusk шукає `.so` лише у `SBF_OUT_DIR`, а `anchor build` кладе його у
/// `target/deploy` воркспейса.
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

    Mollusk::new(&program_id(), "bond_ladder")
}

fn payer() -> Account {
    Account::new(10_000_000_000, 0, &Pubkey::default())
}

fn usdc_mint_account() -> Account {
    mollusk_svm_programs_token::token::create_account_for_mint(Mint {
        mint_authority: COption::Some(ADMIN),
        supply: 0,
        decimals: 6,
        is_initialized: true,
        freeze_authority: COption::None,
    })
}

fn params() -> VaultParams {
    VaultParams {
        fee_bps: 50,
        spread_coef_bps: 200,
        crank_reward_bps: 10,
        min_deposit: 100_000_000,
        capacity_usdc: 10_000_000_000,
    }
}

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

fn initialized_vault() -> Account {
    let (_, bump) = vault_pda();
    let cfg = params();

    account_holding(&Vault {
        admin: anchor_key(ADMIN),
        usdc_mint: anchor_key(USDC_MINT),
        rating_oracle: anchor_key(rating_oracle_id()),
        issuer_program: anchor_key(issuer_id()),
        fee_bps: cfg.fee_bps,
        spread_coef_bps: cfg.spread_coef_bps,
        crank_reward_bps: cfg.crank_reward_bps,
        min_deposit: cfg.min_deposit,
        capacity_usdc: cfg.capacity_usdc,
        total_principal_usdc: 0,
        backstop_free_usdc: 0,
        backstop_locked_value: 0,
        paused: false,
        bump,
    })
}

fn stored_vault(account: &Account) -> Vault {
    Vault::try_deserialize(&mut account.data.as_slice()).expect("vault декодується")
}

fn initialize_ix(rating_oracle: Pubkey, cfg: VaultParams) -> Instruction {
    let (vault, _) = vault_pda();

    Instruction::new_with_bytes(
        program_id(),
        &bond_ladder::instruction::InitializeVault { params: cfg }.data(),
        vec![
            AccountMeta::new(vault, false),
            AccountMeta::new_readonly(USDC_MINT, false),
            AccountMeta::new_readonly(rating_oracle, false),
            AccountMeta::new_readonly(issuer_id(), false),
            AccountMeta::new(ADMIN, true),
            AccountMeta::new_readonly(Pubkey::default(), false),
        ],
    )
}

fn initialize_accounts(rating_oracle: Pubkey, oracle_account: Account) -> Vec<(Pubkey, Account)> {
    let (vault, _) = vault_pda();

    vec![
        (vault, Account::default()),
        (USDC_MINT, usdc_mint_account()),
        (rating_oracle, oracle_account),
        (issuer_id(), create_program_account_loader_v3(&issuer_id())),
        (ADMIN, payer()),
        keyed_account_for_system_program(),
    ]
}

fn set_rating_oracle_ix(admin: Pubkey, rating_oracle: Pubkey) -> Instruction {
    let (vault, _) = vault_pda();

    Instruction::new_with_bytes(
        program_id(),
        &bond_ladder::instruction::SetRatingOracle {}.data(),
        vec![
            AccountMeta::new(vault, false),
            AccountMeta::new_readonly(rating_oracle, false),
            AccountMeta::new_readonly(admin, true),
        ],
    )
}

fn set_paused_ix(admin: Pubkey, paused: bool) -> Instruction {
    let (vault, _) = vault_pda();

    Instruction::new_with_bytes(
        program_id(),
        &bond_ladder::instruction::SetPaused { paused }.data(),
        vec![
            AccountMeta::new(vault, false),
            AccountMeta::new_readonly(admin, true),
        ],
    )
}

#[test]
fn initialize_vault_records_the_configuration_and_starts_unpaused() {
    let mollusk = setup();
    let (vault, bump) = vault_pda();
    let oracle = rating_oracle_id();

    let result = mollusk.process_and_validate_instruction(
        &initialize_ix(oracle, params()),
        &initialize_accounts(oracle, create_program_account_loader_v3(&oracle)),
        &[
            Check::success(),
            Check::account(&vault).owner(&program_id()).build(),
        ],
    );

    let decoded = stored_vault(result.get_account(&vault).expect("vault створено"));

    assert_eq!(decoded.admin, anchor_key(ADMIN));
    assert_eq!(decoded.usdc_mint, anchor_key(USDC_MINT));
    assert_eq!(decoded.rating_oracle, anchor_key(oracle));
    assert_eq!(decoded.issuer_program, anchor_key(issuer_id()));
    assert_eq!(decoded.fee_bps, 50);
    assert_eq!(decoded.spread_coef_bps, 200);
    assert_eq!(decoded.crank_reward_bps, 10);
    assert_eq!(decoded.min_deposit, 100_000_000);
    assert_eq!(decoded.capacity_usdc, 10_000_000_000);
    assert_eq!(decoded.total_principal_usdc, 0);
    assert_eq!(decoded.backstop_free_usdc, 0);
    assert_eq!(decoded.backstop_locked_value, 0);
    assert!(!decoded.paused);
    assert_eq!(decoded.bump, bump);
}

#[test]
fn initialize_vault_refuses_a_rate_above_one_hundred_percent() {
    let mollusk = setup();
    let oracle = rating_oracle_id();
    let broken = VaultParams {
        fee_bps: BPS_DENOMINATOR + 1,
        ..params()
    };

    mollusk.process_and_validate_instruction(
        &initialize_ix(oracle, broken),
        &initialize_accounts(oracle, create_program_account_loader_v3(&oracle)),
        &[Check::err(ProgramError::Custom(ERR_INVALID_BPS))],
    );
}

#[test]
fn initialize_vault_refuses_a_capacity_below_the_minimum_deposit() {
    let mollusk = setup();
    let oracle = rating_oracle_id();
    let broken = VaultParams {
        capacity_usdc: 99_999_999,
        ..params()
    };

    mollusk.process_and_validate_instruction(
        &initialize_ix(oracle, broken),
        &initialize_accounts(oracle, create_program_account_loader_v3(&oracle)),
        &[Check::err(ProgramError::Custom(ERR_INVALID_DEPOSIT_BOUNDS))],
    );
}

// Помилка адміністратора в адресі джерела інакше спливла б аж на першому
// депозиті — записи рейтингів просто не належали б нічому виконуваному.
#[test]
fn initialize_vault_refuses_a_rating_source_that_is_not_a_program() {
    let mollusk = setup();

    mollusk.process_and_validate_instruction(
        &initialize_ix(STRANGER, params()),
        &initialize_accounts(STRANGER, payer()),
        &[Check::err(ProgramError::Custom(ERR_EXPECTED_PROGRAM))],
    );
}

#[test]
fn set_paused_is_closed_to_anyone_but_the_admin() {
    let mollusk = setup();
    let (vault, _) = vault_pda();

    mollusk.process_and_validate_instruction(
        &set_paused_ix(STRANGER, true),
        &[(vault, initialized_vault()), (STRANGER, payer())],
        &[Check::err(ProgramError::Custom(ERR_ANCHOR_HAS_ONE))],
    );
}

#[test]
fn set_paused_raises_and_lowers_the_flag() {
    let mollusk = setup();
    let (vault, _) = vault_pda();

    let paused = mollusk.process_and_validate_instruction(
        &set_paused_ix(ADMIN, true),
        &[(vault, initialized_vault()), (ADMIN, payer())],
        &[Check::success()],
    );
    assert!(stored_vault(paused.get_account(&vault).expect("vault існує")).paused);

    let resumed = mollusk.process_and_validate_instruction(
        &set_paused_ix(ADMIN, false),
        &[
            (
                vault,
                paused.get_account(&vault).expect("vault існує").clone(),
            ),
            (ADMIN, payer()),
        ],
        &[Check::success()],
    );
    assert!(!stored_vault(resumed.get_account(&vault).expect("vault існує")).paused);
}

#[test]
fn set_rating_oracle_repoints_the_vault_at_another_source() {
    let mollusk = setup();
    let (vault, _) = vault_pda();
    let another = issuer_id();

    let result = mollusk.process_and_validate_instruction(
        &set_rating_oracle_ix(ADMIN, another),
        &[
            (vault, initialized_vault()),
            (another, create_program_account_loader_v3(&another)),
            (ADMIN, payer()),
        ],
        &[Check::success()],
    );

    let decoded = stored_vault(result.get_account(&vault).expect("vault існує"));

    assert_eq!(decoded.rating_oracle, anchor_key(another));
}

#[test]
fn set_rating_oracle_is_closed_to_anyone_but_the_admin() {
    let mollusk = setup();
    let (vault, _) = vault_pda();
    let another = issuer_id();

    mollusk.process_and_validate_instruction(
        &set_rating_oracle_ix(STRANGER, another),
        &[
            (vault, initialized_vault()),
            (another, create_program_account_loader_v3(&another)),
            (STRANGER, payer()),
        ],
        &[Check::err(ProgramError::Custom(ERR_ANCHOR_HAS_ONE))],
    );
}
