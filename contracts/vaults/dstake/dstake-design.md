## dSTAKE – Design Overview

This document describes the dSTAKE subsystem: its purpose, components, data flows, and key invariants. It is intended for external readers and future contributors.

### Goals

- **Tokenized diversified staking**: Expose a single ERC4626 vault token (`DStakeToken`) backed by a basket of yield-bearing "vault assets" managed in a separate collateral vault.
- **Protocol-agnostic integrations**: Support multiple underlying strategies via pluggable `IDStableConversionAdapter` contracts (e.g., wrapped dLEND aTokens).
- **Simple UX**: Users deposit a single stable asset (dStable) and receive `DStakeToken` shares; on withdrawal they receive dStable net of fees.
- **Controlled rebalancing**: Governance and authorized actors can exchange/migrate underlying vault assets with value-parity checks and slippage controls.
- **Composable accounting**: `DStakeToken.totalAssets()` aggregates the vault’s inventory value through adapter-provided pricing functions.

### Non-goals

- On-chain price discovery beyond strategy wrappers (adapters query wrappers, not external oracles).
- Multi-chain coordination (this document covers a single-chain deployment).

### High-level architecture

```mermaid
graph LR
  U["User / Integrator"] -->|deposit / withdraw dStable| DST[DStakeToken (ERC4626, upgradeable)]
  DST -->|delegate conversions| RTR[DStakeRouterDLend (roles, non-upgradeable)]
  RTR <-->|send/receive vault assets| CV[DStakeCollateralVault (asset store)]
  RTR -->|dStable -> vaultAsset| ADA1[IDStableConversionAdapter]
  ADA1 -->|mint/transfer| CV
  RTR -->|vaultAsset -> dStable| ADA1
  subgraph Example strategy
    ADA1 --> SATLM[StaticATokenLM wrapper]
    SATLM -->|wrapper shares| CV
  end
  subgraph Rewards (optional)
    RWM[DStakeRewardManagerDLend]
    RWM -->|compound dStable| RTR
    RWM --> RC[RewardsController]
  end
```

### Components

- **`DStakeToken`**: ERC4626 upgradeable share token representing a pro-rata claim on the `DStakeCollateralVault` value (in dStable). Applies a configurable withdrawal fee. Delegates all conversions to the router.
- **`DStakeRouterDLend`**: Orchestrates deposits/withdrawals and exchanges between supported vault assets using protocol-specific adapters. Maintains the mapping `vaultAsset → adapter` and a `defaultDepositVaultAsset`.
- **`DStakeCollateralVault`**: Custodies supported vault assets. Authorizes the router via `ROUTER_ROLE`. Computes `totalValueInDStable()` using adapter pricing.
- **`IDStableConversionAdapter`**: Strategy integration interface. Converts between dStable and a specific vault asset and provides preview/valuation functions.
- **`WrappedDLendConversionAdapter`**: Adapter for StaticATokenLM (wrapped dLEND aTokens). Uses ERC4626 `deposit/redeem` and `previewDeposit/previewRedeem`.
- **`DStakeRewardManagerDLend`** (optional): Compounds dStable provided by a caller into the vault’s default asset, then claims external reward tokens and distributes them (treasury fee + receiver).
- **`DStakeProxyAdmin`**: Dedicated ProxyAdmin for upgradeable dSTAKE contracts.

### Roles & permissions

- **DStakeToken**: `DEFAULT_ADMIN_ROLE` (governance), `FEE_MANAGER_ROLE` (set withdrawal fee).
- **DStakeRouterDLend**: `DEFAULT_ADMIN_ROLE` (governance ops), `DSTAKE_TOKEN_ROLE` (restricted caller for deposit/withdraw; granted to `DStakeToken`), `COLLATERAL_EXCHANGER_ROLE` (rebalancing/exchanges).
- **DStakeCollateralVault**: `DEFAULT_ADMIN_ROLE` (set router, rescue), `ROUTER_ROLE` (router-only functions: send assets, manage supported assets).
- **Reward Manager**: Inherits roles from `RewardClaimable` including `DEFAULT_ADMIN_ROLE` and `REWARDS_MANAGER_ROLE`.

### Accounting model

- **Unit of account**: dStable (e.g., dUSD).
- **`DStakeToken.totalAssets()`**: returns `DStakeCollateralVault.totalValueInDStable()`.
- **Vault valuation**: `DStakeCollateralVault` iterates supported assets and queries each asset’s adapter via `assetValueInDStable(asset, balance)`. Assets without a configured adapter are skipped to preserve liveness if dusted.

### Deposit flow (dStable → `DStakeToken` shares)

```mermaid
sequenceDiagram
  participant User
  participant Token as DStakeToken
  participant Router as DStakeRouterDLend
  participant Adapter as IDStableConversionAdapter
  participant Wrap as StaticATokenLM
  participant Vault as DStakeCollateralVault

  User->>Token: deposit(assets, receiver) / mint(shares, receiver)
  Token->>Token: compute shares; ZeroShares guard
  Token->>User: transferFrom dStable (super._deposit)
  Token->>Router: approve dStable; deposit(assets)
  Router->>Router: resolve defaultDepositVaultAsset and adapter
  Router->>Token: transferFrom dStable
  Router->>Adapter: approve dStable; convertToVaultAsset(assets)
  Adapter->>Wrap: deposit(assets, Vault)
  Wrap-->>Vault: mint wrapper shares (vault asset)
  Router-->>Token: RouterDeposit event
  Token-->>User: shares already minted by ERC4626
```

Key checks:

- **Adapter preview and slippage**: `previewConvertToVaultAsset` guides expectations and is enforced via `SlippageCheckFailed`.
- **Asset integrity**: `AdapterAssetMismatch` ensures adapters mint the expected vault asset.
- **Reported vs observed**: Router cross-checks minted amount against adapter-reported amount.

### Withdraw flow (dStable net of fee)

```mermaid
sequenceDiagram
  participant User
  participant Token as DStakeToken
  participant Router as DStakeRouterDLend
  participant Vault as DStakeCollateralVault
  participant Adapter as IDStableConversionAdapter
  participant Wrap as StaticATokenLM

  User->>Token: withdraw(netAssets, receiver, owner) / redeem(shares)
  Token->>Token: previewWithdraw -> shares; compute grossAssets and fee
  Token->>Token: burn(owner, shares)
  Token->>Router: withdraw(amountToSend=netAssets, receiver, owner)
  Router->>Adapter: vaultAsset()
  Router->>Wrap: previewWithdraw(netAssets) [via IERC4626]
  Router->>Vault: sendAsset(vaultAsset, requiredShares, Router)
  Router->>Adapter: approve; convertFromVaultAsset(requiredShares)
  Adapter-->>Router: dStableReceived
  Router->>User: transfer(netAssets)
  alt surplus dStable from adapter
    Router->>Adapter: approve surplus; convertToVaultAsset(surplus)
    Adapter-->>Vault: mint wrapper shares
  else fail recycle
    Router-->>Router: SurplusHeld event (sweepable)
  end
  Router-->>Token: Withdrawn event
```

Notes:

- **Withdrawal fee**: Applied once on the gross amount; `withdraw()` takes net assets, `redeem()` returns net assets.
- **Rounding surplus**: Any adapter over-delivery is recycled to the vault; if recycling fails, it is held by the router and can be swept by governance (`sweepSurplus`).

### Rebalancing/exchange flows

- **Adapter-based exchange**: `exchangeAssetsUsingAdapters(fromAsset, toAsset, fromAmount, minToAmount)`
  - Converts `fromAsset → dStable` via its adapter, then `dStable → toAsset` via the target adapter; mints directly to the vault.
  - Enforces: output slippage bound and value-parity within `dustTolerance` using adapter `preview` functions.

- **Solver-based exchange**: `exchangeAssets(fromAsset, toAsset, fromAmount, minToAmount)`
  - Pulls `fromAsset` from the solver, credits it to the vault, and sends `toAsset` from the vault to the solver based on adapter previews.

### Rewards compounding (optional)

```mermaid
sequenceDiagram
  participant Caller as External Caller
  participant RWM as RewardManager
  participant Router as DStakeRouterDLend
  participant Adapter as IDStableConversionAdapter
  participant Vault as DStakeCollateralVault
  participant RC as RewardsController

  Caller->>RWM: compoundRewards(amountDStable, rewardTokens, receiver)
  RWM->>RWM: guard amount >= exchangeThreshold
  Caller-->>RWM: transfer dStable
  RWM->>Adapter: approve; convertToVaultAsset(amount)
  Adapter-->>Vault: mint default vault asset
  RWM->>RC: claim rewards on behalf of wrapper
  RC-->>RWM: reward tokens
  RWM->>RWM: take treasury fee
  RWM-->>receiver: reward tokens (net)
```

Properties:

- The manager never pulls tokens from the vault; it only converts dStable provided by the caller into the vault’s default asset and then claims external rewards owed to the wrapper.
- Treasury fee is configurable and capped by the underlying `RewardClaimable` policy.

### Fees

- **Withdrawal fee**: Configurable by `FEE_MANAGER_ROLE` on `DStakeToken`, capped at 1% (`MAX_WITHDRAWAL_FEE_BPS`). Applied a single time per withdrawal.
- **No deposit fee**: Deposits mint shares directly; conversions happen post-mint via the router.

### Risk controls & invariants

- **Adapter correctness**: Adapters must mint/return the expected asset and honor preview-based amounts; mismatches revert.
- **Value parity**: Exchanges enforce that the dStable-equivalent of output is within `dustTolerance` of input.
- **Liveness under dusting**: Unknown tokens sent to the vault are ignored in valuation if no adapter is configured.
- **Residual dust**: The router may intentionally leave ≤ `dustTolerance` of wrapper tokens in the vault; with ERC4626 wrappers that accrue via PPS, it is possible for `totalSupply() == 0` while `totalAssets() > 0`. The next depositor may receive a negligible windfall.
- **Approvals**: Uses `forceApprove` to set exact allowances before external calls.
- **Access control**: Router-only functions in the vault are guarded by `ROUTER_ROLE`. Rebalancing requires `COLLATERAL_EXCHANGER_ROLE`.

### Governance & operations

- **Initial wiring**:
  - Deploy `DStakeToken` (proxy) and `DStakeCollateralVault` (implementation), then set mutual references:
    - `DStakeToken.setCollateralVault(vault)` and `DStakeToken.setRouter(router)`
    - `DStakeCollateralVault.setRouter(router)` (grants `ROUTER_ROLE` to the router)
  - Deploy adapters and register via `DStakeRouterDLend.addAdapter(vaultAsset, adapter)`; the router will `addSupportedAsset` in the vault.
  - Set `defaultDepositVaultAsset` on the router.
  - Configure withdrawal fee via `FEE_MANAGER_ROLE`.
  - Optionally deploy and configure `DStakeRewardManagerDLend`.

- **Adding an asset**: Deploy adapter, `addAdapter()`, confirm vault lists asset, optionally set as default deposit asset.
- **Removing an asset**: `removeAdapter()` will delist from the vault. Governance should migrate balances first (via `exchangeAssetsUsingAdapters`) or rescue delisted tokens if appropriate.
- **Router surplus management**: Use `sweepSurplus(maxAmount)` to convert any held dStable back into the default vault asset.
- **Parameter tuning**: `setDustTolerance()` on the router sets the allowed value drift for exchanges.

### Upgradeability & replaceability

- **`DStakeToken`**: Upgradeable via Transparent Proxy controlled by `DStakeProxyAdmin`.
- **Router & CollateralVault**: Non-upgradeable by design; can be replaced by deploying new instances and re-pointing (update router in token/vault, migrate assets via exchanges). The vault’s `setRouter()` cleanly rotates `ROUTER_ROLE`.
- **Adapters**: Stateless; can be added/removed per asset. Existing adapter mapping cannot be replaced by a different address unless removed first (prevents footguns).

### Events (selected)

- **Router**: `RouterDeposit`, `Withdrawn`, `Exchanged`, `AdapterSet/Removed`, `DefaultDepositVaultAssetSet`, `DustToleranceSet`, `SurplusHeld`, `SurplusSwept`.
- **Token**: Standard ERC4626 events; `Withdraw` (emits net assets), `WithdrawalFee`.
- **Vault**: `SupportedAssetAdded/Removed`, `RouterSet`.
- **Reward Manager**: `RewardCompounded` (via base), internal events for controller updates and processed exchange.

### Appendix: Key interfaces

- **`IDStableConversionAdapter`**
  - `convertToVaultAsset(uint256) → (address vaultAsset, uint256 vaultAssetAmount)`
  - `convertFromVaultAsset(uint256) → (uint256 stableAmount)`
  - `previewConvertToVaultAsset(uint256)`, `previewConvertFromVaultAsset(uint256)`
  - `assetValueInDStable(address vaultAsset, uint256 amount)`
  - `vaultAsset()`

- **`IDStakeRouter`**
  - `deposit(uint256 dStableAmount)`; callable by `DSTAKE_TOKEN_ROLE` (the token)
  - `withdraw(uint256 dStableAmount, address receiver, address owner)`

- **`IDStakeCollateralVault`**
  - `totalValueInDStable()`; `sendAsset(asset, amount, recipient)`; `setRouter(address)`
  - `getSupportedAssets()` and related events

### Testing notes (quick)

- Validate deposit/withdraw round-trips with non-zero withdrawal fee.
- Exercise surplus recycling and `sweepSurplus` behavior.
- Verify exchange slippage floor and value parity with various `dustTolerance` values.
- Ensure delisting and rescue paths operate safely when residual balances exist.
