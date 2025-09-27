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

### 4. Removing vault with live balance halts NAV
- **Severity**: Medium
- **Component**: `contracts/vaults/dstake/DStakeRouterV2.sol:795-863`, `:1542-1598`, `contracts/vaults/dstake/interfaces/IDStakeRouterV2.sol:88-99`
- **Fix**: Vault removals now enforce a residual-balance guard and expose governance tooling to handle both recoverable and impaired strategies. `sweepStrategyDust` withdraws dust through the adapter (optionally redepositing into a target vault), while `acknowledgeStrategyLoss` + `forceRemoveVault` let operators retire unrecoverable shares after recording the loss. This keeps NAV queryable without blocking adapter rotations.
- **Tests**: `test/dstake/DStakeRouterV2.test.ts` covers dust sweeps, impairment flow, and hostile adapter swaps; `test/dstake/DStakeRewardManagerMetaMorpho.test.ts` exercises adapter removal under the new guard.

### 5. maxWithdraw publishes capacity the active vault cannot honor
- **Severity**: High
- **Component**: `contracts/vaults/dstake/DStakeRouterV2.sol:284-309`, `:410-427`, `:1273-1291`
- **Fix**: `_maxSingleVaultWithdraw()` now reuses the deterministic withdrawal selector so router capacity mirrors the vault the next exit will actually target. ERC4626 `maxWithdraw/maxRedeem` consequently surface accurate limits even when allocations are balanced or vault statuses change.
- **Tests**: `test/dstake/DStakeRouterV2.test.ts` covers balanced-set fallback behaviour and the suspended-vault scenario to ensure the reported capacity tracks the active vault.
- **Status**: Verified end-to-end; no follow-up actions required.

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

### 12. Dust share redeem burns shares without payout
- **Severity**: Low
- **Component**: `contracts/vaults/dstake/DStakeTokenV2.sol:318`
- **Impact**: Calling `redeem` with a very small share amount (e.g., when the vault has a large supply but near-zero net assets after a recorded shortfall) causes `_withdraw` to hit the `assets == 0` branch. The router hook is skipped, the shares are permanently burned, and the caller gets no assets despite the vault still holding value for larger withdrawals. Automated integrators that redeem in tiny batches can silently lose principal.
- **Reproduction**:
  1. Stand up a fork/local test, deposit to create supply, and record a shortfall so `previewRedeem(1)` returns zero.
  2. Call `redeem(1, receiver, owner)` from the token.
  3. Observe that `Withdraw` emits with zero assets, the caller receives nothing, and the router never ran, so the burned share’s pro-rata value stays in the pool.

## Acknowledged (Won't Fix)

### 1. Positive-slippage withdrawals dilute remaining holders
- **Severity**: Critical
- **Component**: `contracts/vaults/dstake/DStakeTokenV2.sol:321-326`, `contracts/vaults/dstake/DStakeRouterV2.sol:454-468`, `:624-685`
- **Rationale**: Current adapters already normalize any positive slippage or reward accrual before reporting vault valuations, so the router never observes `grossWithdrawn` above its previews. Strategy exits that could return bonuses are handled within the adapter layer; any surplus is retained or netted there. Given that architectural contract, the dilution path is unreachable and we accept the risk contingent on adapters preserving this invariant.

## Open Questions

*(none currently)*
