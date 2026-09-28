//! The instant exit end to end (FR-012, FR-031): the pool pays USDC out of its
//! free balance, takes the instruments on as holdings, and what remains of a
//! partial exit is the same ladder, only smaller.

use {
    anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, Space},
    bond_ladder::{
        profiles::{RiskProfile, RUNG_COUNT, RUNG_MONTHS},
        state::{BackstopHolding, Position, Rung, Vault},
    },
    mock_issuer::state::Instrument,
    mollusk_svm::{
        program::keyed_account_for_system_program,
        result::{Check, InstructionResult},
        Mollusk,
    },
    solana_account::Account,
    solana_address::Address as Pubkey,
    solana_instruction::{AccountMeta, Instruction},
    solana_program_error::ProgramError,
    solana_program_option::COption,
    solana_program_pack::Pack,
    spl_token_interface::state::{Account as SplTokenAccount, AccountState},
    std::{path::Path, sync::Once},
};

const NOW: i64 = 1_800_000_000;
const DAY: i64 = 86_400;
const JULIAN_YEAR: i64 = 31_557_600;
const RUNG_DAYS: [i64; RUNG_COUNT] = [91, 183, 274, 365, 548];

const USDC_MINT: Pubkey = Pubkey::new_from_array([7u8; 32]);
const ADMIN: Pubkey = Pubkey::new_from_array([42u8; 32]);
const OWNER: Pubkey = Pubkey::new_from_array([31u8; 32]);
const OWNER_USDC: Pubkey = Pubkey::new_from_array([32u8; 32]);
const STRANGER: Pubkey = Pubkey::new_from_array([13u8; 32]);

const THOUSAND_USDC: u64 = 1_000_000_000;
const UNITS_PER_RUNG: u64 = 200;
const UNIT_PRICE: u64 = 1_000_000;
const FEE_ALREADY_ACCRUED: u64 = 1_000;
const POOL: u64 = 5 * THOUSAND_USDC;
const OTHER_POSITIONS_PRINCIPAL: u64 = 2 * THOUSAND_USDC;
const POSITION_LAMPORTS: u64 = 5_000_000;
const OWNER_LAMPORTS: u64 = 1_000_000_000;

// A year held at 0.5% on 1000 USDC is 5 USDC, on top of what was already owed.
// Payouts were worked out with exact fractions over 365.25 days: 292 weighted
// days, 200 bps a year, off the value net of that fee.
const FULL_EXIT_PAYOUT: u64 = 979_089_913;
const QUARTER_EXIT_PAYOUT: u64 = 241_081_700;

const ERR_ANCHOR_CONSTRAINT_SEEDS: u32 = 2006;
const ERR_FOREIGN_ACCOUNT_OWNER: u32 = 6018;
const ERR_RUNG_INSTRUMENT_MISMATCH: u32 = 6027;

fn program_id() -> Pubkey {
    Pubkey::new_from_array(bond_ladder::ID.to_bytes())
}

fn issuer_id() -> Pubkey {
    Pubkey::new_from_array(mock_issuer::ID.to_bytes())
}

fn token_program_id() -> Pubkey {
    Pubkey::new_from_array(anchor_spl::token::ID.to_bytes())
}

fn system_program_id() -> Pubkey {
    keyed_account_for_system_program().0
}

fn anchor_key(key: Pubkey) -> anchor_lang::prelude::Pubkey {
    anchor_lang::prelude::Pubkey::new_from_array(key.to_bytes())
}

fn vault_pda() -> (Pubkey, u8) {
    Pubkey::find_program_address(&[Vault::SEED], &program_id())
}

fn position_pda() -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            Position::SEED,
            OWNER.as_ref(),
            &[RiskProfile::Balanced.seed_byte()],
        ],
        &program_id(),
    )
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

fn instrument_mint(index: usize) -> Pubkey {
    Pubkey::new_from_array([100 + index as u8; 32])
}

fn instrument_pda(index: usize) -> Pubkey {
    Pubkey::find_program_address(
        &[Instrument::SEED, instrument_mint(index).as_ref()],
        &issuer_id(),
    )
    .0
}

fn holding_pda(index: usize) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[BackstopHolding::SEED, instrument_mint(index).as_ref()],
        &program_id(),
    )
}

fn maturity(index: usize) -> i64 {
    NOW + RUNG_DAYS[index] * DAY
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
    mollusk.sysvars.clock.unix_timestamp = NOW;
    mollusk
}

fn owned_by<T: AccountSerialize + Space>(value: &T, owner: Pubkey, lamports: u64) -> Account {
    let mut data = Vec::new();
    value.try_serialize(&mut data).expect("state serializes");
    data.resize(8 + T::INIT_SPACE, 0);

    Account {
        lamports,
        data,
        owner,
        executable: false,
        rent_epoch: 0,
    }
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

fn vault_account(paused: bool) -> Account {
    let (_, bump) = vault_pda();

    owned_by(
        &Vault {
            admin: anchor_key(ADMIN),
            usdc_mint: anchor_key(USDC_MINT),
            rating_oracle: anchor_key(Pubkey::new_from_array([1u8; 32])),
            issuer_program: anchor_key(issuer_id()),
            fee_bps: 50,
            spread_coef_bps: 200,
            crank_reward_bps: 10,
            min_deposit: 100_000_000,
            capacity_usdc: 10 * THOUSAND_USDC,
            total_principal_usdc: OTHER_POSITIONS_PRINCIPAL + THOUSAND_USDC,
            backstop_free_usdc: POOL,
            backstop_locked_value: 0,
            paused,
            bump,
        },
        program_id(),
        2_000_000,
    )
}

fn position_account() -> Account {
    let (_, bump) = position_pda();
    let mut rungs = [Rung::default(); RUNG_COUNT];
    for (index, rung) in rungs.iter_mut().enumerate() {
        *rung = Rung {
            target_months: RUNG_MONTHS[index],
            instrument: anchor_key(instrument_mint(index)),
            amount: UNITS_PER_RUNG,
            entry_price_micro: UNIT_PRICE,
            entry_notch: 5,
            maturity_ts: maturity(index),
            flagged: false,
        };
    }

    owned_by(
        &Position {
            owner: anchor_key(OWNER),
            profile: RiskProfile::Balanced,
            rungs,
            principal_usdc: THOUSAND_USDC,
            fee_accrued: FEE_ALREADY_ACCRUED,
            last_fee_ts: NOW - JULIAN_YEAR,
            opened_at: NOW - JULIAN_YEAR,
            bump,
        },
        program_id(),
        POSITION_LAMPORTS,
    )
}

fn instrument_account(index: usize, owner: Pubkey) -> Account {
    owned_by(
        &Instrument {
            mint: anchor_key(instrument_mint(index)),
            issuer_id: [index as u8; 16],
            maturity_ts: maturity(index),
            coupon_bps: 400,
            price_micro: UNIT_PRICE,
            bump: 255,
        },
        owner,
        2_000_000,
    )
}

fn holding_account(index: usize, amount: u64) -> Account {
    let (_, bump) = holding_pda(index);

    owned_by(
        &BackstopHolding {
            instrument: anchor_key(instrument_mint(index)),
            amount,
            maturity_ts: maturity(index),
            bump,
        },
        program_id(),
        2_000_000,
    )
}

fn exit_ix(
    signer: Pubkey,
    share_bps: u16,
    rung_pairs: [(Pubkey, Pubkey); RUNG_COUNT],
) -> Instruction {
    let (vault, _) = vault_pda();
    let (position, _) = position_pda();

    let mut metas = vec![
        AccountMeta::new(vault, false),
        AccountMeta::new(position, false),
        AccountMeta::new(signer, true),
        AccountMeta::new(OWNER_USDC, false),
        AccountMeta::new(backstop_usdc(), false),
        AccountMeta::new_readonly(token_program_id(), false),
        AccountMeta::new_readonly(system_program_id(), false),
    ];
    for (instrument, holding) in rung_pairs {
        metas.push(AccountMeta::new_readonly(instrument, false));
        metas.push(AccountMeta::new(holding, false));
    }

    Instruction::new_with_bytes(
        program_id(),
        &bond_ladder::instruction::ExitLadder { share_bps }.data(),
        metas,
    )
}

fn rung_pairs() -> [(Pubkey, Pubkey); RUNG_COUNT] {
    std::array::from_fn(|index| (instrument_pda(index), holding_pda(index).0))
}

/// Holdings start absent — the pool has never taken these instruments on.
fn accounts() -> Vec<(Pubkey, Account)> {
    let (vault, _) = vault_pda();
    let (position, _) = position_pda();

    let mut accounts = vec![
        (vault, vault_account(false)),
        (position, position_account()),
        (OWNER, Account::new(OWNER_LAMPORTS, 0, &system_program_id())),
        (
            STRANGER,
            Account::new(OWNER_LAMPORTS, 0, &system_program_id()),
        ),
        (OWNER_USDC, token_account(OWNER, 0)),
        (backstop_usdc(), token_account(vault, POOL)),
        mollusk_svm_programs_token::token::keyed_account(),
        keyed_account_for_system_program(),
    ];
    for index in 0..RUNG_COUNT {
        accounts.push((
            instrument_pda(index),
            instrument_account(index, issuer_id()),
        ));
        accounts.push((holding_pda(index).0, Account::default()));
    }

    accounts
}

fn replacing(
    mut accounts: Vec<(Pubkey, Account)>,
    key: Pubkey,
    account: Account,
) -> Vec<(Pubkey, Account)> {
    accounts
        .iter_mut()
        .find(|(existing, _)| *existing == key)
        .expect("the account is in the set")
        .1 = account;

    accounts
}

fn token_balance(result: &InstructionResult, key: &Pubkey) -> u64 {
    let account = result.get_account(key).expect("token account exists");

    SplTokenAccount::unpack(&account.data)
        .expect("token account unpacks")
        .amount
}

fn stored<T: AccountDeserialize>(result: &InstructionResult, key: &Pubkey) -> T {
    let account = result.get_account(key).expect("account exists");

    T::try_deserialize(&mut account.data.as_slice()).expect("account decodes")
}

#[test]
fn a_full_exit_pays_the_quote_hands_the_pool_every_unit_and_closes_the_position() {
    let mollusk = setup();
    let (vault, _) = vault_pda();
    let (position, _) = position_pda();

    let result = mollusk.process_and_validate_instruction(
        &exit_ix(OWNER, 10_000, rung_pairs()),
        &accounts(),
        &[Check::success()],
    );

    assert_eq!(token_balance(&result, &OWNER_USDC), FULL_EXIT_PAYOUT);
    assert_eq!(
        token_balance(&result, &backstop_usdc()),
        POOL - FULL_EXIT_PAYOUT
    );

    let pool: Vault = stored(&result, &vault);
    assert_eq!(pool.backstop_free_usdc, POOL - FULL_EXIT_PAYOUT);
    assert_eq!(pool.total_principal_usdc, OTHER_POSITIONS_PRINCIPAL);
    assert_eq!(pool.backstop_locked_value, THOUSAND_USDC);

    let closed = result.get_account(&position).expect("position is reported");
    assert_eq!(closed.lamports, 0);
    assert!(closed.data.is_empty());

    let holding_rent = mollusk
        .sysvars
        .rent
        .minimum_balance(8 + BackstopHolding::INIT_SPACE);
    for index in 0..RUNG_COUNT {
        let (address, bump) = holding_pda(index);
        let holding: BackstopHolding = stored(&result, &address);
        assert_eq!(holding.instrument, anchor_key(instrument_mint(index)));
        assert_eq!(holding.amount, UNITS_PER_RUNG);
        assert_eq!(holding.maturity_ts, maturity(index));
        assert_eq!(holding.bump, bump);
        assert_eq!(
            result
                .get_account(&address)
                .expect("holding exists")
                .lamports,
            holding_rent
        );
    }

    // The owner paid the holdings' rent and got the position's back.
    assert_eq!(
        result.get_account(&OWNER).expect("owner exists").lamports,
        OWNER_LAMPORTS + POSITION_LAMPORTS - RUNG_COUNT as u64 * holding_rent
    );
}

/// US2: what a partial exit leaves is the same ladder with the same
/// proportions, and the whole fee is settled (FR-020).
#[test]
fn a_partial_exit_leaves_the_same_ladder_smaller_and_settles_the_fee() {
    let mollusk = setup();
    let (vault, _) = vault_pda();
    let (position, _) = position_pda();

    let result = mollusk.process_and_validate_instruction(
        &exit_ix(OWNER, 2_500, rung_pairs()),
        &accounts(),
        &[Check::success()],
    );

    assert_eq!(token_balance(&result, &OWNER_USDC), QUARTER_EXIT_PAYOUT);

    let remaining: Position = stored(&result, &position);
    for (index, rung) in remaining.rungs.iter().enumerate() {
        assert_eq!(rung.amount, 150, "rung {index}");
        assert_eq!(rung.instrument, anchor_key(instrument_mint(index)));
        assert_eq!(rung.maturity_ts, maturity(index));
        assert_eq!(rung.entry_price_micro, UNIT_PRICE);
    }
    assert_eq!(remaining.principal_usdc, 750_000_000);
    assert_eq!(remaining.fee_accrued, 0);
    assert_eq!(remaining.last_fee_ts, NOW);
    assert_eq!(remaining.opened_at, NOW - JULIAN_YEAR);

    let pool: Vault = stored(&result, &vault);
    assert_eq!(pool.backstop_free_usdc, POOL - QUARTER_EXIT_PAYOUT);
    assert_eq!(
        pool.total_principal_usdc,
        OTHER_POSITIONS_PRINCIPAL + 750_000_000
    );
    assert_eq!(pool.backstop_locked_value, 250_000_000);

    for index in 0..RUNG_COUNT {
        let holding: BackstopHolding = stored(&result, &holding_pda(index).0);
        assert_eq!(holding.amount, 50, "rung {index}");
    }
}

#[test]
fn a_holding_the_pool_already_has_grows_by_the_units_taken() {
    let mollusk = setup();
    let mut set = accounts();
    for index in 0..RUNG_COUNT {
        set = replacing(set, holding_pda(index).0, holding_account(index, 10));
    }

    let result = mollusk.process_and_validate_instruction(
        &exit_ix(OWNER, 2_500, rung_pairs()),
        &set,
        &[Check::success()],
    );

    for index in 0..RUNG_COUNT {
        let holding: BackstopHolding = stored(&result, &holding_pda(index).0);
        assert_eq!(holding.amount, 60, "rung {index}");
    }
}

/// Anyone can send lamports to an address. Were that enough to stop the
/// holding from being created, one transfer would block every exit through
/// that instrument.
#[test]
fn lamports_sent_to_a_holding_address_in_advance_do_not_block_the_exit() {
    let mollusk = setup();
    let set = replacing(
        accounts(),
        holding_pda(2).0,
        Account::new(1, 0, &system_program_id()),
    );

    let result = mollusk.process_and_validate_instruction(
        &exit_ix(OWNER, 10_000, rung_pairs()),
        &set,
        &[Check::success()],
    );

    let holding: BackstopHolding = stored(&result, &holding_pda(2).0);
    assert_eq!(holding.amount, UNITS_PER_RUNG);
}

/// FR-023: the pause stops deposits and maintenance, never an exit.
#[test]
fn a_paused_vault_still_lets_the_owner_out() {
    let mollusk = setup();
    let (vault, _) = vault_pda();

    let result = mollusk.process_and_validate_instruction(
        &exit_ix(OWNER, 10_000, rung_pairs()),
        &replacing(accounts(), vault, vault_account(true)),
        &[Check::success()],
    );

    assert_eq!(token_balance(&result, &OWNER_USDC), FULL_EXIT_PAYOUT);
}

/// FR-010: only the owning wallet disposes of the position.
#[test]
fn a_stranger_cannot_exit_someone_elses_position() {
    let mollusk = setup();

    mollusk.process_and_validate_instruction(
        &exit_ix(STRANGER, 10_000, rung_pairs()),
        &accounts(),
        &[Check::err(ProgramError::Custom(
            ERR_ANCHOR_CONSTRAINT_SEEDS,
        ))],
    );
}

/// The price comes from the account, so an account the issuer program does
/// not own could name any price it liked.
#[test]
fn a_price_from_an_account_the_issuer_does_not_own_is_refused() {
    let mollusk = setup();

    mollusk.process_and_validate_instruction(
        &exit_ix(OWNER, 10_000, rung_pairs()),
        &replacing(
            accounts(),
            instrument_pda(3),
            instrument_account(3, STRANGER),
        ),
        &[Check::err(ProgramError::Custom(ERR_FOREIGN_ACCOUNT_OWNER))],
    );
}

#[test]
fn an_instrument_priced_against_the_wrong_rung_is_refused() {
    let mollusk = setup();
    let mut pairs = rung_pairs();
    pairs.swap(0, 1);
    for (index, pair) in pairs.iter_mut().enumerate() {
        pair.1 = holding_pda(index).0;
    }

    mollusk.process_and_validate_instruction(
        &exit_ix(OWNER, 10_000, pairs),
        &accounts(),
        &[Check::err(ProgramError::Custom(
            ERR_RUNG_INSTRUMENT_MISMATCH,
        ))],
    );
}

#[test]
fn a_holding_of_another_instrument_is_refused() {
    let mollusk = setup();
    let mut pairs = rung_pairs();
    pairs[0].1 = holding_pda(1).0;

    mollusk.process_and_validate_instruction(
        &exit_ix(OWNER, 10_000, pairs),
        &accounts(),
        &[Check::err(ProgramError::Custom(
            ERR_ANCHOR_CONSTRAINT_SEEDS,
        ))],
    );
}
