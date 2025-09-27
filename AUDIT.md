> **Use this tracker to keep reviews efficient:** Log fresh findings under **Open**, migrate them to **Resolved** once the fix lands (include pointers to patches/tests), and park accepted risks in **Acknowledged (Won't Fix)** with rationale so auditors know not to re-raise them.

### Logging checklist for auditors
- Skim all existing entries before adding a new one to avoid duplicates.
- Capture severity, affected component (file + scope), and a succinct impact description.
- Reference code with `file.sol:line` anchors so maintainers can jump straight to the context.
- Leave remediation ideas out for now—we're focused on discovery during this pass.

### Severity rubric
- **Critical** – Exploitable path to steal or permanently lock a substantial portion of user funds.
- **High** – Exploitable path to freeze user funds or materially degrade the product until intervention.
- **Medium** – Governance/operator misstep can easily trigger loss or disruption.
- **Low** – All other correctness, spec, or UX deviations.

# dSTAKE v2 Audit Tracker

Updates capture the most recent review cycle. Items are grouped by current status so we can focus the next pass efficiently.

## Resolved

### 2. Solver withdraw bypasses suspended vaults
- **Severity**: High
- **Component**: `contracts/vaults/dstake/DStakeRouterV2.sol:633-685`, `:1268-1285`
- **Fix**: Share-based solver exits now convert to gross asset requests up front and route through `_executeGrossWithdrawals`, so every withdrawal hits `_withdrawFromVaultAtomically` and its `VaultNotActive` guard. Removed the bespoke `_withdrawSharesFromVaultAtomically` helper that bypassed status checks.
- **Tests**: `test/dstake/DStakeSolverMode.test.ts` now covers solver asset- and share-withdrawals against suspended vaults and expects `VaultNotActive`.

## Open
### 3. Redeem path double-charges withdrawal fee
- **Severity**: Low
- **Component**: `contracts/vaults/dstake/DStakeTokenV2.sol:181`, `contracts/vaults/dstake/DStakeTokenV2.sol:286-324`
- **Impact**: `convertToAssets` delegates to `previewRedeem`, which already returns a net-of-fee amount. `redeem` then treats that value as the gross it forwards to `_withdraw`, and the router re-applies the withdrawal fee. Redeemers receive less than previews promise while the vault’s accounting shows an artificial share-price lift.
- **Testing**: Add a `redeem`-path assertion to `test/dstake/FeeAccountingRegression.test.ts` comparing `previewRedeem` to actual payouts to catch double-charging.

### 4. Deposit/mint previews ignore recorded shortfall
- **Severity**: High
- **Component**: `contracts/vaults/dstake/DStakeTokenV2.sol:157-190`
- **Impact**: Deposit/mint previews divide by `router.totalManagedAssets()` (gross) even when `router.currentShortfall()` is non-zero. Incoming capital mints shares against the higher gross denominator, immediately socializing legacy losses and violating preview expectations.
- **Reproduction**: After recording a shortfall (e.g., `setSettlementShortfall(20)` with 100 assets), call `previewDeposit(10)` to see it return ~10 even though `convertToAssets(10)` ≈ 8; executing `deposit(10, user)` mints 10 shares that redeem for only 8 assets, proving new entrants instantly absorb old losses.
- **Testing**: Expand `test/dstake/SettlementShortfall.test.ts` to deposit during an active shortfall and assert share price neutrality (new shares match net assets).

### 5. Removing vault with live balance halts NAV
- **Severity**: Medium
- **Component**: `contracts/vaults/dstake/DStakeRouterV2.sol:1481-1523`, `contracts/vaults/dstake/DStakeCollateralVaultV2.sol:73-90`
- **Impact**: `removeVault`/`removeVaultConfig` delete the adapter mapping even if the collateral vault still holds that strategy’s shares. The share stays listed as supported but now lacks an adapter, so `totalValueInDStable` and downstream valuations revert with `AdapterValuationUnavailable`, freezing deposits/withdrawals while the remaining balance becomes unreachable until governance re-adds the config.
- **Testing**: Add a regression in `test/dstake/DStakeRouterV2.test.ts` that removes a vault with residual shares and asserts valuation calls revert.

### 6. maxWithdraw publishes capacity the active vault cannot honor
- **Severity**: High
- **Component**: `contracts/vaults/dstake/DStakeRouterV2.sol:271-304`, `:397-454`, `:1190-1199`
- **Impact**: `maxWithdraw`/`maxRedeem` advertise the largest single-vault balance via `_maxSingleVaultWithdraw`, but when no vault is over target the withdrawal selector falls back to the first active vault. If that vault has less than the advertised capacity (e.g., target zero but still active with dust), `handleWithdraw` reverts with `NoLiquidityAvailable`. Integrators that respect ERC4626 limits still face withdrawal DoS despite staying within the published bound.
- **Reproduction**: Configure two active vaults where the first holds dust but the second holds liquidity; observe `maxWithdraw` returning the larger second-vault balance, then call `withdraw` within that limit—`_selectVaultForWithdrawal` picks the dust-heavy first vault and `_withdrawFromVaultAtomically` reverts with `NoLiquidityAvailable`.
- **Testing**: Add a regression that withdraws the published `maxWithdraw` limit under this setup and expects `NoLiquidityAvailable` to surface.

### 7. Surplus sweep ignores adapter slippage checks
- **Severity**: Medium
- **Component**: `contracts/vaults/dstake/DStakeRouterV2.sol:980-999`
- **Impact**: `sweepSurplus` pushes router-held dStable into the default adapter without previewing or checking the minted share amount. If the adapter returns fewer shares than expected (fees, rounding, or malicious behaviour), the router still burns the dStable with no revert, silently eroding accrued fees and diluting holders.
- **Testing**: Introduce a `sweepSurplus` scenario in `test/dstake/DStakeRouterV2.test.ts` where the adapter under-delivers and assert the router guards against the slippage.

### 8. Rebalance adapters can zero out collateral
- **Severity**: High
- **Component**: `contracts/vaults/dstake/DStakeRouterV2.sol:790-903`
- **Impact**: `_rebalanceStrategiesByShares` and the external-liquidity variant trust adapter-reported `resultingToShareAmount` without checking the collateral vault balance delta. A malicious or degraded adapter can claim success, causing the router to burn source shares and leave the destination vault empty.
- **Reproduction**: Install a malicious adapter for the destination share, then invoke `rebalanceStrategiesByShares`; the router withdraws real assets, approves the adapter, and accepts its forged share report, leaving the system without the transferred collateral while the adapter keeps the funds.
- **Testing**: Add a malicious-adapter rebalance scenario in `test/dstake/DStakeRouterV2.test.ts` to ensure bogus `resultingToShareAmount` values are rejected.

### 9. Shortfall cap hides new deficits once underwater
- **Severity**: Critical
- **Component**: `contracts/vaults/dstake/DStakeRouterV2.sol:750-757`, `contracts/vaults/dstake/DStakeTokenV2.sol:357-367`
- **Impact**: `recordShortfall` caps debt at `totalManagedAssets`. Once the system is fully underwater, further losses revert instead of being tracked. After partial recapitalization the token reports a positive NAV, letting exiting users drain fresh liquidity while legacy liabilities remain unpaid.
- **Reproduction**: Drive total managed assets down (e.g., to 20) while liabilities are 80, then call `setSettlementShortfall(80)`—it reverts because `recordShortfall` refuses values above assets; deposit fresh capital and observe that existing holders can now redeem shares against that recapitalization even though 60 of losses remain unrecorded.
- **Testing**: Extend `test/dstake/SettlementShortfall.test.ts` to push the system underwater, attempt an additional loss, and document the missing liability tracking.

### 10. migrateCore can orphan router permissions and lock withdrawals
- **Severity**: Medium
- **Component**: `contracts/vaults/dstake/DStakeTokenV2.sol:371-389`, `contracts/vaults/dstake/DStakeCollateralVaultV2.sol:103-155`
- **Impact**: `migrateCore` only checks the new router’s token/collateral pairing. If governance calls it before `DStakeCollateralVaultV2.setRouter`, the updated router lacks `ROUTER_ROLE`, so every withdrawal reverts with `AccessControlUnauthorizedAccount` until a second transaction fixes the grant.
- **Testing**: Move or unskip the `migrateCore` suite in `test/dstake/DStakeToken.ts` and add a case where migration precedes vault role updates, expecting withdrawals to revert until permissions are repaired.

### 11. Router migration wipes recorded shortfall
- **Severity**: Critical
- **Component**: `contracts/vaults/dstake/DStakeTokenV2.sol:357-389`, `contracts/vaults/dstake/DStakeRouterV2.sol:732-758`
- **Impact**: `migrateCore` installs a fresh router without copying `settlementShortfall`. `totalAssets()` drops the liability instantly, so anyone withdrawing before governance re-records it can drain recapitalized funds that should cover past losses.
- **Reproduction**: With a recorded shortfall, deploy a new router and call `migrateCore`; before governance re-runs `setSettlementShortfall`, call `redeem` to withdraw assets at the inflated NAV, draining the funds earmarked to cover the deficit.
- **Testing**: Add a router-migration flow with an active shortfall in `test/dstake/SettlementShortfall.test.ts` to confirm the liability persists (or capture the observed drop).

### 12. reinvestFees leaks shortfall collateral via incentives
- **Severity**: High
- **Component**: `contracts/vaults/dstake/DStakeRouterV2.sol:696-738`
- **Impact**: `reinvestFees` pays caller incentives and redeploys fees even when `settlementShortfall` is non-zero. Keepers can repeatedly collect up to the 20% incentive from assets meant to plug the shortfall, worsening insolvency and delaying recovery for legacy holders.
- **Reproduction**: After recording a shortfall, transfer fee revenue to the router and call `reinvestFees`; observe the incentive payment to the caller while `currentShortfall()` remains unchanged, proving that recovery capital leaks to opportunistic keepers.
- **Testing**: Expand `test/dstake/FeeAccountingRegression.test.ts` with a recorded shortfall to demonstrate `reinvestFees` cannot siphon recovery capital.

## Acknowledged (Won't Fix)

### 1. Positive-slippage withdrawals dilute remaining holders
- **Severity**: Critical
- **Component**: `contracts/vaults/dstake/DStakeTokenV2.sol:321-326`, `contracts/vaults/dstake/DStakeRouterV2.sol:454-468`, `:624-685`
- **Rationale**: Current adapters already normalize any positive slippage or reward accrual before reporting vault valuations, so the router never observes `grossWithdrawn` above its previews. Strategy exits that could return bonuses are handled within the adapter layer; any surplus is retained or netted there. Given that architectural contract, the dilution path is unreachable and we accept the risk contingent on adapters preserving this invariant.

## Open Questions

*(none currently)*
