#![no_std]
use soroban_sdk::{
    contract, contractevent, contractimpl, contracttype, contracterror,
    Address, Env, token,
};

// ── Storage keys ─────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    TotalDeposited,
    Allocation(Address),
    NativeToken,
    ScheduledAllocations(Address),
    Stream(Address),
}

// ── Error codes ───────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ContractError {
    AlreadyInitialized  = 1,
    NotInitialized      = 2,
    InsufficientBalance = 3,
    NotAuthorized       = 4,
    NothingToClaim      = 5,
    InvalidAmount       = 6,
}

// ── Struct types ──────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScheduledPayment {
    pub amount: i128,
    pub release_time: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PayrollStream {
    pub sender: Address,
    pub total_amount: i128,
    pub start_time: u64,
    pub end_time: u64,
    pub claimed_amount: i128,
}

// ── Events ────────────────────────────────────────────────────────────────────

#[contractevent(topics = ["payroll_deposited"])]
pub struct PayrollDepositedEvent {
    pub from:   Address,
    pub worker: Address,
    pub amount: i128,
}

#[contractevent(topics = ["payroll_claimed"])]
pub struct PayrollClaimedEvent {
    pub worker: Address,
    pub amount: i128,
}

#[contractevent(topics = ["scheduled_deposited"])]
pub struct ScheduledDepositedEvent {
    pub from: Address,
    pub worker: Address,
    pub amount: i128,
    pub release_time: u64,
}

#[contractevent(topics = ["scheduled_claimed"])]
pub struct ScheduledClaimedEvent {
    pub worker: Address,
    pub amount: i128,
}

#[contractevent(topics = ["stream_created"])]
pub struct StreamCreatedEvent {
    pub from: Address,
    pub worker: Address,
    pub amount: i128,
    pub start_time: u64,
    pub end_time: u64,
}

#[contractevent(topics = ["stream_claimed"])]
pub struct StreamClaimedEvent {
    pub worker: Address,
    pub amount: i128,
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct ProofPayVault;

// TTL constants (~30 days at 5 s/ledger)
const TTL_THRESHOLD: u32 = 17_280;   // ~1 day
const TTL_EXTEND_TO: u32 = 518_400;  // ~30 days

#[contractimpl]
impl ProofPayVault {
    // ── Constructor (Protocol 22+) ──────────────────────────────────────────
    /// Deploy-time initialiser. Sets the admin, native token address and zeroes the total deposited.
    pub fn __constructor(env: Env, admin: Address, native_token: Address) {
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::NativeToken, &native_token);
        env.storage().instance().set(&DataKey::TotalDeposited, &0i128);
        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
    }

    // ── deposit ────────────────────────────────────────────────────────────
    /// Employer (from) deposits `amount` stroops into the vault for a worker.
    /// Uses the native XLM SAC to transfer funds into the contract.
    pub fn deposit(
        env: Env,
        from: Address,
        worker: Address,
        amount: i128,
    ) -> Result<(), ContractError> {
        from.require_auth();

        if amount <= 0 {
            return Err(ContractError::InvalidAmount);
        }

        // Get native token address from instance storage.
        let token_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::NativeToken)
            .unwrap();

        // Pull XLM from the employer into this contract via the native SAC.
        let native_token = token::Client::new(&env, &token_addr);
        let contract_addr = env.current_contract_address();
        native_token.transfer(&from, &contract_addr, &amount);

        // Update this worker's allocation.
        let key = DataKey::Allocation(worker.clone());
        let current: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        let new_alloc = current + amount;
        env.storage().persistent().set(&key, &new_alloc);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);

        // Update vault total.
        let total: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalDeposited)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::TotalDeposited, &(total + amount));
        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);

        // Emit event.
        PayrollDepositedEvent { from, worker, amount }.publish(&env);

        Ok(())
    }

    // ── deposit_scheduled ──────────────────────────────────────────────────
    /// Employer deposits XLM to be released only after `release_time` timestamp.
    pub fn deposit_scheduled(
        env: Env,
        from: Address,
        worker: Address,
        amount: i128,
        release_time: u64,
    ) -> Result<(), ContractError> {
        from.require_auth();

        if amount <= 0 {
            return Err(ContractError::InvalidAmount);
        }
        if release_time <= env.ledger().timestamp() {
            return Err(ContractError::InvalidAmount);
        }

        let token_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::NativeToken)
            .unwrap();
        let native_token = token::Client::new(&env, &token_addr);
        let contract_addr = env.current_contract_address();
        native_token.transfer(&from, &contract_addr, &amount);

        let key = DataKey::ScheduledAllocations(worker.clone());
        let mut payments: soroban_sdk::Vec<ScheduledPayment> = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| soroban_sdk::Vec::new(&env));
        
        payments.push_back(ScheduledPayment {
            amount,
            release_time,
        });
        
        env.storage().persistent().set(&key, &payments);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);

        let total: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalDeposited)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::TotalDeposited, &(total + amount));

        ScheduledDepositedEvent {
            from,
            worker,
            amount,
            release_time,
        }
        .publish(&env);

        Ok(())
    }

    // ── create_stream ──────────────────────────────────────────────────────
    /// Employer creates a streaming payroll from `start_time` to `end_time` releasing XLM continuously.
    pub fn create_stream(
        env: Env,
        from: Address,
        worker: Address,
        amount: i128,
        start_time: u64,
        end_time: u64,
    ) -> Result<(), ContractError> {
        from.require_auth();

        if amount <= 0 {
            return Err(ContractError::InvalidAmount);
        }
        if start_time >= end_time {
            return Err(ContractError::InvalidAmount);
        }
        if end_time <= env.ledger().timestamp() {
            return Err(ContractError::InvalidAmount);
        }

        let token_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::NativeToken)
            .unwrap();
        let native_token = token::Client::new(&env, &token_addr);
        let contract_addr = env.current_contract_address();
        native_token.transfer(&from, &contract_addr, &amount);

        let key = DataKey::Stream(worker.clone());
        if env.storage().persistent().has(&key) {
            let existing: PayrollStream = env.storage().persistent().get(&key).unwrap();
            if env.ledger().timestamp() < existing.end_time {
                return Err(ContractError::AlreadyInitialized);
            }
        }

        let new_stream = PayrollStream {
            sender: from.clone(),
            total_amount: amount,
            start_time,
            end_time,
            claimed_amount: 0,
        };

        env.storage().persistent().set(&key, &new_stream);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);

        let total: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalDeposited)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::TotalDeposited, &(total + amount));

        StreamCreatedEvent {
            from,
            worker,
            amount,
            start_time,
            end_time,
        }
        .publish(&env);

        Ok(())
    }

    // ── claim ──────────────────────────────────────────────────────────────
    /// Worker claims their full standard allocation. Sends XLM back via native SAC.
    pub fn claim(env: Env, worker: Address) -> Result<i128, ContractError> {
        worker.require_auth();

        let key = DataKey::Allocation(worker.clone());
        let allocation: i128 = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or(0);

        if allocation <= 0 {
            return Err(ContractError::NothingToClaim);
        }

        // Zero the allocation before transfer (checks-effects-interactions).
        env.storage().persistent().set(&key, &0i128);

        // Get native token address from instance storage.
        let token_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::NativeToken)
            .unwrap();

        // Transfer from contract to worker via native SAC.
        let native_token = token::Client::new(&env, &token_addr);
        let contract_addr = env.current_contract_address();
        native_token.transfer(&contract_addr, &worker, &allocation);

        // Update vault total.
        let total: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalDeposited)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::TotalDeposited, &(total - allocation));
        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);

        // Emit event.
        PayrollClaimedEvent {
            worker: worker.clone(),
            amount: allocation,
        }
        .publish(&env);

        Ok(allocation)
    }

    // ── claim_scheduled ────────────────────────────────────────────────────
    /// Worker claims all of their unlocked scheduled allocations.
    pub fn claim_scheduled(env: Env, worker: Address) -> Result<i128, ContractError> {
        worker.require_auth();

        let key = DataKey::ScheduledAllocations(worker.clone());
        if !env.storage().persistent().has(&key) {
            return Err(ContractError::NothingToClaim);
        }

        let payments: soroban_sdk::Vec<ScheduledPayment> = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap();

        let now = env.ledger().timestamp();
        let mut total_claimable: i128 = 0;
        let mut remaining_payments = soroban_sdk::Vec::new(&env);

        for payment in payments.iter() {
            if now >= payment.release_time {
                total_claimable += payment.amount;
            } else {
                remaining_payments.push_back(payment);
            }
        }

        if total_claimable <= 0 {
            return Err(ContractError::NothingToClaim);
        }

        env.storage().persistent().set(&key, &remaining_payments);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);

        let token_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::NativeToken)
            .unwrap();
        let native_token = token::Client::new(&env, &token_addr);
        let contract_addr = env.current_contract_address();
        native_token.transfer(&contract_addr, &worker, &total_claimable);

        let total: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalDeposited)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::TotalDeposited, &(total - total_claimable));

        ScheduledClaimedEvent {
            worker: worker.clone(),
            amount: total_claimable,
        }
        .publish(&env);

        Ok(total_claimable)
    }

    // ── claim_stream ───────────────────────────────────────────────────────
    /// Worker claims accrued amount from their current payroll stream.
    pub fn claim_stream(env: Env, worker: Address) -> Result<i128, ContractError> {
        worker.require_auth();

        let key = DataKey::Stream(worker.clone());
        if !env.storage().persistent().has(&key) {
            return Err(ContractError::NothingToClaim);
        }

        let mut stream: PayrollStream = env.storage().persistent().get(&key).unwrap();
        let now = env.ledger().timestamp();

        let accrued = if now <= stream.start_time {
            0
        } else if now >= stream.end_time {
            stream.total_amount
        } else {
            let duration = (stream.end_time - stream.start_time) as i128;
            let elapsed = (now - stream.start_time) as i128;
            (stream.total_amount * elapsed) / duration
        };

        let claimable = accrued - stream.claimed_amount;
        if claimable <= 0 {
            return Err(ContractError::NothingToClaim);
        }

        stream.claimed_amount += claimable;
        env.storage().persistent().set(&key, &stream);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);

        let token_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::NativeToken)
            .unwrap();
        let native_token = token::Client::new(&env, &token_addr);
        let contract_addr = env.current_contract_address();
        native_token.transfer(&contract_addr, &worker, &claimable);

        let total: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalDeposited)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::TotalDeposited, &(total - claimable));

        StreamClaimedEvent {
            worker: worker.clone(),
            amount: claimable,
        }
        .publish(&env);

        Ok(claimable)
    }

    // ── get_allocation ─────────────────────────────────────────────────────
    /// Returns the claimable allocation for a worker in stroops.
    pub fn get_allocation(env: Env, worker: Address) -> i128 {
        let key = DataKey::Allocation(worker);
        env.storage().persistent().get(&key).unwrap_or(0)
    }

    // ── get_scheduled_allocations ──────────────────────────────────────────
    pub fn get_scheduled_allocations(env: Env, worker: Address) -> soroban_sdk::Vec<ScheduledPayment> {
        let key = DataKey::ScheduledAllocations(worker);
        env.storage().persistent().get(&key).unwrap_or_else(|| soroban_sdk::Vec::new(&env))
    }

    // ── get_stream ─────────────────────────────────────────────────────────
    pub fn get_stream(env: Env, worker: Address) -> Option<PayrollStream> {
        let key = DataKey::Stream(worker);
        if env.storage().persistent().has(&key) {
            Some(env.storage().persistent().get(&key).unwrap())
        } else {
            None
        }
    }

    // ── get_stream_claimable ───────────────────────────────────────────────
    pub fn get_stream_claimable(env: Env, worker: Address) -> i128 {
        let key = DataKey::Stream(worker);
        if !env.storage().persistent().has(&key) {
            return 0;
        }
        let stream: PayrollStream = env.storage().persistent().get(&key).unwrap();
        let now = env.ledger().timestamp();

        let accrued = if now <= stream.start_time {
            0
        } else if now >= stream.end_time {
            stream.total_amount
        } else {
            let duration = (stream.end_time - stream.start_time) as i128;
            let elapsed = (now - stream.start_time) as i128;
            (stream.total_amount * elapsed) / duration
        };

        accrued - stream.claimed_amount
    }

    // ── get_total_deposited ────────────────────────────────────────────────
    /// Returns the total XLM deposited into the vault (stroops).
    pub fn get_total_deposited(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalDeposited)
            .unwrap_or(0)
    }

    // ── get_admin ──────────────────────────────────────────────────────────
    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap()
    }
}

// ── Unit Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::{Address as _, Ledger, LedgerInfo}, Env};

    #[test]
    fn test_constructor_sets_admin() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let native_token = Address::generate(&env);
        let contract_id = env.register(ProofPayVault, (&admin, &native_token));
        let client = ProofPayVaultClient::new(&env, &contract_id);
        assert_eq!(client.get_admin(), admin);
    }

    #[test]
    fn test_get_total_deposited_starts_zero() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let native_token = Address::generate(&env);
        let contract_id = env.register(ProofPayVault, (&admin, &native_token));
        let client = ProofPayVaultClient::new(&env, &contract_id);
        assert_eq!(client.get_total_deposited(), 0i128);
    }

    #[test]
    fn test_get_allocation_starts_zero() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let native_token = Address::generate(&env);
        let contract_id = env.register(ProofPayVault, (&admin, &native_token));
        let client = ProofPayVaultClient::new(&env, &contract_id);
        let worker = Address::generate(&env);
        assert_eq!(client.get_allocation(&worker), 0i128);
    }

    #[test]
    fn test_claim_nothing_errors() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let native_token = Address::generate(&env);
        let contract_id = env.register(ProofPayVault, (&admin, &native_token));
        let client = ProofPayVaultClient::new(&env, &contract_id);
        let worker = Address::generate(&env);
        let result = client.try_claim(&worker);
        assert!(result.is_err());
    }

    #[test]
    fn test_deposit_and_claim() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let employer = Address::generate(&env);
        let worker = Address::generate(&env);

        let token_admin = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract(token_admin.clone());
        let token_client = token::Client::new(&env, &token_id);
        let token_admin_client = token::StellarAssetClient::new(&env, &token_id);

        token_admin_client.mint(&employer, &1000i128);
        assert_eq!(token_client.balance(&employer), 1000i128);

        let contract_id = env.register(ProofPayVault, (&admin, &token_id));
        let client = ProofPayVaultClient::new(&env, &contract_id);

        client.deposit(&employer, &worker, &400i128);

        assert_eq!(token_client.balance(&employer), 600i128);
        assert_eq!(token_client.balance(&contract_id), 400i128);
        assert_eq!(client.get_allocation(&worker), 400i128);
        assert_eq!(client.get_total_deposited(), 400i128);

        let claimed = client.claim(&worker);
        assert_eq!(claimed, 400i128);

        assert_eq!(token_client.balance(&worker), 400i128);
        assert_eq!(token_client.balance(&contract_id), 0i128);
        assert_eq!(client.get_allocation(&worker), 0i128);
        assert_eq!(client.get_total_deposited(), 0i128);
    }

    #[test]
    fn test_scheduled_deposit_and_claim() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let employer = Address::generate(&env);
        let worker = Address::generate(&env);

        let token_admin = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract(token_admin.clone());
        let token_client = token::Client::new(&env, &token_id);
        let token_admin_client = token::StellarAssetClient::new(&env, &token_id);

        token_admin_client.mint(&employer, &1000i128);

        let contract_id = env.register(ProofPayVault, (&admin, &token_id));
        let client = ProofPayVaultClient::new(&env, &contract_id);

        let release_time = 1000u64;

        let mut ledger_info = env.ledger().get();
        ledger_info.timestamp = 500;
        env.ledger().set(ledger_info);

        client.deposit_scheduled(&employer, &worker, &400i128, &release_time);

        assert_eq!(token_client.balance(&employer), 600i128);
        assert_eq!(token_client.balance(&contract_id), 400i128);
        assert_eq!(client.get_total_deposited(), 400i128);

        let result = client.try_claim_scheduled(&worker);
        assert!(result.is_err());

        let mut ledger_info = env.ledger().get();
        ledger_info.timestamp = 1200;
        env.ledger().set(ledger_info);

        let claimed = client.claim_scheduled(&worker);
        assert_eq!(claimed, 400i128);

        assert_eq!(token_client.balance(&worker), 400i128);
        assert_eq!(token_client.balance(&contract_id), 0i128);
        assert_eq!(client.get_total_deposited(), 0i128);
    }

    #[test]
    fn test_streaming_deposit_and_claim() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let employer = Address::generate(&env);
        let worker = Address::generate(&env);

        let token_admin = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract(token_admin.clone());
        let token_client = token::Client::new(&env, &token_id);
        let token_admin_client = token::StellarAssetClient::new(&env, &token_id);

        token_admin_client.mint(&employer, &1000i128);

        let contract_id = env.register(ProofPayVault, (&admin, &token_id));
        let client = ProofPayVaultClient::new(&env, &contract_id);

        let mut ledger_info = env.ledger().get();
        ledger_info.timestamp = 500;
        env.ledger().set(ledger_info);

        client.create_stream(&employer, &worker, &500i128, &1000u64, &2000u64);

        assert_eq!(token_client.balance(&employer), 500i128);
        assert_eq!(token_client.balance(&contract_id), 500i128);

        let mut ledger_info = env.ledger().get();
        ledger_info.timestamp = 1200;
        env.ledger().set(ledger_info);

        assert_eq!(client.get_stream_claimable(&worker), 100i128);

        let claimed1 = client.claim_stream(&worker);
        assert_eq!(claimed1, 100i128);
        assert_eq!(token_client.balance(&worker), 100i128);

        let mut ledger_info = env.ledger().get();
        ledger_info.timestamp = 1800;
        env.ledger().set(ledger_info);

        assert_eq!(client.get_stream_claimable(&worker), 300i128);

        let claimed2 = client.claim_stream(&worker);
        assert_eq!(claimed2, 300i128);
        assert_eq!(token_client.balance(&worker), 400i128);

        let mut ledger_info = env.ledger().get();
        ledger_info.timestamp = 2500;
        env.ledger().set(ledger_info);

        assert_eq!(client.get_stream_claimable(&worker), 100i128);

        let claimed3 = client.claim_stream(&worker);
        assert_eq!(claimed3, 100i128);
        assert_eq!(token_client.balance(&worker), 500i128);
        assert_eq!(token_client.balance(&contract_id), 0i128);
    }
}
