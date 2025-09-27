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

### 3. Redeem path double-charges withdrawal fee
- **Severity**: Low
- **Component**: `contracts/vaults/dstake/DStakeTokenV2.sol:181`, `contracts/vaults/dstake/DStakeTokenV2.sol:286-324`
- **Fix**: `redeem` now pulls the pre-fee amount via `super.previewRedeem` before applying `_getNetAmountAfterFee`, ensuring the withdrawal fee is assessed exactly once while forwarding the correct gross value to the router.
- **Tests**: `test/dstake/FeeAccountingRegression.test.ts` asserts `previewRedeem` matches actual payouts, catching any future double-fee regressions.

### 4. Deposit/mint previews ignore recorded shortfall
- **Severity**: High
- **Component**: `contracts/vaults/dstake/DStakeTokenV2.sol:136-204`
- **Fix**: Preview helpers now use `_netManagedAssets()` (gross assets minus recorded shortfall) so `previewDeposit`/`previewMint` align with the NAV that withdrawals redeem. `totalAssets()` delegates to the same helper, keeping ERC4626 invariants consistent.
- **Tests**: `test/dstake/SettlementShortfall.test.ts` verifies preview parity during active shortfalls and that insolvency saturates `totalAssets()` without reverting.

### 5. maxWithdraw publishes capacity the active vault cannot honor
- **Severity**: High
- **Component**: `contracts/vaults/dstake/DStakeRouterV2.sol:1182-1189`, `:396-413`
- **Fix**: `_maxSingleVaultWithdraw()` now reuses the deterministic withdrawal selector so router capacity mirrors the vault the next exit will actually target. ERC4626 `maxWithdraw/maxRedeem` consequently surface accurate limits even when allocations are balanced or vault statuses change.
- **Tests**: `test/dstake/DStakeRouterV2.test.ts` covers balanced-set fallback behaviour and the suspended-vault scenario to ensure the reported capacity tracks the active vault.

### 6. Surplus sweep ignores adapter slippage checks
- **Severity**: Medium
- **Component**: `contracts/vaults/dstake/DStakeRouterV2.sol:970-979`
- **Fix**: `sweepSurplus` now routes through `_depositToVaultAtomically`, inheriting adapter preview, share-delta, and allowance hygiene checks before surplus capital re-enters strategies.
- **Tests**: `test/dstake/DStakeRouterV2.test.ts` adds a surplus sweep regression that confirms router-held fees are redeployed into the default vault.

### 7. Rebalance adapters can zero out collateral
- **Severity**: High
- **Component**: `contracts/vaults/dstake/DStakeRouterV2.sol:789-879`
- **Fix**: Both rebalance paths deposit via `_depositToVaultAtomically`, measuring actual share deltas and reusing slippage guards instead of trusting adapter return values. This prevents adapters from claiming minted shares without transferring them.
- **Tests**: `test/dstake/DStakeRouterV2.test.ts` hostile-adapter regressions now pass because bogus share reports trigger slippage checks.

### 8. Shortfall cap hides new deficits once underwater
- **Severity**: Critical
- **Component**: `contracts/vaults/dstake/DStakeRouterV2.sol:753-761`
- **Fix**: Removed the `totalManagedAssets()` cap so governance can record losses that exceed current assets. NAV now saturates at zero while insolvency persists, preserving liability accounting.
- **Tests**: `test/dstake/SettlementShortfall.test.ts` pushes the system underwater and asserts that additional shortfalls record cleanly and `totalAssets()` clamps to zero.

### 9. migrateCore can orphan router permissions and lock withdrawals
- **Severity**: Medium
- **Component**: `contracts/vaults/dstake/DStakeTokenV2.sol:380-409`, `deploy/08_dstake/03_configure_dstake.ts:90-120`
- **Fix**: `migrateCore` now insists the collateral vault already recognizes the incoming router, and the deployment script sets that relationship before migrating. This prevents transient `ROUTER_ROLE` gaps that previously bricked withdrawals.
- **Tests**: `test/dstake/DStakeToken.ts` covers the missing-router-role revert and the happy path, while the deployment script change keeps fixtures aligned.

### 10. Router migration wipes recorded shortfall
- **Severity**: Critical
- **Component**: `contracts/vaults/dstake/DStakeTokenV2.sol:399-405`
- **Fix**: The token snapshots `router.currentShortfall()` before swapping routers and re-records it on the replacement, preserving liabilities across upgrades.
- **Tests**: `test/dstake/DStakeToken.ts` asserts that migrating routers keeps the outstanding shortfall intact.

### 11. reinvestFees leaks shortfall collateral via incentives
- **Severity**: High
- **Component**: `contracts/vaults/dstake/DStakeRouterV2.sol:690-717`
- **Fix**: `reinvestFees` now reverts while a shortfall is outstanding so recovery capital cannot be siphoned through caller incentives.
- **Tests**: `test/dstake/FeeAccountingRegression.test.ts` adds a shortfall scenario that confirms reinvestment is blocked until losses are cleared.

## Open
### 4. Removing vault with live balance halts NAV
- **Severity**: Medium
- **Component**: `contracts/vaults/dstake/DStakeRouterV2.sol:1481-1523`, `contracts/vaults/dstake/DStakeCollateralVaultV2.sol:73-90`
- **Impact**: `removeVault`/`removeVaultConfig` delete the adapter mapping even if the collateral vault still holds that strategy’s shares. The share stays listed as supported but now lacks an adapter, so `totalValueInDStable` and downstream valuations revert with `AdapterValuationUnavailable`, freezing deposits/withdrawals while the remaining balance becomes unreachable until governance re-adds the config.
- **Status**: Needs design follow-up — simply reverting when balances remain blocks adapter rotation in edge cases, but leaving the mapping unset bricks NAV. We need an explicit dust-handling story before changing behaviour.
- **Suggested fix**: Gate vault removal behind a zero-balance check *and* provide a helper (or documented playbook) that force-withdraws residual dust prior to removal, so adapters can still be rotated without reintroducing griefing vectors.
- **Testing**: Add a regression in `test/dstake/DStakeRouterV2.test.ts` that removes a vault with residual shares and asserts valuation calls revert.

### 5. maxWithdraw publishes capacity the active vault cannot honor
- **Severity**: High
- **Component**: `contracts/vaults/dstake/DStakeRouterV2.sol:271-304`, `:397-454`, `:1190-1199`
- **Impact**: `maxWithdraw`/`maxRedeem` advertise the largest single-vault balance via `_maxSingleVaultWithdraw`, but when no vault is over target the withdrawal selector falls back to the first active vault. If that vault has less than the advertised capacity (e.g., target zero but still active with dust), `handleWithdraw` reverts with `NoLiquidityAvailable`. Integrators that respect ERC4626 limits still face withdrawal DoS despite staying within the published bound.
- **Reproduction**: Configure two active vaults where the first holds dust but the second holds liquidity; observe `maxWithdraw` returning the larger second-vault balance, then call `withdraw` within that limit—`_selectVaultForWithdrawal` picks the dust-heavy first vault and `_withdrawFromVaultAtomically` reverts with `NoLiquidityAvailable`.
- **Status**: Low hanging fruit — we just need to align the ERC4626 limit with the router’s deterministic vault selector.
- **Suggested fix**: Reuse the same selection path as `_selectVaultForWithdrawal` (including the “no overallocations” fallback) when computing router capacity so `maxWithdraw` reflects the vault that will service the next exit. Keep returning the min of user capacity and router capacity.
- **Testing**: Add a regression that withdraws the published `maxWithdraw` limit under this setup and expects `NoLiquidityAvailable` to surface.

### 6. Surplus sweep ignores adapter slippage checks
- **Severity**: Medium
- **Component**: `contracts/vaults/dstake/DStakeRouterV2.sol:980-999`
- **Status**: Low hanging fruit — the router already has deposit helpers that enforce share deltas.
- **Suggested fix**: Route `sweepSurplus` through `_depositToVaultAtomically` (or replicate its before/after balance checks) so the adapter must mint the expected share amount or revert, then cover the scenario in router surplus tests.
- **Testing**: Introduce a `sweepSurplus` scenario in `test/dstake/DStakeRouterV2.test.ts` where the adapter under-delivers and assert the router guards against the slippage.

### 7. Rebalance adapters can zero out collateral
- **Severity**: High
- **Component**: `contracts/vaults/dstake/DStakeRouterV2.sol:790-903`
- **Status**: Low hanging fruit — we can reuse existing deposit checks to measure the actual share delta instead of trusting adapter return values.
- **Suggested fix**: Measure the collateral-vault balance change (or call `_depositToVaultAtomically`) when depositing into the destination strategy and derive `resultingToShareAmount` from that delta, guaranteeing adapters can’t lie about minted shares. Update rebalancing tests with a hostile adapter case.
- **Testing**: Add a malicious-adapter rebalance scenario in `test/dstake/DStakeRouterV2.test.ts` to ensure bogus `resultingToShareAmount` values are rejected.

### 8. Shortfall cap hides new deficits once underwater
- **Severity**: Critical
- **Component**: `contracts/vaults/dstake/DStakeRouterV2.sol:750-757`, `contracts/vaults/dstake/DStakeTokenV2.sol:357-367`
- **Status**: Low hanging fruit — removing the cap keeps accounting truthful without impacting healthy-path maths.
- **Suggested fix**: Drop the `newShortfall > totalManagedAssets()` guard (and associated custom error). `totalAssets()` already saturates at zero when liabilities exceed assets, so the system can represent insolvency correctly. Extend the shortfall tests to cover the underwater case.

### 9. migrateCore can orphan router permissions and lock withdrawals
- **Severity**: Medium
- **Component**: `contracts/vaults/dstake/DStakeTokenV2.sol:371-389`, `contracts/vaults/dstake/DStakeCollateralVaultV2.sol:103-155`
- **Impact**: `migrateCore` only checks the new router’s token/collateral pairing. If governance calls it before `DStakeCollateralVaultV2.setRouter`, the updated router lacks `ROUTER_ROLE`, so every withdrawal reverts with `AccessControlUnauthorizedAccount` until a second transaction fixes the grant.
- **Status**: Low hanging fruit — adding a preflight check avoids the bricked state without complicating migration.
- **Suggested fix**: Require `IDStakeCollateralVaultV2(newCollateralVault).router() == newRouter` before finalizing `migrateCore`, so governance must install the new router on the collateral vault first (or add a helper that does so atomically). Update migration tests accordingly.

### 10. Router migration wipes recorded shortfall
- **Severity**: Critical
- **Component**: `contracts/vaults/dstake/DStakeTokenV2.sol:357-389`, `contracts/vaults/dstake/DStakeRouterV2.sol:732-758`
- **Impact**: `migrateCore` installs a fresh router without copying `settlementShortfall`. `totalAssets()` drops the liability instantly, so anyone withdrawing before governance re-records it can drain recapitalized funds that should cover past losses.
- **Reproduction**: With a recorded shortfall, deploy a new router and call `migrateCore`; before governance re-runs `setSettlementShortfall`, call `redeem` to withdraw assets at the inflated NAV, draining the funds earmarked to cover the deficit.
- **Status**: Low hanging fruit — we can snapshot the current shortfall and seed it into the new router during migration.
- **Suggested fix**: Capture `router.currentShortfall()` before the swap and invoke `recordShortfall` on the freshly installed router (skipping if zero). Extend migration tests to ensure the liability carries over.

### 11. reinvestFees leaks shortfall collateral via incentives
- **Severity**: High
- **Component**: `contracts/vaults/dstake/DStakeRouterV2.sol:696-738`
- **Impact**: `reinvestFees` pays caller incentives and redeploys fees even when `settlementShortfall` is non-zero. Keepers can repeatedly collect up to the 20% incentive from assets meant to plug the shortfall, worsening insolvency and delaying recovery for legacy holders.
- **Reproduction**: After recording a shortfall, transfer fee revenue to the router and call `reinvestFees`; observe the incentive payment to the caller while `currentShortfall()` remains unchanged, proving that recovery capital leaks to opportunistic keepers.
- **Status**: Low hanging fruit — a single guard keeps recovery capital from leaking.
- **Suggested fix**: Early-return or revert from `reinvestFees` while `settlementShortfall > 0` (optionally auto-clearing the deficit before paying incentives). Update fee regression tests to assert reinvestment is blocked until the shortfall is cleared.

## Acknowledged (Won't Fix)

### 1. Positive-slippage withdrawals dilute remaining holders
- **Severity**: Critical
- **Component**: `contracts/vaults/dstake/DStakeTokenV2.sol:321-326`, `contracts/vaults/dstake/DStakeRouterV2.sol:454-468`, `:624-685`
- **Rationale**: Current adapters already normalize any positive slippage or reward accrual before reporting vault valuations, so the router never observes `grossWithdrawn` above its previews. Strategy exits that could return bonuses are handled within the adapter layer; any surplus is retained or netted there. Given that architectural contract, the dilution path is unreachable and we accept the risk contingent on adapters preserving this invariant.

## Open Questions

*(none currently)*
