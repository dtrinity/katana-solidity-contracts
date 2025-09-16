## dSTAKE — High‑Level Overview

dSTAKE is a yield‑bearing stablecoin vault. Users deposit dSTABLE (e.g., dUSD) and receive dSTAKE shares (ERC4626). The vault routes capital into external lending protocols via pluggable adapters and accrues yield back to dSTABLE terms. This document gives a compact mental model and pointers into the code.

### What You Get

- A single ERC4626 vault token (`DStakeToken`) representing a pro‑rata claim on diversified yield strategies.
- Transparent accounting in the vault’s unit of account (dSTABLE).
- Pluggable adapters to connect to multiple lending protocols and wrappers.
- Optional reward managers to surface/compound external incentive tokens.

### Core Pieces

- `DStakeToken` (ERC4626, upgradeable)
  - File: `contracts/vaults/dstake/DStakeToken.sol`
  - Mints/Burns shares against dSTABLE deposits/withdrawals.
  - Delegates strategy interaction to a router and reads TVL from the collateral vault.
  - Supports a configurable withdrawal fee with previews that reflect net amounts.

- `DStakeCollateralVault` (asset store, non‑upgradeable)
  - File: `contracts/vaults/dstake/DStakeCollateralVault.sol`
  - Custodies “vault assets” (e.g., ERC4626 wrapper shares from external protocols).
  - Computes `totalValueInDStable()` by asking registered adapters to value held assets.
  - Grants `ROUTER_ROLE` to the active router; governance can rotate routers.

- Router V2 (orchestration, non-upgradeable)
  - File: `contracts/vaults/dstake/DStakeRouterV2.sol`
  - Deterministically selects and splits deposits across multiple configured vaults based on target allocations.
  - Routes withdrawals across over-allocated vaults, enforcing exact fulfillment with shared buffer/shortfall logic.
  - Manages `vaultAsset → adapter` mappings, deterministic vault configs, and collateral exchanges.
  - Governable caps (`maxVaultsPerOperation`, `maxVaultCount`) and pausing provide operational controls.

- Adapters (protocol integrations)
  - Interface: `contracts/vaults/dstake/interfaces/IDStableConversionAdapter.sol`
  - Example implementations:
    - `MetaMorphoConversionAdapter.sol` — ERC4626 MetaMorpho vaults
    - `WrappedDLendConversionAdapter.sol` — wrapped lending tokens
  - Responsibilities: convert dSTABLE↔vault‑asset, provide previews, and report asset value in dSTABLE.

- Rewards (optional)
  - Example: `contracts/vaults/dstake/rewards/DStakeRewardManagerMetaMorpho.sol`
  - Automates claiming/compounding of external rewards when the underlying protocol supports them.

### How It Works

- Deposit / Mint
  - User deposits dSTABLE into `DStakeToken` and receives shares.
  - Token approves the router and calls `router.deposit(amount)`.
  - Router routes dSTABLE through the selected adapter(s) and mints vault assets directly to the collateral vault according to target allocations.

- Withdraw / Redeem
  - User requests dSTABLE (net of withdrawal fee); shares are burned.
  - Token calls `router.withdraw(netAmount, receiver, owner)`.
  - Router pulls needed vault assets from the collateral vault, converts back to dSTABLE via adapter(s), and transfers to the receiver, reverting if the configured vault set cannot satisfy the request.
  - Shared buffer/shortfall logic covers minor adapter rounding, and surplus can be swept back into the portfolio.

- Yield Accrual
  - Vault assets (e.g., ERC4626 shares) accrue yield upstream; valuation is measured in dSTABLE.
  - `DStakeToken.totalAssets()` proxies to `DStakeCollateralVault.totalValueInDStable()`.

- Rebalancing & Exchanges
  - Governance/ops can exchange between supported vault assets through adapters using dSTABLE as the intermediary.
  - Router V2 maintains deterministic allocation towards configured target weights and includes a manual collateral exchange helper.

### Risk & Safety Model

- Access Control
  - Token: `DEFAULT_ADMIN_ROLE`, `FEE_MANAGER_ROLE`.
  - Router V2: `DSTAKE_TOKEN_ROLE` (only token may call deposit/withdraw), `ADAPTER_MANAGER_ROLE`, `CONFIG_MANAGER_ROLE`, `COLLATERAL_EXCHANGER_ROLE`, `VAULT_MANAGER_ROLE`, `PAUSER_ROLE`.
  - Collateral Vault: `DEFAULT_ADMIN_ROLE`, `ROUTER_ROLE` (granted to active router).

- Guards & Invariants
  - Unit of account is dSTABLE; all previews/valuations are in dSTABLE terms.
  - Adapters are single‑purpose per vault asset and must mint/return the expected token.
  - Slippage and value‑parity checks use adapter previews and a governable `dustTolerance`.
  - Unknown tokens dusted to the collateral vault are ignored in valuation, preserving liveness.
  - Router V2 is pausable for deposit/withdraw paths.

### Extending dSTAKE

- Add a New Protocol
  - Implement `IDStableConversionAdapter` for the target vault asset.
  - Register the adapter in the router; the collateral vault will list the asset on first use.
  - Provide vault configs and target allocations when onboarding additional strategies.

- Change Routing
  - Router V2 deterministically covers both single- and multi-vault flows.
  - Routers are non-upgradeable by design; governance can deploy a new router and rotate via `setRouter` on token/vault.

- Upgrade & Parameters
  - `DStakeToken` is upgradeable; routers and collateral vault are replaceable.
  - Governance can set withdrawal fees (capped), dust tolerance, default deposit asset, vault configs, and pause the router.

### Developer Map

- Token: `contracts/vaults/dstake/DStakeToken.sol`
- Collateral Vault: `contracts/vaults/dstake/DStakeCollateralVault.sol`
- Router: `contracts/vaults/dstake/DStakeRouterV2.sol`
- Adapters: `contracts/vaults/dstake/adapters/`
- Interfaces: `contracts/vaults/dstake/interfaces/`
- Rewards (optional): `contracts/vaults/dstake/rewards/`

### Mental Model (TL;DR)

- dSTAKE is an ERC4626 vault over dSTABLE that outsources allocation to a router.
- The router uses adapters to hop between dSTABLE and protocol‑specific vault assets.
- The collateral vault only holds assets and reports their value in dSTABLE.
- Yield happens upstream; dSTAKE reflects it in share price. Governance tunes routes, fees, and allocations.
