> **Use this tracker to keep reviews efficient:** Log fresh findings under **Open**, migrate them to **Resolved** once the fix lands (include pointers to patches/tests), and park accepted risks in **Acknowledged (Won't Fix)** with rationale so auditors know not to re-raise them.

### Logging checklist for auditors
- Skim all existing entries before adding a new one to avoid duplicates.
- Capture severity, affected component (file + scope), and a succinct impact description.
- Reference code with `file.sol:line` anchors so maintainers can jump straight to the context.
- Leave remediation ideas out for now—we're focused on discovery during this pass.

# dSTAKE v2 Audit Tracker

Updates capture the most recent review cycle. Items are grouped by current status so we can focus the next pass efficiently.

## Resolved

### 1. Redeem double-charges withdrawal fee
- **Severity**: High
- **Component**: `contracts/vaults/dstake/DStakeTokenV2.sol:181`, `:286-295`
- **Impact**: `redeem()` passes the fee-reduced preview into `_withdraw`, leading the router to reapply the withdrawal fee so redeemers receive roughly `(1 – feeBps/10_000)^2` of their claim while `previewRedeem` only advertises a single fee. The excess accrues to remaining holders.
- **Reproduction**: 1) Configure a non-zero withdrawal fee via `setWithdrawalFee`. 2) Hold shares and call `previewRedeem(shares)` to observe the single-fee deduction. 3) Execute `redeem(shares, receiver, owner)` and note the emitted/returned amount equals `previewRedeem(shares) – fee(previewRedeem(shares))`, evidencing the second fee.
- **Fix**: `contracts/vaults/dstake/DStakeTokenV2.sol` now passes the gross preview to `_withdraw`; regression coverage lives in `test/dstake/RedeemWithdrawalFee.test.ts`.

### 2. Deposits mispriced under settlement shortfall
- **Severity**: Medium
- **Component**: `contracts/vaults/dstake/DStakeTokenV2.sol:157-201`
- **Impact**: `previewDeposit`/`previewMint` ignore `router.currentShortfall()`, so when governance records a deficit new deposits mint `assets * totalSupply / grossTotalAssets` shares but those shares redeem against `(gross – shortfall)` value, forcing newcomers to donate the logged shortfall to incumbents instead of socializing it via share price.
- **Fix**: `previewDeposit`/`previewMint` now convert using `totalAssets()` (net of `currentShortfall()`), and `test/dstake/SettlementShortfall.test.ts` adds regression cases covering deposit quotes and shortfall recovery socialization.

### 3. Deterministic withdraw selector strands liquidity
- **Severity**: High
- **Component**: `contracts/vaults/dstake/DStakeRouterV2.sol:397`, `contracts/vaults/dstake/DStakeRouterV2.sol:1237`, `contracts/vaults/dstake/libraries/DeterministicVaultSelector.sol:198`
- **Impact**: When allocations exactly match targets `selectTopOverallocated` falls back to `vaults[0]`, so `handleWithdraw` always routes to that single vault even if it cannot cover the request. Withdrawals larger than that vault’s balance revert with `NoLiquidityAvailable` while `maxWithdraw` still reports the system-wide limit, effectively freezing withdrawals despite ample liquidity elsewhere.
- **Reproduction**: 1) Configure two vaults with target weights (e.g., 10%/90%) and rebalance so balances == targets. 2) `maxWithdraw` advertises the large vault capacity. 3) `withdraw` any amount exceeding the first vault’s cash but within `maxWithdraw`; the router picks the first vault, `previewWithdraw` underflows liquidity, and the call reverts with `NoLiquidityAvailable`.

### 4. MetaMorpho valuation masks paused withdrawals
- **Severity**: High
- **Component**: `contracts/vaults/dstake/adapters/MetaMorphoConversionAdapter.sol:217-230`
- **Impact**: If the MetaMorpho vault pauses or otherwise makes `previewRedeem` revert, the adapter falls back to `convertToAssets`, keeping valuations at par even though `redeem` will still revert. dSTAKE continues minting shares 1:1 while any withdrawal or rebalance that touches the adapter bricks, trapping new deposits.
- **Reproduction**: 1) Put the MetaMorpho vault in a state where `previewRedeem` reverts but `convertToAssets` still returns the last rate (e.g., pause withdrawals). 2) Observe `DStakeToken.totalAssets()` and previews remain unchanged. 3) Deposit through dSTAKE; shares mint at par. 4) Attempt a withdrawal or rebalance against the MetaMorpho adapter; the underlying `redeem` reverts, freezing funds even though accounting considered them liquid.
- **Fix**: Adapter now propagates preview failures so valuations mark the position illiquid; regressions live in `test/dstake/MetaMorphoAdapter.emergency.test.ts` and `test/dstake/MetaMorphoAdapter.valuation.test.ts`.

### 5. Solver withdraw bypasses vault pause
- **Severity**: High
- **Component**: `contracts/vaults/dstake/DStakeRouterV2.sol:1268`
- **Impact**: `_withdrawSharesFromVaultAtomically` skipped `_isVaultStatusEligible`, so `solverWithdrawShares` could redeem from vaults marked `Suspended`, draining quarantined strategies while governance believed exits were halted.
- **Reproduction**: 1) Pause a vault via `emergencyPauseVault`. 2) Have any share holder call `solverWithdrawShares([vault], [shareAmount], maxShares, receiver, owner)`. 3) Observe dStable returned despite the suspension, showing the pause was bypassed.
- **Fix**: `_withdrawSharesFromVaultAtomically` now enforces `_isVaultStatusEligible` before moving shares, and `test/dstake/DStakeSolverMode.test.ts` adds a regression ensuring solver withdrawals revert once a vault is suspended.

### 6. Share rebalances ignore paused vaults *(Resolved)*
- **Severity**: High
- **Component**: `contracts/vaults/dstake/DStakeRouterV2.sol:780-848`
- **Impact**: `_rebalanceStrategiesByShares` and the external-liquidity variant skipped vault status gating, so operators with `STRATEGY_REBALANCER_ROLE` could keep funding a `Suspended` strategy, undermining the pause quarantine.
- **Reproduction**: 1) Pause a vault via `emergencyPauseVault`. 2) Call `rebalanceStrategiesByShares` or `rebalanceStrategiesBySharesViaExternalLiquidity` targeting the suspended vault. 3) Observe the paused vault receiving new shares/assets despite the suspension.
- **Fix**: `_rebalanceStrategiesByShares` and the external-liquidity helper now fetch `VaultConfig` metadata for both legs and enforce `_isVaultStatusEligible` on withdrawal and deposit operations. Regression tests: `test/dstake/DStakeRouterV2.test.ts` cases “rejects share rebalances into suspended vaults” and “rejects external-liquidity rebalances that target suspended vaults”.

### 7. sweepSurplus refills paused default vault *(Resolved)*
- **Severity**: Medium
- **Component**: `contracts/vaults/dstake/DStakeRouterV2.sol:980-1012`
- **Impact**: `sweepSurplus` blindly forwarded idle dStable into `defaultDepositStrategyShare`, so a suspended default vault was silently restocked the next time surplus was swept.
- **Reproduction**: 1) Set a vault as `defaultDepositStrategyShare`. 2) Pause it with `emergencyPauseVault`. 3) Transfer dStable to the router and call `sweepSurplus`; the suspended vault received the funds.
- **Fix**: `sweepSurplus` now loads the default vault’s config and enforces deposit eligibility before forwarding funds; regression test `test/dstake/DStakeRouterV2.test.ts` “refuses to sweep surplus into a suspended default vault”.

## Open

### 6. Fee-applied convertToAssets breaks ERC4626 invariants
- **Severity**: Medium
- **Component**: `contracts/vaults/dstake/DStakeTokenV2.sol:181`
- **Impact**: `convertToAssets` and `previewRedeem` apply `_getNetAmountAfterFee`, so with any withdrawal fee `convertToAssets(totalSupply())` undercounts `totalAssets()` and `convertToShares(convertToAssets(x)) < x`, misleading integrators that rely on ERC4626 conversions and understating vault equity by the fee percentage.
- **Reproduction**: 1) Set a non-zero withdrawal fee (e.g., `setWithdrawalFee(1000)`). 2) Deposit to mint shares. 3) Observe `totalAssets()` versus `convertToAssets(totalSupply())`, or round-trip `convertToShares(convertToAssets(shares))` returning fewer shares, showing the invariant break.

### 7. Share rebalances ignore paused vaults
- **Severity**: High
- **Component**: `contracts/vaults/dstake/DStakeRouterV2.sol:780-848`
- **Impact**: `_rebalanceStrategiesByShares` and the external-liquidity variant skip any vault-status gate, so after `emergencyPauseVault` a `STRATEGY_REBALANCER_ROLE` caller can keep routing liquidity into the suspended strategy, undermining quarantine.
- **Reproduction**: 1) Pause a vault via `emergencyPauseVault`. 2) Call `rebalanceStrategiesByShares` (or `_rebalanceStrategiesWithExternalLiquidity`) from an active vault into the paused one. 3) Observe the paused vault receives new shares/assets despite being suspended.

### 8. sweepSurplus refills paused default vault
- **Severity**: Medium
- **Component**: `contracts/vaults/dstake/DStakeRouterV2.sol:980-1012`
- **Impact**: `sweepSurplus` blindly deposits leftover dStable into `defaultDepositStrategyShare` without checking its status. If governance pauses that vault, the next surplus sweep silently restocks it, undoing the pause intent.
- **Reproduction**: 1) Set a vault as `defaultDepositStrategyShare` and then pause it. 2) Accumulate idle dStable (fees or manual transfer) in the router. 3) Call `sweepSurplus`; funds are forwarded into the paused vault.

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

### 5. Skim recipient drift strands MetaMorpho rewards
- **Component**: `contracts/vaults/dstake/rewards/DStakeRewardManagerMetaMorpho.sol:161`
- **Issue**: `skimRewards` assumes the MetaMorpho vault’s `skimRecipient` remains pointed at the trusted URD; if it drifts, the next skim donates rewards to an attacker or stale recipient without reverting.
- **Decision**: Governance accepts this assumption as consistent with existing operational guarantees; no change planned.

### 6. Reward compounding bypasses router pause
- **Severity**: Medium
- **Component**: `contracts/vaults/dstake/rewards/DStakeRewardManagerMetaMorpho.sol:243`
- **Impact**: `_processExchangeAssetDeposit` invokes adapters directly, so fee recycling can repopulate suspended strategies despite router pauses, reintroducing quarantined exposure.
- **Decision**: Accepted; operators will handle compounding halts operationally during pause events.

### 7. Reward compounding bypasses deposit cap
- **Severity**: Medium
- **Component**: `contracts/vaults/dstake/rewards/DStakeRewardManagerMetaMorpho.sol:243`, `contracts/vaults/dstake/DStakeRouterV2.sol:249-326`
- **Impact**: `_processExchangeAssetDeposit` forwards dStable into adapters without running `_enforceDepositCap`, so compounding still adds fresh capital after governance has set the cap to zero.
- **Decision**: Governance treats these deposits as equivalent to organic NAV growth and accepts the cap drift for this deployment.

### 8. Emergency pause bricks single-vault withdrawals
- **Severity**: High
- **Component**: `contracts/vaults/dstake/DStakeRouterV2.sol:354-414`, `contracts/vaults/dstake/DStakeRouterV2.sol:1105-1116`, `contracts/vaults/dstake/DStakeRouterV2.sol:1342-1359`
- **Impact**: `emergencyPauseVault` marks a lone strategy `Suspended`, so `_selectVaultForWithdrawal` reverts until governance reconfigures allocations.
- **Decision**: Intentional—pausing the sole vault is treated as a full shutdown; operators must restore liquidity via governance before withdrawals resume.

---
*Status: Identified high-severity issues are mitigated; follow-ups focus on observability and long-tail adapter support.*
