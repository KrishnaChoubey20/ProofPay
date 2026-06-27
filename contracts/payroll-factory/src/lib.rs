#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, Address, Env, BytesN,
};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    VaultWasmHash,
    AdminVault(Address),
    AllVaults,
}

#[contract]
pub struct ProofPayFactory;

#[contractimpl]
impl ProofPayFactory {
    pub fn __constructor(env: Env, admin: Address, wasm_hash: BytesN<32>) {
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::VaultWasmHash, &wasm_hash);
    }
    
    pub fn update_wasm_hash(env: Env, new_wasm_hash: BytesN<32>) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        env.storage().instance().set(&DataKey::VaultWasmHash, &new_wasm_hash);
    }
    
    pub fn get_wasm_hash(env: Env) -> BytesN<32> {
        env.storage().instance().get(&DataKey::VaultWasmHash).unwrap()
    }

    pub fn get_admin(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Admin).unwrap()
    }
    
    pub fn deploy_vault(env: Env, admin: Address, native_token: Address, salt: BytesN<32>) -> Address {
        admin.require_auth();
        
        let wasm_hash: BytesN<32> = env.storage().instance().get(&DataKey::VaultWasmHash).unwrap();
        
        // Prepare constructor arguments: admin, native_token
        let mut constructor_args = soroban_sdk::Vec::new(&env);
        constructor_args.push_back(admin.to_val());
        constructor_args.push_back(native_token.to_val());
        
        // Deploy child contract
        let deployed_address = env
            .deployer()
            .with_current_contract(salt)
            .deploy_v2(wasm_hash, constructor_args);
            
        // Store the vault address mapped to admin
        let admin_key = DataKey::AdminVault(admin.clone());
        env.storage().persistent().set(&admin_key, &deployed_address);
        
        // Append to list of all deployed vaults
        let all_key = DataKey::AllVaults;
        let mut all_vaults: soroban_sdk::Vec<Address> = env
            .storage()
            .persistent()
            .get(&all_key)
            .unwrap_or_else(|| soroban_sdk::Vec::new(&env));
        all_vaults.push_back(deployed_address.clone());
        env.storage().persistent().set(&all_key, &all_vaults);
        
        // Emit event
        env.events().publish(
            (soroban_sdk::symbol_short!("deployed"), admin),
            deployed_address.clone()
        );
        
        deployed_address
    }
    
    pub fn get_vault(env: Env, admin: Address) -> Option<Address> {
        let admin_key = DataKey::AdminVault(admin);
        env.storage().persistent().get(&admin_key)
    }
    
    pub fn get_all_vaults(env: Env) -> soroban_sdk::Vec<Address> {
        env.storage().persistent().get(&DataKey::AllVaults).unwrap_or_else(|| soroban_sdk::Vec::new(&env))
    }
}

// ── Unit / Integration Tests ──────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};

    // Import the compiled payroll-vault WASM to get its bytes for mock deployment in testing.
    // The compiled WASM is generated when we run `cargo build --target wasm32-unknown-unknown --release`.
    mod vault_wasm {
        soroban_sdk::contractimport!(
            file = "../target/wasm32v1-none/release/payroll_vault.wasm"
        );
    }

    #[test]
    fn test_factory_deploy_vault() {
        let env = Env::default();
        env.mock_all_auths();

        let factory_admin = Address::generate(&env);
        let vault_admin = Address::generate(&env);
        let native_token = Address::generate(&env);

        // Upload the vault Wasm to get the hash
        let vault_wasm_hash = env.deployer().upload_contract_wasm(vault_wasm::WASM);

        // Register the factory contract
        let factory_id = env.register(ProofPayFactory, (&factory_admin, &vault_wasm_hash));
        let factory_client = ProofPayFactoryClient::new(&env, &factory_id);

        assert_eq!(factory_client.get_wasm_hash(), vault_wasm_hash);
        assert_eq!(factory_client.get_admin(), factory_admin);

        // Deploy a vault
        let salt = soroban_sdk::BytesN::from_array(&env, &[0u8; 32]);
        let vault_address = factory_client.deploy_vault(&vault_admin, &native_token, &salt);

        // Verify registration
        assert_eq!(factory_client.get_vault(&vault_admin), Some(vault_address.clone()));
        assert_eq!(factory_client.get_all_vaults(), soroban_sdk::vec![&env, vault_address.clone()]);
    }
}
