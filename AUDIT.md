> **Use this tracker to keep reviews efficient:** Log fresh findings under **Open**, migrate them to **Resolved** once the fix lands (include pointers to patches/tests), and park accepted risks in **Acknowledged (Won't Fix)** with rationale so auditors know not to re-raise them.

### Logging checklist for auditors
- Skim all existing entries before adding a new one to avoid duplicates.
- Capture severity, affected component (file + scope), and a succinct impact description.
- Reference code with `file.sol:line` anchors so maintainers can jump straight to the context.
- Leave remediation ideas out for now—we're focused on discovery during this pass.

# dSTAKE v2 Audit Tracker

Updates capture the most recent review cycle. Items are grouped by current status so we can focus the next pass efficiently.

## Resolved

### 1. Router retry gas exhaustion
- **Component**: `contracts/vaults/dstake/DStakeRouterV2.sol`
- **Fix**: Added `_computeRetryCallGas` to meter the gas forwarded to each self-call retry, reserving a per-attempt stipend and completion buffer. Deposits and withdrawals now call the wrappers with `gas: callGas`, and revert early with `InsufficientRetryGas` if the caller supplies too little headroom (`DStakeRouterV2.sol:209`, `:259`, `:828`). Governance can tune the stipend via `setRetryGasConfig` without redeploying.
- **Tests**: `test/dstake/DStakeRouterV2.test.ts` now includes `"preserves gas for fallback vaults when a candidate adapter burns gas"` which deploys a gas-guzzling adapter and proves the router falls through to healthy vaults instead of exhausting gas.
- **Residual risk**: The stipend is heuristic; pathological adapters could still burn through reserved gas across multiple retries. Future hardening could track abusive adapters and auto-quarantine after repeated failures.

### 2. Dust-tolerance underflow in share rebalances
- **Component**: `contracts/vaults/dstake/DStakeRouterV2.sol`
- **Fix**: Saturated the dust adjustment in `_rebalanceStrategiesByShares` (`dustAdjusted`) and short-circuit the flow entirely when the previewed withdrawal value is within `dustTolerance` (`DStakeRouterV2.sol:452`, `:456`). Dust-sized moves are now ignored instead of reverting or donating collateral.
- **Tests**: `test/dstake/DStakeRouterV2.test.ts` adds `"clamps dust tolerance during share rebalances"` to confirm the router skips micro-moves without reverting or mutating balances.
- **Residual risk**: Operators should monitor dust tolerance so that repeated no-op calls do not mask larger mismatches. Consider emitting an explicit event when a rebalance is skipped due to dust.

### 3. Adapter removal zeroes collateral valuation
- **Component**: `contracts/vaults/dstake/DStakeRouterV2.sol`, `contracts/vaults/dstake/DStakeCollateralVaultV2.sol`
- **Fixes**:
  - `_removeAdapter` now leaves the strategy share registered while collateral remains, preventing valuation gaps during quarantines (`DStakeRouterV2.sol:1199`).
  - The collateral vault falls back to ERC4626 previews (`previewRedeem` / `convertToAssets`) when an adapter is absent, so `totalValueInDStable` still reflects orphaned positions (`DStakeCollateralVaultV2.sol:71-99`).
- **Tests**: `test/dstake/DStakeRouterV2.test.ts` adds `"keeps totalAssets stable when removing an adapter with live balances"`, verifying share price continuity through adapter removal.
- **Residual risk**: Fallback valuation relies on the strategy share implementing ERC4626 previews. Non-ERC4626 strategies will still read as zero; future work could persist last-known prices or require bespoke valuers.

### 4. Documentation alignment
- **Component**: `contracts/vaults/dstake/Design.md`
- **Update**: Router retry and fallback sections now describe the gas stipend approach and warn that retries are best-effort, resolving the prior drift.

### 5. Solver dust donation (reference)
- **Status**: Previously fixed; regression coverage retained in `test/dstake/DStakeSolverMode.test.ts`.

### 6. Rebalance adapter allowances
- **Component**: `contracts/vaults/dstake/DStakeRouterV2.sol`
- **Fix**: Both `_rebalanceStrategiesByShares` and the external-liquidity variant now clear approvals back to zero after adapter calls to prevent lingering allowances that a compromised adapter could replay (`DStakeRouterV2.sol:456-468`, `:518-537`).
- **Tests**: `test/dstake/DStakeRouterV2.test.ts` adds "clears allowances after internal share rebalances" and "clears allowances after external-liquidity rebalances" to assert share and dStable allowances return to zero once the operation completes.
- **Residual risk**: Set `dustTolerance` conservatively; raising it materially increases the value an adapter can walk off with before slippage guards catch the drift.

### 7. Exchange-asset rewards bypassed compounding float guard
- **Component**: `contracts/vaults/rewards_claimable/RewardClaimable.sol`
- **Fix**: `compoundRewards` now subtracts the caller's freshly supplied exchange asset before splitting rewards, so the subsequent `_processExchangeAssetDeposit` still has liquidity even when URD lists the exchange asset itself (`RewardClaimable.sol:163-216`).
- **Tests**: `test/dstake/DStakeRewardManagerMetaMorpho.test.ts` adds "should handle dStable rewards without consuming the compounding float" to exercise the regression scenario.

### 8. Settlement shortfall guard
- **Component**: `contracts/vaults/dstake/DStakeTokenV2.sol`
- **Fix**: Governance now sets a fixed `settlementShortfall` (denominated in dStable). `totalAssets()` reports net collateral (gross minus the shortfall), `setSettlementShortfall` rejects values above the gross backing, and all mint/share previews price against `grossTotalAssets()` so new deposits cannot capture reserved value (`DStakeTokenV2.sol:112-177`, `:743-752`).
- **Tests**: `test/dstake/SettlementShortfall.test.ts` exercises the guard, ERC4626 invariant preservation, preview alignment, and shows a shortfall-front-run deposit no longer profits.

### 9. Single-vault withdrawal DoS
- **Component**: `contracts/vaults/dstake/DStakeRouterV2.sol`, `contracts/vaults/dstake/DStakeTokenV2.sol`
- **Fix**: Rather than over-reporting liquidity that the deterministic router cannot satisfy, `DStakeRouterV2` now exposes `getMaxSingleVaultWithdraw`, and `DStakeTokenV2.maxWithdraw` clamps ERC4626 limits to that per-vault ceiling after fees (`DStakeRouterV2.sol:844-852`, `DStakeTokenV2.sol:274-288`, `IDStakeRouterV2.sol:76-78`). Integrators no longer observe withdraw amounts that would revert.
- **Tests**: `test/dstake/DStakeRouterV2.test.ts:246-289` adds "clamps maxWithdraw to the largest single-vault capacity", verifying the reported limit matches the largest vault and that requests above it revert with `ERC4626ExceedsMaxWithdraw`.
- **Residual risk**: The router still services a single vault per deterministic withdrawal; user exits above the cap must route through solver mode or wait for rebalancing. Tracking aggregate withdrawals across vaults remains future work.

### 10. Router zero-capacity maxWithdraw floor
- **Component**: `contracts/vaults/dstake/DStakeTokenV2.sol:277-294`
- **Fix**: `maxWithdraw` now returns zero whenever the router reports no eligible liquidity or the call reverts, only falling back to the owner's balance while the router is unset. Outage scenarios therefore advertise the same "no capacity" limit the router enforces.
- **Tests**: `test/dstake/DStakeRouterV2.test.ts:351-378` suspends every vault, confirms the reported limit drops to zero, blocks larger withdrawals, and still allows `withdraw(0)` probes.

### 11. Zero-amount withdrawals honor ERC4626 semantics
- **Component**: `contracts/vaults/dstake/DStakeTokenV2.sol:333-344`
- **Fix**: `_withdraw` now short-circuits zero-asset/share flows, burning nothing, emitting the ERC4626 `Withdraw` event with zero values, and skipping the router call so the downstream `InvalidAmount` check is never triggered.
- **Tests**: `test/dstake/DStakeRouterV2.test.ts:374-378` exercises `withdraw(0)` while the router has no capacity, demonstrating it succeeds as a no-op instead of reverting.

### 12. Collateral vault retargeting desync mints inflated shares
- **Component**: `contracts/vaults/dstake/DStakeTokenV2.sol:36`, `contracts/vaults/dstake/DStakeTokenV2.sol:760`, `contracts/vaults/dstake/interfaces/IDStakeRouterV2.sol:9`
- **Fix**: Removed the piecemeal `setRouter`/`setCollateralVault` governance knobs in favour of a single `migrateCore` function that atomically rewires the router and collateral vault once the router proves it already targets the same vault and token. Custom errors (`RouterCollateralMismatch`, `RouterTokenMismatch`) enforce the invariant and the router interface now exposes the necessary getters for the check.
- **Tests**: `test/dstake/DStakeToken.ts:203` covers the happy path plus both mismatch revert scenarios, while `test/dstake/FeeAccountingRegression.test.ts:92` and `test/dstake/routerFixture.ts:266` update integration flows to exercise `migrateCore` during fixture setup.
- **Residual risk**: Governance still needs to coordinate pausing around migrations; future work could make `migrateCore` assert the router is paused or that the new collateral vault already reflects assets when `totalSupply() > 0`.

### 13. Permissionless compounding strips claimed rewards
- **Component**: `contracts/vaults/rewards_claimable/RewardClaimable.sol`
- **Fix**: Temporarily restricted `compoundRewards` to callers holding `REWARDS_MANAGER_ROLE`, removing the permissionless entrypoint that let anyone drain staged rewards while a pricing-safe settlement redesign is underway (`RewardClaimable.sol:162-168`).
- **Tests**: Updated `test/dstake/DStakeRewardManagerMetaMorpho.test.ts` and `test/reward_claimable/RewardClaimable.ts` to grant the role in fixtures before exercising compounding so behaviour and accounting remain covered.
- **Residual risk**: Compounding now relies on a trusted operator. Revisit once a robust permissionless auction or router-executed swap flow is ready.

### 14. Redeem return value ignores over-withdrawals
- **Component**: `contracts/vaults/dstake/DStakeTokenV2.sol`
- **Fix**: Refactored `_withdraw` through `_withdrawAndReturnNet`, allowing `redeem` to surface the router-settled net assets even when rounding delivers more than requested (`DStakeTokenV2.sol:249`, `:269-309`). The helper centralizes allowance spending, share burns, router invocation, and settlement so every exit path now reports the true post-fee amount.
- **Tests**: `yarn hardhat test test/dstake/DStakeSolverMode.test.ts` (covers solver withdrawals and fee consistency) and existing ERC4626 regression suite.
- **Residual risk**: None noted; ERC4626 callers now observe accurate balances under all router rounding outcomes.

### 15. Redeem capacity clamp surfaced to callers
- **Component**: `contracts/vaults/dstake/DStakeTokenV2.sol`, `test/dstake/DStakeRouterV2.test.ts`
- **Fix**: Overrode `maxRedeem` to mirror the router-aware `maxWithdraw` ceiling and return the share burn that matches the single-vault capacity, preventing callers from overshooting the deterministic router limit (`DStakeTokenV2.sol:302-319`). Added a regression test that verifies the clamp both matches `previewWithdraw(maxWithdraw)` and rejects larger share burns with `ERC4626ExceedsMaxRedeem` (`test/dstake/DStakeRouterV2.test.ts:292`).
- **Residual risk**: Router heuristics may still surface `NoLiquidityAvailable` if no single vault can satisfy the clamped request; the ERC4626 view functions now advertise that limit so integrators can split redemptions when needed.

## Open

### 1. Dust tolerance disables solver-style rebalance slippage guard
- **Severity**: Medium
- **Component**: `contracts/vaults/dstake/DStakeRouterV2.sol:529`
- **Impact**: `rebalanceStrategiesBySharesViaExternalLiquidity` subtracts `dustTolerance` (configured in dStable units) directly from `minToShareAmount` (strategy share units). For strategies whose share decimals are lower than the dStable’s, or whenever operators raise `dustTolerance` above the share amount for a planned move, `minRequiredWithDust` collapses to zero and the function no longer enforces the caller’s minimum. An adapter that returns zero shares—whether due to fees, a mispriced exchange, or malicious behavior—will pass the guard and burn the entire rebalance amount even though the caller required a non-zero minimum.

## Acknowledged (Won't Fix)

### 1. Residual allowance after WrappedDLend deposits
- **Component**: `contracts/vaults/dstake/adapters/WrappedDLendConversionAdapter.sol:59-96`
- **Issue**: `depositIntoStrategy` mints wrapper shares to the collateral vault but leaves the `dStable` allowance granted to the StaticAToken wrapper in place. If any dStable is later transferred into the adapter (operator mistake, griefing, or wrapper compromise), the wrapper can sweep those funds using the standing approval.
- **Recommendation**: Mirror `MetaMorphoConversionAdapter` and clear the allowance (`forceApprove(..., 0)`) after a successful deposit.
- **Decision**: Team accepts the residual approval risk for this deployment; documenting here to avoid re-reporting.

### 2. Router deposit approval style
- **Component**: `contracts/vaults/dstake/DStakeTokenV2.sol:215-231`
- **Issue**: `_deposit` relies on vanilla `approve` before delegating to the router. Non-standard ERC20s that require allowance resets could break deposits.
- **Recommendation**: Switch to `forceApprove` with a zero clear once the router pulls funds, matching the rest of the codebase’s defensive approvals.
- **Decision**: Considered low impact for dStable; no change planned.

### 3. Adapter valuation revert bricks totalAssets
- **Component**: `contracts/vaults/dstake/DStakeCollateralVaultV2.sol:84`
- **Issue**: Any adapter that reverts in `strategyShareValueInDStable` bubbles up through `totalValueInDStable`, causing `DStakeToken.totalAssets()` and every ERC4626 preview/deposit/withdraw path to revert, effectively freezing the vault while the adapter is unhealthy (e.g., oracle stale or paused).
- **Decision**: Accepted risk per governance direction; no mitigation planned this cycle.

### 4. MetaMorpho withdrawal underreports redeemed balance
- **Component**: `contracts/vaults/dstake/adapters/MetaMorphoConversionAdapter.sol:198`
- **Issue**: If the adapter already holds MetaMorpho shares (dust transfers or previous leftovers), `withdrawFromStrategy` redeems them to the router but still returns only the first redemption amount. The router and token trust the return value for slippage and fee accounting, so the extra dStable lingers as untracked surplus and emitted events misstate the withdrawal.
- **Decision**: Accepted risk per governance direction.

---
*Status: Identified high-severity issues are mitigated; follow-ups focus on observability and long-tail adapter support.*
