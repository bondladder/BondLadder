//! The backstop pool end to end (FR-016, FR-027): the admin funds it and takes
//! back only what the open positions do not need, through the vault's one
//! canonical USDC account.

use {
    anchor_lang::{
        AccountDeserialize, AccountSerialize, AnchorDeserialize, Discriminator, InstructionData,
        Space,
    },
    base64::{prelude::BASE64_STANDARD, Engine},
    bond_ladder::{
        events::{BackstopFunded, BackstopWithdrawn},
        state::Vault,
    },
    mollusk_svm::{
        result::{Check, InstructionResult},
        Mollusk,
    },
    solana_account::Account,
    solana_address::Address as Pubkey,
    solana_instruction::{AccountMeta, Instruction},
    solana_program_error::ProgramError,
    solana_program_option::COption,
    solana_program_pack::Pack,
    solana_svm_log_collector::LogCollector,
    spl_token_interface::state::{Account as SplTokenAccount, AccountState},
    std::{cell::RefCell, path::Path, rc::Rc, sync::Once},
};

const USDC_MINT: Pubkey = Pubkey::new_from_array([7u8; 32]);
const ADMIN: Pubkey = Pubkey::new_from_array([42u8; 32]);
const ADMIN_USDC: Pubkey = Pubkey::new_from_array([43u8; 32]);
const STRANGER: Pubkey = Pubkey::new_from_array([13u8; 32]);
const STRAY_VAULT_USDC: Pubkey = Pubkey::new_from_array([44u8; 32]);

const THOUSAND_USDC: u64 = 1_000_000_000;
const ADMIN_BALANCE: u64 = 20 * THOUSAND_USDC;

const ERR_ANCHOR_HAS_ONE: u32 = 2001;
const ERR_ANCHOR_ASSOCIATED: u32 = 2009;
const ERR_BACKSTOP_BELOW_OBLIGATIONS: u32 = 6022;

fn program_id() -> Pubkey {
    Pubkey::new_from_array(bond_ladder::ID.to_bytes())
}

fn token_program_id() -> Pubkey {
    Pubkey::new_from_array(anchor_spl::token::ID.to_bytes())
}

fn anchor_key(key: Pubkey) -> anchor_lang::prelude::Pubkey {
    anchor_lang::prelude::Pubkey::new_from_array(key.to_bytes())
}

fn vault_pda() -> (Pubkey, u8) {
    Pubkey::find_program_address(&[Vault::SEED], &program_id())
}

fn backstop_usdc() -> Pubkey {
    let (vault, _) = vault_pda();

    Pubkey::new_from_array(
        anchor_spl::associated_token::get_associated_token_address(
            &anchor_key(vault),
            &anchor_key(USDC_MINT),
        )
        .to_bytes(),
    )
}

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

    let mut mollusk = Mollusk::new(&program_id(), "bond_ladder");
    mollusk_svm_programs_token::token::add_program(&mut mollusk);
    mollusk
}

/// Events live only in the logs, so the collector is attached without a
/// limit: a truncated log cannot be told apart from an event never sent.
fn setup_with_logs() -> (Mollusk, Rc<RefCell<LogCollector>>) {
    let logs = LogCollector::new_ref_with_limit(None);
    let mut mollusk = setup();
    mollusk.logger = Some(Rc::clone(&logs));

    (mollusk, logs)
}

fn events<E: Discriminator + AnchorDeserialize>(logs: &Rc<RefCell<LogCollector>>) -> Vec<E> {
    logs.borrow()
        .get_recorded_content()
        .iter()
        .filter_map(|line| line.strip_prefix("Program data: "))
        .filter_map(|encoded| BASE64_STANDARD.decode(encoded).ok())
        .filter(|bytes| bytes.starts_with(E::DISCRIMINATOR))
        .map(|bytes| E::try_from_slice(&bytes[E::DISCRIMINATOR.len()..]).expect("event decodes"))
        .collect()
}

fn signer() -> Account {
    Account::new(1_000_000_000, 0, &Pubkey::default())
}

fn token_account(owner: Pubkey, amount: u64) -> Account {
    mollusk_svm_programs_token::token::create_account_for_token_account(SplTokenAccount {
        mint: USDC_MINT,
        owner,
        amount,
        delegate: COption::None,
        state: AccountState::Initialized,
        is_native: COption::None,
        delegated_amount: 0,
        close_authority: COption::None,
    })
}

fn vault_account(backstop_free_usdc: u64, total_principal_usdc: u64) -> Account {
    let (_, bump) = vault_pda();
    let vault = Vault {
        admin: anchor_key(ADMIN),
        usdc_mint: anchor_key(USDC_MINT),
        rating_oracle: anchor_key(Pubkey::new_from_array([1u8; 32])),
        issuer_program: anchor_key(Pubkey::new_from_array([2u8; 32])),
        fee_bps: 50,
        spread_coef_bps: 200,
        crank_reward_bps: 10,
        min_deposit: 100_000_000,
        capacity_usdc: 10 * THOUSAND_USDC,
        total_principal_usdc,
        backstop_free_usdc,
        backstop_locked_value: 0,
        paused: false,
        bump,
    };

    let mut data = Vec::new();
    vault.try_serialize(&mut data).expect("vault serializes");
    data.resize(8 + Vault::INIT_SPACE, 0);

    Account {
        lamports: 2_000_000,
        data,
        owner: program_id(),
        executable: false,
        rent_epoch: 0,
    }
}

fn stored_vault(result: &InstructionResult) -> Vault {
    let (vault, _) = vault_pda();
    let account = result.get_account(&vault).expect("vault exists");

    Vault::try_deserialize(&mut account.data.as_slice()).expect("vault decodes")
}

fn token_balance(result: &InstructionResult, key: &Pubkey) -> u64 {
    let account = result.get_account(key).expect("token account exists");

    SplTokenAccount::unpack(&account.data)
        .expect("token account unpacks")
        .amount
}

fn fund_ix(admin: Pubkey, pool: Pubkey, amount_micro: u64) -> Instruction {
    let (vault, _) = vault_pda();

    Instruction::new_with_bytes(
        program_id(),
        &bond_ladder::instruction::FundBackstop { amount_micro }.data(),
        vec![
            AccountMeta::new(vault, false),
            AccountMeta::new_readonly(admin, true),
            AccountMeta::new(ADMIN_USDC, false),
            AccountMeta::new(pool, false),
            AccountMeta::new_readonly(token_program_id(), false),
        ],
    )
}

fn withdraw_ix(admin: Pubkey, pool: Pubkey, amount_micro: u64) -> Instruction {
    let (vault, _) = vault_pda();

    Instruction::new_with_bytes(
        program_id(),
        &bond_ladder::instruction::WithdrawBackstop { amount_micro }.data(),
        vec![
            AccountMeta::new(vault, false),
            AccountMeta::new_readonly(admin, true),
            AccountMeta::new(pool, false),
            AccountMeta::new(ADMIN_USDC, false),
            AccountMeta::new_readonly(token_program_id(), false),
        ],
    )
}

/// The pool token account holds exactly what the counter says, as it would
/// after funding only through the program.
fn accounts(pool_micro: u64, total_principal_usdc: u64) -> Vec<(Pubkey, Account)> {
    let (vault, _) = vault_pda();

    vec![
        (vault, vault_account(pool_micro, total_principal_usdc)),
        (ADMIN, signer()),
        (STRANGER, signer()),
        (ADMIN_USDC, token_account(ADMIN, ADMIN_BALANCE)),
        (backstop_usdc(), token_account(vault, pool_micro)),
        (STRAY_VAULT_USDC, token_account(vault, pool_micro)),
        mollusk_svm_programs_token::token::keyed_account(),
    ]
}

fn only(keys: &[Pubkey], all: Vec<(Pubkey, Account)>) -> Vec<(Pubkey, Account)> {
    all.into_iter()
        .filter(|(key, _)| keys.contains(key) || *key == token_program_id())
        .collect()
}

fn fund_accounts(
    signer: Pubkey,
    pool: Pubkey,
    pool_micro: u64,
    principal: u64,
) -> Vec<(Pubkey, Account)> {
    let (vault, _) = vault_pda();

    only(
        &[vault, signer, ADMIN_USDC, pool],
        accounts(pool_micro, principal),
    )
}

#[test]
fn funding_moves_the_admins_usdc_into_the_pool_and_says_so() {
    let (mollusk, logs) = setup_with_logs();

    let result = mollusk.process_and_validate_instruction(
        &fund_ix(ADMIN, backstop_usdc(), 3 * THOUSAND_USDC),
        &fund_accounts(ADMIN, backstop_usdc(), THOUSAND_USDC, 0),
        &[Check::success()],
    );

    assert_eq!(token_balance(&result, &backstop_usdc()), 4 * THOUSAND_USDC);
    assert_eq!(
        token_balance(&result, &ADMIN_USDC),
        ADMIN_BALANCE - 3 * THOUSAND_USDC
    );
    assert_eq!(stored_vault(&result).backstop_free_usdc, 4 * THOUSAND_USDC);

    let funded = events::<BackstopFunded>(&logs);
    assert_eq!(funded.len(), 1);
    assert_eq!(funded[0].admin, anchor_key(ADMIN));
    assert_eq!(funded[0].amount_micro, 3 * THOUSAND_USDC);
    assert_eq!(funded[0].backstop_free_usdc, 4 * THOUSAND_USDC);
}

#[test]
fn the_admin_takes_back_the_surplus_above_the_open_principal() {
    let (mollusk, logs) = setup_with_logs();
    let (vault, _) = vault_pda();

    let result = mollusk.process_and_validate_instruction(
        &withdraw_ix(ADMIN, backstop_usdc(), 2 * THOUSAND_USDC),
        &only(
            &[vault, ADMIN, ADMIN_USDC, backstop_usdc()],
            accounts(5 * THOUSAND_USDC, 3 * THOUSAND_USDC),
        ),
        &[Check::success()],
    );

    assert_eq!(token_balance(&result, &backstop_usdc()), 3 * THOUSAND_USDC);
    assert_eq!(
        token_balance(&result, &ADMIN_USDC),
        ADMIN_BALANCE + 2 * THOUSAND_USDC
    );
    assert_eq!(stored_vault(&result).backstop_free_usdc, 3 * THOUSAND_USDC);

    let withdrawn = events::<BackstopWithdrawn>(&logs);
    assert_eq!(withdrawn.len(), 1);
    assert_eq!(withdrawn[0].destination, anchor_key(ADMIN_USDC));
    assert_eq!(withdrawn[0].amount_micro, 2 * THOUSAND_USDC);
    assert_eq!(withdrawn[0].backstop_free_usdc, 3 * THOUSAND_USDC);
    assert_eq!(withdrawn[0].obligations_usdc, 3 * THOUSAND_USDC);
}

/// FR-027: one micro-USDC past the open principal and nothing moves at all.
#[test]
fn a_withdrawal_that_would_dip_below_the_open_principal_moves_nothing() {
    let (mollusk, logs) = setup_with_logs();
    let (vault, _) = vault_pda();

    mollusk.process_and_validate_instruction(
        &withdraw_ix(ADMIN, backstop_usdc(), 2 * THOUSAND_USDC + 1),
        &only(
            &[vault, ADMIN, ADMIN_USDC, backstop_usdc()],
            accounts(5 * THOUSAND_USDC, 3 * THOUSAND_USDC),
        ),
        &[Check::err(ProgramError::Custom(
            ERR_BACKSTOP_BELOW_OBLIGATIONS,
        ))],
    );

    assert!(events::<BackstopWithdrawn>(&logs).is_empty());
}

#[test]
fn only_the_admin_moves_the_pool_either_way() {
    let mollusk = setup();
    let (vault, _) = vault_pda();

    mollusk.process_and_validate_instruction(
        &fund_ix(STRANGER, backstop_usdc(), THOUSAND_USDC),
        &fund_accounts(STRANGER, backstop_usdc(), 0, 0),
        &[Check::err(ProgramError::Custom(ERR_ANCHOR_HAS_ONE))],
    );
    mollusk.process_and_validate_instruction(
        &withdraw_ix(STRANGER, backstop_usdc(), THOUSAND_USDC),
        &only(
            &[vault, STRANGER, ADMIN_USDC, backstop_usdc()],
            accounts(THOUSAND_USDC, 0),
        ),
        &[Check::err(ProgramError::Custom(ERR_ANCHOR_HAS_ONE))],
    );
}

/// A second USDC account owned by the vault would let the counter and the
/// money part ways, so only the canonical one is the pool.
#[test]
fn a_vault_usdc_account_other_than_the_canonical_one_is_not_the_pool() {
    let mollusk = setup();
    let (vault, _) = vault_pda();

    mollusk.process_and_validate_instruction(
        &fund_ix(ADMIN, STRAY_VAULT_USDC, THOUSAND_USDC),
        &fund_accounts(ADMIN, STRAY_VAULT_USDC, 0, 0),
        &[Check::err(ProgramError::Custom(ERR_ANCHOR_ASSOCIATED))],
    );
    mollusk.process_and_validate_instruction(
        &withdraw_ix(ADMIN, STRAY_VAULT_USDC, THOUSAND_USDC),
        &only(
            &[vault, ADMIN, ADMIN_USDC, STRAY_VAULT_USDC],
            accounts(THOUSAND_USDC, 0),
        ),
        &[Check::err(ProgramError::Custom(ERR_ANCHOR_ASSOCIATED))],
    );
}
