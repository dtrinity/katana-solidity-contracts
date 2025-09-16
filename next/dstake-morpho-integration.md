# dSTAKE: Replace dLEND with Morpho Blue

## Goal
Migrate dSTAKE from dLEND (Aave v3 fork) to Morpho Blue on Katana with minimal changes to dSTAKE architecture. Maintain the router + adapter pattern and collateral vault design. Provide mocks for local testing.

## Summary of Changes
- Keep `IDStableConversionAdapter` and the router/adapters pattern unchanged.
- Introduce a non-rebasing ERC-4626 wrapper over Morpho Blue supply positions to serve as the dSTAKE `vault asset`.
- Implement a new adapter `WrappedMorphoConversionAdapter` that converts dSTABLE <-> wrapper shares and mints/burns shares directly to/from `DStakeCollateralVault`.
- Provide `IMorpho` interfaces and `MockMorphoBlue` contract to enable local tests without forking.

## Why a Wrapper Is Still Needed
dSTAKE expects a concrete ERC20 `vault asset` (non-rebasing) that the `DStakeCollateralVault` can hold. Morpho Blue accounts supplier positions with internal shares, not with an ERC20 receipt token. Therefore, we introduce an ERC-4626 wrapper that:
- Accepts dSTABLE deposits and supplies them to Morpho Blue.
- Holds the Morpho position on behalf of the wrapper.
- Issues non-rebasing ERC20 shares to represent proportional ownership of the Morpho supply position.

This mirrors our existing `StaticATokenLM` approach while adapting to Morpho Blue semantics.

## New Contracts
1) Morpho interface and types
- `contracts/interfaces/morpho/Types.sol` with `MarketParams`, `Position`, `Market` structs.
- `contracts/interfaces/morpho/IMorpho.sol` exposing:
  - supply/withdraw (assets|shares semantics)
  - supplyCollateral/withdrawCollateral
  - borrow/repay
  - views: `market(bytes32)`, `position(bytes32,address)`

2) ERC-4626 wrapper for Morpho supply
- `contracts/vaults/dstake/adapters/Morpho4626Vault.sol` (new):
  - `asset()` = dSTABLE token used in the targeted market.
  - Holds immutable `IMorpho`, `MarketParams` for the target market.
  - `deposit/mint`: pulls dSTABLE, calls `morpho.supply(marketParams, assets, 0, address(this), "")`, mints wrapper shares to receiver.
  - `withdraw/redeem`: burns wrapper shares, calls `morpho.withdraw(marketParams, assets, 0, address(this), receiver)`.
  - Conversions: compute shares/assets using `Market` totals: if `totalSupplyShares == 0` then 1:1, else `assets = shares * totalSupplyAssets / totalSupplyShares` and inverse for shares.
  - Events and rounding mirrors ERC-4626 reference.

3) Adapter (dSTAKE bridge)
- `contracts/vaults/dstake/adapters/WrappedMorphoConversionAdapter.sol` (new):
  - Implements `IDStableConversionAdapter` against the wrapper vault.
  - `convertToVaultAsset(stableAmount)`: pulls dSTABLE from router, approves wrapper, deposits and mints shares directly to `DStakeCollateralVault`.
  - `convertFromVaultAsset(shares)`: pulls wrapper shares from router, redeems to receive dSTABLE, returns it to caller.
  - `preview*` and `assetValueInDStable()` proxy to wrapper `previewDeposit/previewRedeem` and conversions.

4) Reward manager
- Morpho Blue has no built-in rebasing/reward token like Aave LM. Keep `DStakeRewardManagerDLend` out; add a placeholder `DStakeRewardManagerMorpho` only if we later integrate external rewards. Not required for MVP.

## Contract Wiring
- Use the unified `DStakeRouterV2` which already handles deterministic multi-vault routing; configure MetaMorpho vaults via `setVaultConfigs`.
- `DStakeCollateralVault` remains unchanged (holds the wrapper shares as the vault asset).

## Deployment/Config Changes
- Add Morpho addresses to Katana config (if needed) and market params for the chosen market:
  - `loanToken` = dSTABLE (dETH/dUSD)
  - `collateralToken` = typically unused for pure supply, but set to a valid token for ID calculation
  - `oracle`, `irm`, `lltv` to match the deployed Morpho market
- New deploy flow:
  1. Deploy `Morpho4626Vault` with `IMorpho` address and `MarketParams`.
  2. Deploy `WrappedMorphoConversionAdapter` with dSTABLE, vault address, collateral vault address.
  3. Register adapter in the router with the wrapper share token as `vault asset`.
  4. Set `defaultDepositVaultAsset` to the wrapper share token.
- Update `deploy/08_dstake/02_deploy_dstake_adapters.ts` to support `WrappedMorphoConversionAdapter` similarly to `WrappedDLendConversionAdapter`.

## Testing Plan (using provided mocks)
We will add a configurable `MockMorphoBlue` that implements the `IMorpho` surface used by the wrapper.

### Mocks
- `contracts/testing/morpho/MarketParamsLib.sol`:
  - `MarketParams.id()` = `keccak256(abi.encode(MarketParams))` for market identification.
- `contracts/testing/morpho/MockMorphoBlue.sol`:
  - Maintain `Market` totals and per-user `Position`.
  - Implement `supply/withdraw`, `borrow/repay`, `supplyCollateral/withdrawCollateral` with simple shares math (1:1 baseline, adjustable for tests).
  - `market(id)` and `position(id,user)` views.
  - Helpers to create markets and seed liquidity for tests.

### How to Write Tests
- Fixture:
  - Deploy dSTABLE mock, `MockMorphoBlue`, `Morpho4626Vault` (pointing to the mock and a test market), and `WrappedMorphoConversionAdapter`.
  - Wire adapter into `DStakeRouter` and set as default.
- Core test flows:
  - Deposit dSTABLE into dSTAKE → expect wrapper shares in `DStakeCollateralVault`.
  - Withdraw from dSTAKE → shares redeemed via adapter → receive dSTABLE.
  - Exchange between adapters (if multiple vault assets configured) ensures value parity checks pass with dust tolerance.
  - Preview functions return consistent conversions with on-chain state.

## Risks & Considerations
- Market configuration: wrapper must be hardwired to the correct `MarketParams`; governance should be able to deploy a new wrapper/adapter pair if market changes.
- Shares math: Use Morpho `Market` totals for conversion; beware rounding on low-liquidity markets.
- Re-entrancy/approvals: Follow OZ `SafeERC20` and ERC-4626 best practices.
- No native rewards: yield comes from borrow interest; compounding is implicit via share price appreciation.

## Acceptance Criteria
- Contracts compile and unit tests pass against mocks.
- dSTAKE deposit/withdraw works end-to-end using the new adapter.
- Router value parity and slippage checks operate correctly with the wrapper.
- No changes required to `DStakeCollateralVault` and minimal/no changes to the router interface.

## Follow-Ups (post-MVP)
- Add optional reward harvesting if a Morpho incentives module is deployed.
- Expose wrapper view methods to introspect market health and capacity.
- Support multiple Morpho markets per dSTAKE instance via multiple wrapper+adapter pairs.
