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

### 8. Settlement ratio zero guard
- **Component**: `contracts/vaults/dstake/DStakeTokenV2.sol`
- **Fix**: `setSettlementRatio` now rejects zero ratios, preventing governance from bricking conversions with a zero hair-cut while the runtime math still assumes a positive scale (`DStakeTokenV2.sol:764-772`).
- **Tests**: Updated `test/dstake/SettlementRatio.test.ts` to assert the new revert and keep the rest of the suite intact.

### 9. Single-vault withdrawal DoS
- **Component**: `contracts/vaults/dstake/DStakeRouterV2.sol`, `contracts/vaults/dstake/DStakeTokenV2.sol`
- **Fix**: Rather than over-reporting liquidity that the deterministic router cannot satisfy, `DStakeRouterV2` now exposes `getMaxSingleVaultWithdraw`, and `DStakeTokenV2.maxWithdraw` clamps ERC4626 limits to that per-vault ceiling after fees (`DStakeRouterV2.sol:844-852`, `DStakeTokenV2.sol:274-288`, `IDStakeRouterV2.sol:76-78`). Integrators no longer observe withdraw amounts that would revert.
- **Tests**: `test/dstake/DStakeRouterV2.test.ts:246-289` adds "clamps maxWithdraw to the largest single-vault capacity", verifying the reported limit matches the largest vault and that requests above it revert with `ERC4626ExceedsMaxWithdraw`.
- **Residual risk**: The router still services a single vault per deterministic withdrawal; user exits above the cap must route through solver mode or wait for rebalancing. Tracking aggregate withdrawals across vaults remains future work.

## Open

- None

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

---
*Status: Identified high-severity issues are mitigated; follow-ups focus on observability and long-tail adapter support.*
