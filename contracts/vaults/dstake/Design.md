## dSTAKE — High-Level Overview

dSTAKE is a yield-bearing stablecoin vault. Users deposit a dSTABLE asset (e.g., dUSD) and receive dSTAKE shares (`ERC4626`). Capital is routed into external lending protocols through pluggable adapters while accounting, fees, and governance live on the dSTAKE side. This document captures the current architecture and the operational handles maintainers rely on.

### Components At A Glance

- `DStakeTokenV2` – upgradeable ERC4626 share token (`contracts/vaults/dstake/DStakeTokenV2.sol`)
  - Mints/burns shares against dSTABLE deposits and redemptions.
  - Delegates conversions to the router and reads TVL from the collateral vault.
  - Implements configurable withdrawal fees with on-chain previews that surface net values.
  - Exposes solver entry points (batch deposit/withdraw) for off-chain computed multi-vault flows (e.g. from a user-facing frontend).
  - Custodies collected fees until `reinvestFees()` is called, paying an optional caller incentive before routing the balance back through the router.

- `DStakeCollateralVaultV2` – non-upgradeable asset store (`contracts/vaults/dstake/DStakeCollateralVaultV2.sol`)
  - Holds ERC20 "strategy shares" (e.g., ERC4626 wrapper shares from upstream strategies) and exposes `totalValueInDStable()`.
  - Maintains a registry of supported strategy shares; adapters can be rotated without migrating balances.
  - Allows governance to delist strategy shares even if dust remains (avoids griefing vector).
  - Refuses to value a strategy share without a live adapter; NAV queries revert so governance must restore pricing or pause deposits before removal.
  - Grants `ROUTER_ROLE` to the active router so only the router can move collateral.

- `DStakeRouterV2` – deterministic orchestrator (`contracts/vaults/dstake/DStakeRouterV2.sol`)
  - Owner of vault configuration, adapter registry, and operational limits.
  - Auto-routes user deposits to the most under-allocated active vault and withdrawals from the most over-allocated vault (one vault per user operation by default).
  - Provides solver routes that accept vault/amount arrays for multi-vault servicing, typically from dSTAKE deposits/withdrawals.
  - Supports collateral exchanges, pausing, dust tolerance settings, surplus sweeping, and vault health checks.

- Adapters (`contracts/vaults/dstake/adapters/`)
  - Implement `IDStableConversionAdapterV2`. Each adapter knows how to convert dSTABLE ↔ specific strategy shares and report valuations in dSTABLE terms.
  - Must mint/burn strategy shares directly against the collateral vault. Examples: MetaMorpho, wrapped lending tokens.

- Rewards (optional) (`contracts/vaults/dstake/rewards/`)
  - Strategy-specific helpers that periodically claim and compound incentive tokens back into dSTABLE or strategy shares.

### Flow of Funds

- **User deposit / mint**
  1. dSTABLE moves into `DStakeTokenV2` via `deposit()`/`mint()`.
  2. The token approves the router and calls `router.deposit(amount)`.
  3. Router pulls dSTABLE, selects the healthiest under-allocated strategy, and attempts the entire conversion against that single vault. If the adapter reverts, the router bubbles up the failure so operators can investigate, mark the vault unhealthy, or use solver tools to reroute capital.
  4. Shares are minted to the user according to totalAssets() (which includes any pending fee balance held by the token).

- **User withdraw / redeem**
  1. User requests a net dSTABLE amount; withdrawal previews already deduct the governance-configured fee.
  2. Token translates the request back to a gross vault withdrawal, burns the user’s shares, and calls `router.withdraw(netAmount, receiver, owner)`.
  3. Router withdraws the *entire* request from the most over-allocated strategy using strict slippage checks (no tolerance). Failures bubble up immediately—there is no retry or fallback loop—so operators can flip vault health or rely on solver endpoints to orchestrate partial withdrawals across multiple vaults.
  4. Withdrawal fees remain temporarily inside `DStakeTokenV2` until reinvested.

- **Solver flows**
  - `solverDepositAssets` / `solverDepositShares` and their withdraw counterparts allow off-chain automation (UIs, keepers) to specify exact strategy allocations and split flows across multiple vaults. These entry points still enforce ERC4626 previews, pull/burn shares on behalf of the owner, and rely on adapters for conversions.
  - Solver withdrawals return the gross dSTABLE to the token; the token handles fee deduction and event emission before forwarding net amounts. Any integration that needs partial fills must use these solver paths.

- **Fee reinvestment**
  - `reinvestFees()` re-deploys accumulated withdrawal fees via the router after optionally paying the caller an incentive (capped at 20% per `MAX_REINVEST_INCENTIVE_BPS`). This keeps totalAssets() aligned with collateral growth and ensures fees compound with the rest of the portfolio.

- **Collateral exchanges & rebalances**
  - Governance or operations can trigger `rebalanceStrategiesByValue` / `swapStrategySharesWithOperator` to move exposure between strategies. These functions work entirely in dSTABLE terms, consult adapter previews, enforce slippage via `dustTolerance`, and stage transfers through the collateral vault.
  - `sweepSurplus()` converts any dSTABLE left on the router (for example from rounding during withdrawals) back into the default deposit strategy shares.

### Router V2 Details

- **Deterministic allocation** – Uses `DeterministicVaultSelector` and `AllocationCalculator` libraries to compute current vs target allocations. Auto deposits target the most underweight strategy; auto withdrawals start with the most overweight strategy. Given identical inputs, the selector always produces the same vault, keeping routing behaviour repeatable across environments and tests.
- **Single-vault ERC4626 path** – Standard deposit and withdraw calls commit the entire amount to the first eligible vault and bubble up adapter failures immediately. There is no router-level retry; operators respond by marking vault health or using solver flows when an adapter misbehaves. Operations that need multi-vault aggregation must call the solver entry points instead.
- **Health checks & liveness** – Strategies must pass protocol health probes (`previewDeposit`, `previewRedeem`) to be considered active for an operation. Paused or unhealthy strategies are skipped automatically.
- **Adapter registry** – `_strategyShareToAdapter` pairs strategy shares with adapters. Adding an active strategy automatically registers the adapter and whitelists the strategy shares on the collateral vault. Removing a strategy also evacuates the adapter mapping.
- **Governance knobs** – `setVaultConfigs`, `add/update/removeVault`, `setDefaultDepositStrategyShare`, `setDustTolerance`, `setMaxVaultCount`, surplus sweeping, and pause controls live on the router under dedicated roles.
- **Collateral exchanges** – Exchanges validate adapter previews in both directions and enforce `dustTolerance` when comparing expected vs realised dSTABLE value, preventing silent degradation across strategies.
- **Surplus handling** – Any router-held dSTABLE (typical after solver withdrawals before forwarding) can be swept back into the default strategy via `sweepSurplus()`, which emits `SurplusSwept` with the amount redeployed.

### DStakeTokenV2 Mechanics

- **totalAssets()** – Returns collateral-vault TVL plus any dSTABLE balance sitting on the token (primarily accumulated withdrawal fees). After a full withdrawal the strategy may still report value due to `dustTolerance` residual shares accruing yield; first depositor back in receives that windfall.
- **Withdrawal fee plumbing** – Supports previews and limits through [`SupportsWithdrawalFee`](../../common/SupportsWithdrawalFee.sol). User-facing methods always accept/return net amounts while internal router calls use the gross amount once to avoid charging the fee twice. All withdrawal paths converge through `_settleWithdrawal()` for consistent fee application and validation.
- **Solver functions** – Maintain allowances, ensure non-zero share burns for non-zero withdrawals, and delegate execution to router solver entry points. Solver withdrawals apply precise fee rounding with aggregated gross calculations to prevent shortfalls. All flows emit standard ERC4626 events with net amounts for user accounting.
- **Fee reinvestment & incentives** – `reinvestFees()` streams a caller incentive (set via `setReinvestIncentive`) before redeploying capital. Incentive and reinvestment events make it easy to audit the cadence of fee compounding.
- **Upgrade & governance** – Token remains upgradeable via the proxy; router and collateral vault are meant to be replaced instead of upgraded.

### Collateral Vault Notes

- Enumerates supported strategy shares via an `EnumerableSet` and exposes helpers for enumerating them (`supportedStrategyShares`, `getSupportedStrategyShares`).
- Only the router (via `ROUTER_ROLE`) may move collateral or mutate the supported set; governance rotates routers with `setRouter`.
- Collateral movements happen through `transferStrategyShares(strategyShare, amount, recipient)`—the legacy `sendAsset` helper has been removed along with router retry scaffolding.
- Allows strategy share removal even if a balance remains, so governance can delist griefed strategy shares and recover funds manually if needed.
- Rescue functions exist for miscellaneous tokens/ETH sent by mistake, but disallow extracting dSTABLE or any supported strategy shares.

### Access Control Surface

- **Token roles** (`DStakeTokenV2.sol`)
  - `DEFAULT_ADMIN_ROLE` – set router/collateral vault, upgrade implementations.
  - `FEE_MANAGER_ROLE` – adjust withdrawal fee and reinvest incentive.

- **Router roles** (`DStakeRouterV2.sol`)
  - `DEFAULT_ADMIN_ROLE` – owns surpluses and global admin actions.
  - `DSTAKE_TOKEN_ROLE` – limited to the live `DStakeTokenV2` contract.
  - `STRATEGY_REBALANCER_ROLE` – execute share exchanges and strategy rebalances.
  - `ADAPTER_MANAGER_ROLE` – add/remove adapters.
  - `CONFIG_MANAGER_ROLE` – set defaults, risk limits, dust tolerance.
  - `VAULT_MANAGER_ROLE` – manage vault configs and lifecycle.
  - `PAUSER_ROLE` – pause/unpause router operations.

- **Collateral vault roles** (`DStakeCollateralVaultV2.sol`)
  - `DEFAULT_ADMIN_ROLE` – rotate router, rescue tokens, configure governance.
  - `ROUTER_ROLE` – granted exclusively to the active router for asset movements.

### Safety Model & Invariants

- dSTABLE is the unit of account across previews, valuations, and routing decisions.
- Auto-routing enforces adapter reports: deposits revert if minted shares deviate, withdrawals revert if converted dSTABLE falls short of the request.
- `dustTolerance` (default 1 wei) permits small rounding mismatches during router-driven share exchanges and rebalances without blocking execution while still protecting against meaningful slippage. Standard auto-withdrawals still require the full requested amount.
- Router is `Pausable` and `ReentrancyGuard` protected. Deposit/withdraw paths halt when paused; solver routes are also gated by the same modifier chain.
- Collateral vault ignores unknown dust in TVL calculations so third parties cannot block accounting by donating unsupported tokens.
- Solver paths are restricted to the token role, preventing arbitrary accounts from bypassing standard fee handling.

### Operational Playbooks

1. **Onboard a new strategy**
   - Implement `IDStableConversionAdapterV2` for the protocol and deploy it.
   - Call `addAdapter(strategyShare, adapter)` and grant `STRATEGY_REBALANCER_ROLE` if cross-strategy swaps are required.
   - Add a vault config (target BPS, activation flag). Ensure aggregate targets sum to 100%.
   - Optionally call `setDefaultDepositStrategyShare` to make the new strategy the default for surplus sweeps.

2. **Rotate routers**
   - Deploy the new router with references to the token and collateral vault.
   - Governance grants the router roles (`setRouter` on the collateral vault; `setRouter` on the token) and assigns appropriate admin/config roles.
   - The router now handles adapter cleanup internally, so it does not require `ADAPTER_MANAGER_ROLE` to remove its own adapters.
   - Optionally migrate vault configs by reusing `setVaultConfigs` on the new router.

3. **Manage fees**
   - Adjust withdrawal fee via `setWithdrawalFee()` within the 1% cap.
   - Tune caller incentive with `setReinvestIncentive()` (max 20%).
   - Schedule or automate `reinvestFees()` so fees re-enter strategies regularly.

4. **Rebalance exposure**
   - Use solver deposit/withdraw functions for one-off targeted moves without changing target allocations.
   - For structural changes, update vault configs or run `rebalanceStrategiesByValue` / `swapStrategySharesWithOperator` with conservative `min` values.

5. **Offboard a strategy**
   - Mark the vault impaired or suspended so auto-routing stops using it, then migrate positions via solver withdrawals or operator swaps.
   - Only call `removeAdapter` once the collateral vault no longer holds the strategy shares; otherwise NAV queries revert with `AdapterValuationUnavailable` and block user flows until a replacement adapter is installed.

### Developer Map

- Token: `contracts/vaults/dstake/DStakeTokenV2.sol`
- Router: `contracts/vaults/dstake/DStakeRouterV2.sol`
- Collateral Vault: `contracts/vaults/dstake/DStakeCollateralVaultV2.sol`
- Adapters: `contracts/vaults/dstake/adapters/`
- Interfaces: `contracts/vaults/dstake/interfaces/`
- Rewards (optional): `contracts/vaults/dstake/rewards/`
- Libraries & math helpers: `contracts/vaults/dstake/libraries/`

### Mental Model (TL;DR)

- dSTAKE is an ERC4626 wrapper over dSTABLE that outsources allocation decisions to a deterministic router.
- The router maintains the active vault set, matches capital to target weights, and uses adapters for protocol-specific conversions.
- The collateral vault only stores strategy shares and reports their dSTABLE value; all movement is orchestrated by the router.
- Fees accrue on the token, get reinvested via the router, and the share price reflects upstream yield plus compounded fees.
- Governance tunes routes, fees, incentives, and safety limits while solver flows keep operations flexible.
