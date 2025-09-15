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

- Routers (orchestration, non‑upgradeable)
  - Base Router: `contracts/vaults/dstake/DStakeRouter.sol`
    - Converts dSTABLE to a default vault asset on deposit and back on withdrawal.
    - Manages `vaultAsset → adapter` mappings, slippage/value‑parity checks, and exchanges.
  - Morpho Router: `contracts/vaults/dstake/DStakeRouterMorpho.sol`
    - Extends the base router with deterministic multi‑vault selection and target allocations.
    - Splits deposits and sources withdrawals across configured MetaMorpho vaults.
    - Pausable; includes simple, manual collateral exchange for ops.

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
  - Router routes dSTABLE through the selected adapter(s) and mints vault assets directly to the collateral vault.
  - With `DStakeRouterMorpho`, deposits may be split across multiple configured vaults.

- Withdraw / Redeem
  - User requests dSTABLE (net of withdrawal fee); shares are burned.
  - Token calls `router.withdraw(netAmount, receiver, owner)`.
  - Router pulls needed vault assets from the collateral vault, converts back to dSTABLE via adapter(s), and transfers to the receiver.
  - Shortfalls/surplus are handled conservatively; the router exposes simple surplus sweep controls.

- Yield Accrual
  - Vault assets (e.g., ERC4626 shares) accrue yield upstream; valuation is measured in dSTABLE.
  - `DStakeToken.totalAssets()` proxies to `DStakeCollateralVault.totalValueInDStable()`.

- Rebalancing & Exchanges
  - Governance/ops can exchange between supported vault assets through adapters using dSTABLE as the intermediary.
  - Morpho Router provides deterministic allocation towards configured target weights and a manual collateral exchange helper.

### Risk & Safety Model

- Access Control
  - Token: `DEFAULT_ADMIN_ROLE`, `FEE_MANAGER_ROLE`.
  - Router: `DSTAKE_TOKEN_ROLE` (only token may call deposit/withdraw), `ADAPTER_MANAGER_ROLE`, `CONFIG_MANAGER_ROLE`, `COLLATERAL_EXCHANGER_ROLE`.
  - Collateral Vault: `DEFAULT_ADMIN_ROLE`, `ROUTER_ROLE` (granted to active router).
  - Morpho Router adds `PAUSER_ROLE` and `VAULT_MANAGER_ROLE`.

- Guards & Invariants
  - Unit of account is dSTABLE; all previews/valuations are in dSTABLE terms.
  - Adapters are single‑purpose per vault asset and must mint/return the expected token.
  - Slippage and value‑parity checks use adapter previews and a governable `dustTolerance`.
  - Unknown tokens dusted to the collateral vault are ignored in valuation, preserving liveness.
  - Morpho Router is pausable for deposit/withdraw paths.

### Extending dSTAKE

- Add a New Protocol
  - Implement `IDStableConversionAdapter` for the target vault asset.
  - Register the adapter in the router; the collateral vault will list the asset on first use.
  - For multi‑vault routing (Morpho), provide vault configs and target allocations.

- Change Routing
  - Use base router for a single default strategy or Morpho router for weighted, multi‑vault flow.
  - Routers are non‑upgradeable by design; governance can deploy a new router and rotate via `setRouter` on token/vault.

- Upgrade & Parameters
  - `DStakeToken` is upgradeable; routers and collateral vault are replaceable.
  - Governance can set withdrawal fees (capped), dust tolerance, default deposit asset, vault configs, and pause (Morpho).

### Developer Map

- Token: `contracts/vaults/dstake/DStakeToken.sol`
- Collateral Vault: `contracts/vaults/dstake/DStakeCollateralVault.sol`
- Base Router: `contracts/vaults/dstake/DStakeRouter.sol`
- Morpho Router: `contracts/vaults/dstake/DStakeRouterMorpho.sol`
- Adapters: `contracts/vaults/dstake/adapters/`
- Interfaces: `contracts/vaults/dstake/interfaces/`
- Rewards (optional): `contracts/vaults/dstake/rewards/`

### Mental Model (TL;DR)

- dSTAKE is an ERC4626 vault over dSTABLE that outsources allocation to a router.
- The router uses adapters to hop between dSTABLE and protocol‑specific vault assets.
- The collateral vault only holds assets and reports their value in dSTABLE.
- Yield happens upstream; dSTAKE reflects it in share price. Governance tunes routes, fees, and allocations.

