//! The roll end to end (FR-017): a matured rung is redeemed at par from the
//! issuer, the face value pays the fee and buys the 18-month rung, and the
//! change below one unit's price goes back to the owner. The new instrument is
//! the caller's proposal, and every constraint of the deposit is checked on it
//! again (FR-005, SC-004).

use {
    anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, Space},
    bond_ladder::{
        profiles::{RiskProfile, RUNG_COUNT, RUNG_MONTHS},
        state::{Position, Rung, Vault},
    },
    mock_issuer::state::{Instrument, IssuerConfig},
    mollusk_svm::{
        program::{create_program_account_loader_v3, loader_keys},
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

const OPENED_AT: i64 = 1_800_000_000;
const DAY: i64 = 86_400;
const RUNG_DAYS: [i64; RUNG_COUNT] = [91, 183, 274, 365, 548];
const ROLLED_AT: i64 = OPENED_AT + RUNG_DAYS[0] * DAY;
const MAX_AGE_SECS: i64 = DAY;

const USDC_MINT: Pubkey = Pubkey::new_from_array([7u8; 32]);
const ADMIN: Pubkey = Pubkey::new_from_array([42u8; 32]);
const OWNER: Pubkey = Pubkey::new_from_array([31u8; 32]);
const STRANGER: Pubkey = Pubkey::new_from_array([13u8; 32]);
const ISSUER_TREASURY: Pubkey = Pubkey::new_from_array([33u8; 32]);
const MATURED_CUSTODY: Pubkey = Pubkey::new_from_array([120u8; 32]);
const NEXT_CUSTODY: Pubkey = Pubkey::new_from_array([129u8; 32]);

const UNITS_PER_RUNG: u64 = 200;
const POOL_UNITS: u64 = 50;
const UNIT_PRICE: u64 = 990_000;
const NEXT_PRICE: u64 = 960_000;
const NOTCH: u8 = 5;
const NEXT_INDEX: usize = 9;

const THOUSAND_USDC: u64 = 1_000_000_000;
const POOL: u64 = 5 * THOUSAND_USDC;
const TREASURY: u64 = 500_000_000;
const OWNER_BALANCE: u64 = 7;
const PRINCIPAL: u64 = 990_000_000;
const OTHER_POSITIONS_PRINCIPAL: u64 = 2 * THOUSAND_USDC;
const FEE_ALREADY_ACCRUED: u64 = 1_000;

// 91 days at 0.5% a year on 990 USDC of rungs at today's prices, over the
// julian year, on top of what was already owed. The face value of 200 units
// less that fee buys 207 units at 0.96, and the rest is change.
const PAR_PAID: u64 = 200_000_000;
const FEE_DUE: u64 = FEE_ALREADY_ACCRUED + 1_233_264;
const UNITS_BOUGHT: u64 = 207;
const SPENT: u64 = UNITS_BOUGHT * NEXT_PRICE;
const CHANGE: u64 = 45_736;

const ERR_RATING_BELOW_FLOOR: u32 = 6006;
const ERR_MATURITY_OUTSIDE_WINDOW: u32 = 6007;
const ERR_ISSUER_LIMIT_EXCEEDED: u32 = 6008;
const ERR_VAULT_PAUSED: u32 = 6012;
const ERR_RATING_UNUSABLE: u32 = 6016;
const ERR_RATING_MINT_MISMATCH: u32 = 6017;
const ERR_CUSTODY_NOT_OWNED_BY_VAULT: u32 = 6020;
const ERR_RUNG_INSTRUMENT_MISMATCH: u32 = 6027;
const ERR_NOTHING_TO_MAINTAIN: u32 = 6029;
const ERR_ANCHOR_CONSTRAINT_ASSOCIATED: u32 = 2009;
const ERR_ANCHOR_CONSTRAINT_TOKEN_OWNER: u32 = 2015;
/// mock_issuer's own code, surfaced through the CPI.
const ERR_ISSUER_TREASURY_SHORT: u32 = 6007;

fn program_id() -> Pubkey {
    Pubkey::new_from_array(bond_ladder::ID.to_bytes())
}

fn issuer_id() -> Pubkey {
    Pubkey::new_from_array(mock_issuer::ID.to_bytes())
}

fn oracle_id() -> Pubkey {
    Pubkey::new_from_array(rating_oracle::ID.to_bytes())
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

fn ata(wallet: Pubkey) -> Pubkey {
    Pubkey::new_from_array(
        anchor_spl::associated_token::get_associated_token_address(
            &anchor_key(wallet),
            &anchor_key(USDC_MINT),
        )
        .to_bytes(),
    )
}

fn vault_usdc() -> Pubkey {
    ata(vault_pda().0)
}

fn mint_key(index: usize) -> Pubkey {
    Pubkey::new_from_array([100 + index as u8; 32])
}

fn instrument_pda(index: usize) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[Instrument::SEED, mint_key(index).as_ref()], &issuer_id())
}

fn rating_pda(index: usize) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[RatingRecord::SEED, mint_key(index).as_ref()],
        &oracle_id(),
    )
}

fn issuer_tag(index: usize) -> [u8; 16] {
    [index as u8; 16]
}

fn maturity(index: usize) -> i64 {
    OPENED_AT + RUNG_DAYS[index] * DAY
}

fn next_maturity() -> i64 {
    ROLLED_AT + RUNG_DAYS[RUNG_COUNT - 1] * DAY
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

/// The issuer is its real bytecode: the roll is a redemption and a purchase
/// through it, and a stand-in would prove neither the money nor the reports.
fn setup(now_ts: i64) -> Mollusk {
    point_mollusk_at_the_built_programs();

    let mut mollusk = Mollusk::new(&program_id(), "bond_ladder");
    mollusk.add_program_with_loader(&issuer_id(), "mock_issuer", &loader_keys::LOADER_V3);
    mollusk_svm_programs_token::token::add_program(&mut mollusk);
    mollusk.sysvars.clock.unix_timestamp = now_ts;
    mollusk
}

fn owned_by<T: AccountSerialize + Space>(value: &T, owner: Pubkey) -> Account {
    let mut data = Vec::new();
    value.try_serialize(&mut data).expect("state serializes");
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

fn mint_account(supply: u64) -> Account {
    mollusk_svm_programs_token::token::create_account_for_mint(Mint {
        mint_authority: COption::Some(issuer_config_pda().0),
        supply,
        decimals: 0,
        is_initialized: true,
        freeze_authority: COption::None,
    })
}

fn vault_account(paused: bool) -> Account {
    owned_by(
        &Vault {
            admin: anchor_key(ADMIN),
            usdc_mint: anchor_key(USDC_MINT),
            rating_oracle: anchor_key(oracle_id()),
            issuer_program: anchor_key(issuer_id()),
            fee_bps: 50,
            spread_coef_bps: 200,
            crank_reward_bps: 10,
            min_deposit: 100_000_000,
            capacity_usdc: 10 * THOUSAND_USDC,
            total_principal_usdc: OTHER_POSITIONS_PRINCIPAL + PRINCIPAL,
            backstop_free_usdc: POOL,
            backstop_locked_value: 0,
            paused,
            bump: vault_pda().1,
        },
        program_id(),
    )
}

fn ladder_rungs() -> [Rung; RUNG_COUNT] {
    let mut rungs = [Rung::default(); RUNG_COUNT];
    for (index, rung) in rungs.iter_mut().enumerate() {
        *rung = Rung {
            target_months: RUNG_MONTHS[index],
            instrument: anchor_key(mint_key(index)),
            amount: UNITS_PER_RUNG,
            entry_price_micro: UNIT_PRICE,
            entry_notch: NOTCH,
            maturity_ts: maturity(index),
            flagged: false,
        };
    }

    rungs
}

fn position_account(profile: RiskProfile, rungs: [Rung; RUNG_COUNT]) -> Account {
    owned_by(
        &Position {
            owner: anchor_key(OWNER),
            profile,
            rungs,
            principal_usdc: PRINCIPAL,
            fee_accrued: FEE_ALREADY_ACCRUED,
            last_fee_ts: OPENED_AT,
            opened_at: OPENED_AT,
            bump: position_pda(profile).1,
        },
        program_id(),
    )
}

fn oracle_config_account() -> Account {
    owned_by(
        &OracleConfig {
            authority: anchor_key(ADMIN),
            max_age_secs: MAX_AGE_SECS,
            bump: oracle_config_pda().1,
        },
        oracle_id(),
    )
}

fn issuer_config_account() -> Account {
    owned_by(
        &IssuerConfig {
            authority: anchor_key(ADMIN),
            usdc_mint: anchor_key(USDC_MINT),
            bump: issuer_config_pda().1,
        },
        issuer_id(),
    )
}

fn instrument_account(
    index: usize,
    issuer: [u8; 16],
    maturity_ts: i64,
    price_micro: u64,
) -> Account {
    owned_by(
        &Instrument {
            mint: anchor_key(mint_key(index)),
            issuer_id: issuer,
            maturity_ts,
            coupon_bps: 400,
            price_micro,
            bump: instrument_pda(index).1,
        },
        issuer_id(),
    )
}

fn rating_account(index: usize, notch: u8, updated_at: i64) -> Account {
    owned_by(
        &RatingRecord {
            instrument_mint: anchor_key(mint_key(index)),
            notch,
            scale_version: SCALE_VERSION,
            agency_code: *b"MOODYS\0\0",
            updated_at,
            bump: rating_pda(index).1,
        },
        oracle_id(),
    )
}

fn maintain_ix(profile: RiskProfile, rung_index: u8) -> Instruction {
    let mut metas = vec![
        AccountMeta::new(vault_pda().0, false),
        AccountMeta::new(position_pda(profile).0, false),
        AccountMeta::new(ata(OWNER), false),
        AccountMeta::new(vault_usdc(), false),
        AccountMeta::new_readonly(oracle_config_pda().0, false),
        AccountMeta::new_readonly(issuer_id(), false),
        AccountMeta::new_readonly(issuer_config_pda().0, false),
        AccountMeta::new(ISSUER_TREASURY, false),
        AccountMeta::new(mint_key(usize::from(rung_index)), false),
        AccountMeta::new(MATURED_CUSTODY, false),
        AccountMeta::new_readonly(instrument_pda(NEXT_INDEX).0, false),
        AccountMeta::new_readonly(rating_pda(NEXT_INDEX).0, false),
        AccountMeta::new(mint_key(NEXT_INDEX), false),
        AccountMeta::new(NEXT_CUSTODY, false),
        AccountMeta::new_readonly(mollusk_svm_programs_token::token::ID, false),
    ];
    for index in 0..RUNG_COUNT {
        metas.push(AccountMeta::new_readonly(instrument_pda(index).0, false));
    }

    Instruction::new_with_bytes(
        program_id(),
        &bond_ladder::instruction::Maintain { rung_index }.data(),
        metas,
    )
}

fn accounts(profile: RiskProfile) -> Vec<(Pubkey, Account)> {
    let (vault, _) = vault_pda();
    let (issuer_config, _) = issuer_config_pda();

    let mut accounts = vec![
        (vault, vault_account(false)),
        (
            position_pda(profile).0,
            position_account(profile, ladder_rungs()),
        ),
        (ata(OWNER), token_account(USDC_MINT, OWNER, OWNER_BALANCE)),
        (vault_usdc(), token_account(USDC_MINT, vault, POOL)),
        (oracle_config_pda().0, oracle_config_account()),
        (issuer_id(), create_program_account_loader_v3(&issuer_id())),
        (issuer_config, issuer_config_account()),
        (
            ISSUER_TREASURY,
            token_account(USDC_MINT, issuer_config, TREASURY),
        ),
        (mint_key(0), mint_account(UNITS_PER_RUNG + POOL_UNITS)),
        (
            MATURED_CUSTODY,
            token_account(mint_key(0), vault, UNITS_PER_RUNG + POOL_UNITS),
        ),
        (
            instrument_pda(NEXT_INDEX).0,
            instrument_account(
                NEXT_INDEX,
                issuer_tag(NEXT_INDEX),
                next_maturity(),
                NEXT_PRICE,
            ),
        ),
        (
            rating_pda(NEXT_INDEX).0,
            rating_account(NEXT_INDEX, NOTCH, ROLLED_AT),
        ),
        (mint_key(NEXT_INDEX), mint_account(0)),
        (NEXT_CUSTODY, token_account(mint_key(NEXT_INDEX), vault, 0)),
        mollusk_svm_programs_token::token::keyed_account(),
    ];
    for index in 0..RUNG_COUNT {
        accounts.push((
            instrument_pda(index).0,
            instrument_account(index, issuer_tag(index), maturity(index), UNIT_PRICE),
        ));
    }

    accounts
}

fn replacing(
    mut accounts: Vec<(Pubkey, Account)>,
    key: Pubkey,
    account: Account,
) -> Vec<(Pubkey, Account)> {
    let slot = accounts
        .iter_mut()
        .find(|(existing, _)| *existing == key)
        .expect("the account is in the set");
    slot.1 = account;

    accounts
}

fn token_balance(result: &InstructionResult, key: &Pubkey) -> u64 {
    SplTokenAccount::unpack(&result.get_account(key).expect("exists").data)
        .expect("unpacks")
        .amount
}

fn mint_supply(result: &InstructionResult, key: &Pubkey) -> u64 {
    Mint::unpack(&result.get_account(key).expect("exists").data)
        .expect("unpacks")
        .supply
}

fn read<T: AccountDeserialize>(result: &InstructionResult, key: &Pubkey) -> T {
    let account = result.get_account(key).expect("exists");

    T::try_deserialize(&mut &account.data[..]).expect("deserializes")
}

fn refused(mollusk: &Mollusk, accounts: &[(Pubkey, Account)], code: u32) {
    mollusk.process_and_validate_instruction(
        &maintain_ix(RiskProfile::Conservative, 0),
        accounts,
        &[Check::err(ProgramError::Custom(code))],
    );
}

#[test]
fn a_matured_rung_is_rolled_into_the_eighteen_month_rung_by_anyone() {
    let mollusk = setup(ROLLED_AT);
    let profile = RiskProfile::Conservative;
    let ix = maintain_ix(profile, 0);

    assert!(
        ix.accounts.iter().all(|meta| !meta.is_signer),
        "no account has to sign the roll"
    );

    let result =
        mollusk.process_and_validate_instruction(&ix, &accounts(profile), &[Check::success()]);

    assert_eq!(
        PAR_PAID,
        FEE_DUE + SPENT + CHANGE,
        "every micro-USDC of par is accounted for"
    );
    assert_eq!(
        token_balance(&result, &ISSUER_TREASURY),
        TREASURY - PAR_PAID + SPENT
    );
    assert_eq!(token_balance(&result, &vault_usdc()), POOL + FEE_DUE);
    assert_eq!(token_balance(&result, &ata(OWNER)), OWNER_BALANCE + CHANGE);
    assert_eq!(token_balance(&result, &MATURED_CUSTODY), POOL_UNITS);
    assert_eq!(mint_supply(&result, &mint_key(0)), POOL_UNITS);
    assert_eq!(token_balance(&result, &NEXT_CUSTODY), UNITS_BOUGHT);
    assert_eq!(mint_supply(&result, &mint_key(NEXT_INDEX)), UNITS_BOUGHT);

    let vault: Vault = read(&result, &vault_pda().0);
    assert_eq!(vault.backstop_free_usdc, POOL + FEE_DUE);
    assert_eq!(
        vault.total_principal_usdc,
        OTHER_POSITIONS_PRINCIPAL + PRINCIPAL,
        "a reinvested yield is not a new deposit"
    );

    let position: Position = read(&result, &position_pda(profile).0);
    let before = ladder_rungs();
    let mut expected = [Rung::default(); RUNG_COUNT];
    for slot in 0..RUNG_COUNT - 1 {
        expected[slot] = Rung {
            target_months: RUNG_MONTHS[slot],
            ..before[slot + 1]
        };
    }
    expected[RUNG_COUNT - 1] = Rung {
        target_months: 18,
        instrument: anchor_key(mint_key(NEXT_INDEX)),
        amount: UNITS_BOUGHT,
        entry_price_micro: NEXT_PRICE,
        entry_notch: NOTCH,
        maturity_ts: next_maturity(),
        flagged: false,
    };
    assert_eq!(position.rungs, expected);
    assert_eq!(position.fee_accrued, 0);
    assert_eq!(position.last_fee_ts, ROLLED_AT);
    assert_eq!(position.principal_usdc, PRINCIPAL);
}

#[test]
fn a_rung_a_second_before_its_maturity_is_not_maintained() {
    refused(
        &setup(ROLLED_AT - 1),
        &accounts(RiskProfile::Conservative),
        ERR_NOTHING_TO_MAINTAIN,
    );
}

#[test]
fn a_matured_rung_an_exit_has_emptied_is_not_maintained() {
    let profile = RiskProfile::Conservative;
    let mut rungs = ladder_rungs();
    rungs[0].amount = 0;

    refused(
        &setup(ROLLED_AT),
        &replacing(
            accounts(profile),
            position_pda(profile).0,
            position_account(profile, rungs),
        ),
        ERR_NOTHING_TO_MAINTAIN,
    );
}

#[test]
fn maintenance_stops_while_the_vault_is_paused() {
    refused(
        &setup(ROLLED_AT),
        &replacing(
            accounts(RiskProfile::Conservative),
            vault_pda().0,
            vault_account(true),
        ),
        ERR_VAULT_PAUSED,
    );
}

#[test]
fn a_roll_into_an_instrument_below_the_profile_floor_is_refused() {
    refused(
        &setup(ROLLED_AT),
        &replacing(
            accounts(RiskProfile::Conservative),
            rating_pda(NEXT_INDEX).0,
            rating_account(NEXT_INDEX, 8, ROLLED_AT),
        ),
        ERR_RATING_BELOW_FLOOR,
    );
}

#[test]
fn a_roll_on_a_rating_older_than_the_oracle_allows_is_refused() {
    refused(
        &setup(ROLLED_AT),
        &replacing(
            accounts(RiskProfile::Conservative),
            rating_pda(NEXT_INDEX).0,
            rating_account(NEXT_INDEX, NOTCH, ROLLED_AT - MAX_AGE_SECS - 1),
        ),
        ERR_RATING_UNUSABLE,
    );
}

#[test]
fn a_rating_of_another_instrument_is_refused() {
    refused(
        &setup(ROLLED_AT),
        &replacing(
            accounts(RiskProfile::Conservative),
            rating_pda(NEXT_INDEX).0,
            rating_account(1, NOTCH, ROLLED_AT),
        ),
        ERR_RATING_MINT_MISMATCH,
    );
}

/// A year out is the 12-month rung, which the ladder already has.
#[test]
fn a_roll_outside_the_eighteen_month_window_is_refused() {
    refused(
        &setup(ROLLED_AT),
        &replacing(
            accounts(RiskProfile::Conservative),
            instrument_pda(NEXT_INDEX).0,
            instrument_account(
                NEXT_INDEX,
                issuer_tag(NEXT_INDEX),
                ROLLED_AT + 365 * DAY,
                NEXT_PRICE,
            ),
        ),
        ERR_MATURITY_OUTSIDE_WINDOW,
    );
}

#[test]
fn a_conservative_roll_into_an_issuer_the_ladder_holds_is_refused() {
    refused(
        &setup(ROLLED_AT),
        &replacing(
            accounts(RiskProfile::Conservative),
            instrument_pda(NEXT_INDEX).0,
            instrument_account(NEXT_INDEX, issuer_tag(2), next_maturity(), NEXT_PRICE),
        ),
        ERR_ISSUER_LIMIT_EXCEEDED,
    );
}

/// The matured rung's own issuer leaves with it, so rolling into it again
/// keeps a conservative ladder at one rung per issuer.
#[test]
fn a_roll_into_the_issuer_of_the_matured_rung_passes() {
    let mollusk = setup(ROLLED_AT);
    let profile = RiskProfile::Conservative;

    mollusk.process_and_validate_instruction(
        &maintain_ix(profile, 0),
        &replacing(
            accounts(profile),
            instrument_pda(NEXT_INDEX).0,
            instrument_account(NEXT_INDEX, issuer_tag(0), next_maturity(), NEXT_PRICE),
        ),
        &[Check::success()],
    );
}

#[test]
fn a_balanced_roll_admits_a_second_rung_of_one_issuer() {
    let mollusk = setup(ROLLED_AT);
    let profile = RiskProfile::Balanced;

    mollusk.process_and_validate_instruction(
        &maintain_ix(profile, 0),
        &replacing(
            accounts(profile),
            instrument_pda(NEXT_INDEX).0,
            instrument_account(NEXT_INDEX, issuer_tag(2), next_maturity(), NEXT_PRICE),
        ),
        &[Check::success()],
    );
}

/// The issuer refuses before it burns anything, so the roll fails whole and
/// the rung stays matured for the next call.
#[test]
fn a_treasury_short_of_the_face_value_refuses_the_roll_whole() {
    refused(
        &setup(ROLLED_AT),
        &replacing(
            accounts(RiskProfile::Conservative),
            ISSUER_TREASURY,
            token_account(USDC_MINT, issuer_config_pda().0, PAR_PAID - 1),
        ),
        ERR_ISSUER_TREASURY_SHORT,
    );
}

/// The caller is anyone, so the change cannot go anywhere but the owner's
/// own canonical account: not a stranger's, and not another account of the
/// owner that the caller might have been handed control of.
#[test]
fn the_change_cannot_be_sent_to_anyone_but_the_owner() {
    let profile = RiskProfile::Conservative;
    let elsewhere = Pubkey::new_from_array([77u8; 32]);

    for (destination, account, code) in [
        (
            ata(STRANGER),
            token_account(USDC_MINT, STRANGER, 0),
            ERR_ANCHOR_CONSTRAINT_TOKEN_OWNER,
        ),
        (
            elsewhere,
            token_account(USDC_MINT, OWNER, 0),
            ERR_ANCHOR_CONSTRAINT_ASSOCIATED,
        ),
    ] {
        let mut ix = maintain_ix(profile, 0);
        ix.accounts[2].pubkey = destination;
        let mut set = accounts(profile);
        set.push((destination, account));

        setup(ROLLED_AT).process_and_validate_instruction(
            &ix,
            &set,
            &[Check::err(ProgramError::Custom(code))],
        );
    }
}

#[test]
fn an_instrument_that_does_not_price_its_rung_is_refused() {
    let profile = RiskProfile::Conservative;
    let mut ix = maintain_ix(profile, 0);
    let last = ix.accounts.len() - 1;
    ix.accounts[last].pubkey = instrument_pda(NEXT_INDEX).0;

    setup(ROLLED_AT).process_and_validate_instruction(
        &ix,
        &accounts(profile),
        &[Check::err(ProgramError::Custom(
            ERR_RUNG_INSTRUMENT_MISMATCH,
        ))],
    );
}

#[test]
fn the_new_rung_must_land_in_the_vault_custody() {
    refused(
        &setup(ROLLED_AT),
        &replacing(
            accounts(RiskProfile::Conservative),
            NEXT_CUSTODY,
            token_account(mint_key(NEXT_INDEX), STRANGER, 0),
        ),
        ERR_CUSTODY_NOT_OWNED_BY_VAULT,
    );
}
