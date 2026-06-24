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

    // ── claim ──────────────────────────────────────────────────────────────
    /// Worker claims their full allocation. Sends XLM back via native SAC.
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

    // ── get_allocation ─────────────────────────────────────────────────────
    /// Returns the claimable allocation for a worker in stroops.
    pub fn get_allocation(env: Env, worker: Address) -> i128 {
        let key = DataKey::Allocation(worker);
        env.storage().persistent().get(&key).unwrap_or(0)
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
    use soroban_sdk::{testutils::Address as _, Env};

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

        // Register the Stellar Asset Contract (SAC) for native token
        let token_admin = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract(token_admin.clone());
        let token_client = token::Client::new(&env, &token_id);
        let token_admin_client = token::StellarAssetClient::new(&env, &token_id);

        // Mint some tokens to employer
        token_admin_client.mint(&employer, &1000i128);
        assert_eq!(token_client.balance(&employer), 1000i128);

        // Register our ProofPayVault contract
        let contract_id = env.register(ProofPayVault, (&admin, &token_id));
        let client = ProofPayVaultClient::new(&env, &contract_id);

        // Employer deposits 400 XLM for worker
        client.deposit(&employer, &worker, &400i128);

        // Verify balances
        assert_eq!(token_client.balance(&employer), 600i128);
        assert_eq!(token_client.balance(&contract_id), 400i128);
        assert_eq!(client.get_allocation(&worker), 400i128);
        assert_eq!(client.get_total_deposited(), 400i128);

        // Worker claims the payroll
        let claimed = client.claim(&worker);
        assert_eq!(claimed, 400i128);

        // Verify claim result
        assert_eq!(token_client.balance(&worker), 400i128);
        assert_eq!(token_client.balance(&contract_id), 0i128);
        assert_eq!(client.get_allocation(&worker), 0i128);
        assert_eq!(client.get_total_deposited(), 0i128);
    }
}
