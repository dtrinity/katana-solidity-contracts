> **Use this tracker to keep reviews efficient:** Log fresh findings under **Open**, migrate them to **Resolved** once the fix lands (include pointers to patches/tests), and park accepted risks in **Acknowledged (Won't Fix)** with rationale so auditors know not to re-raise them.

### Logging checklist for auditors
- Skim all existing entries before adding a new one to avoid duplicates.
- Capture severity, affected component (file + scope), and a succinct impact description.
- Reference code with `file.sol:line` anchors so maintainers can jump straight to the context.
- Leave remediation ideas out for now—we're focused on discovery during this pass.

# dSTAKE v2 Audit Tracker

Updates capture the most recent review cycle. Items are grouped by current status so we can focus the next pass efficiently.

## Resolved

*(none this cycle)*

## Open

### 1. Positive-slippage withdrawals dilute remaining holders
- **Severity**: Critical
- **Component**: `contracts/vaults/dstake/DStakeTokenV2.sol:321-326`, `contracts/vaults/dstake/DStakeRouterV2.sol:454-468`, `:624-685`
- **Impact**: When adapters return more than the previewed gross amount, `handleWithdraw`/solver withdraws forward the full net result to the receiver even though the token already burned shares based on the previewed net. The excess payout lacks matching share destruction, lowering NAV per share for everyone else.
- **Notes**: Observed on both direct user withdrawals and solver flows because they share the same accounting pattern.
- **Reproduction**: Allow an adapter to accrue rewards so withdrawing `x` yields `x + Δ`; call `withdraw` for a dust net so only the previewed shares burn; router forwards the full `x + Δ`, letting the caller keep Δ without share dilution; repeat after each harvest until vault value is siphoned.

### 2. Solver withdraw bypasses suspended vaults
- **Severity**: High
- **Component**: `contracts/vaults/dstake/DStakeRouterV2.sol:633-685`, `:1268-1285`
- **Impact**: `solverWithdrawShares` ultimately calls `_withdrawSharesFromVaultAtomically` without enforcing `VaultStatus` checks, so callers can drain collateral from vaults marked `Suspended`. Governance cannot rely on the suspension control to cordon off a vault during emergencies because solver exits still succeed.
- **Reproduction**: Mark a vault `Suspended`, then invoke `solverWithdrawShares` on that vault; `_withdrawSharesFromVaultAtomically` ignores status and redeems shares, draining the supposedly quarantined position.

### 3. Redeem path double-charges withdrawal fee
- **Severity**: Low
- **Component**: `contracts/vaults/dstake/DStakeTokenV2.sol:181`, `contracts/vaults/dstake/DStakeTokenV2.sol:286-324`
- **Impact**: `convertToAssets` delegates to `previewRedeem`, which already returns a net-of-fee amount. `redeem` then treats that value as the gross it forwards to `_withdraw`, and the router re-applies the withdrawal fee. Redeemers receive less than previews promise while the vault’s accounting shows an artificial share-price lift.

### 4. Deposit/mint previews ignore recorded shortfall
- **Severity**: High
- **Component**: `contracts/vaults/dstake/DStakeTokenV2.sol:157-190`
- **Impact**: Deposit/mint previews divide by `router.totalManagedAssets()` (gross) even when `router.currentShortfall()` is non-zero. Incoming capital mints shares against the higher gross denominator, immediately socializing legacy losses and violating preview expectations.
- **Reproduction**: After recording a shortfall (e.g., `setSettlementShortfall(20)` with 100 assets), call `previewDeposit(10)` to see it return ~10 even though `convertToAssets(10)` ≈ 8; executing `deposit(10, user)` mints 10 shares that redeem for only 8 assets, proving new entrants instantly absorb old losses.

### 5. Removing vault with live balance halts NAV
- **Severity**: Medium
- **Component**: `contracts/vaults/dstake/DStakeRouterV2.sol:1481-1523`, `contracts/vaults/dstake/DStakeCollateralVaultV2.sol:73-90`
- **Impact**: `removeVault`/`removeVaultConfig` delete the adapter mapping even if the collateral vault still holds that strategy’s shares. The share stays listed as supported but now lacks an adapter, so `totalValueInDStable` and downstream valuations revert with `AdapterValuationUnavailable`, freezing deposits/withdrawals while the remaining balance becomes unreachable until governance re-adds the config.

### 6. maxWithdraw publishes capacity the active vault cannot honor
- **Severity**: High
- **Component**: `contracts/vaults/dstake/DStakeRouterV2.sol:271-304`, `:397-454`, `:1190-1199`
- **Impact**: `maxWithdraw`/`maxRedeem` advertise the largest single-vault balance via `_maxSingleVaultWithdraw`, but when no vault is over target the withdrawal selector falls back to the first active vault. If that vault has less than the advertised capacity (e.g., target zero but still active with dust), `handleWithdraw` reverts with `NoLiquidityAvailable`. Integrators that respect ERC4626 limits still face withdrawal DoS despite staying within the published bound.
- **Reproduction**: Configure two active vaults where the first holds dust but the second holds liquidity; observe `maxWithdraw` returning the larger second-vault balance, then call `withdraw` within that limit—`_selectVaultForWithdrawal` picks the dust-heavy first vault and `_withdrawFromVaultAtomically` reverts with `NoLiquidityAvailable`.

### 7. Surplus sweep ignores adapter slippage checks
- **Severity**: Medium
- **Component**: `contracts/vaults/dstake/DStakeRouterV2.sol:980-999`
- **Impact**: `sweepSurplus` pushes router-held dStable into the default adapter without previewing or checking the minted share amount. If the adapter returns fewer shares than expected (fees, rounding, or malicious behaviour), the router still burns the dStable with no revert, silently eroding accrued fees and diluting holders.

### 8. Rebalance adapters can zero out collateral
- **Severity**: High
- **Component**: `contracts/vaults/dstake/DStakeRouterV2.sol:790-903`
- **Impact**: `_rebalanceStrategiesByShares` and the external-liquidity variant trust adapter-reported `resultingToShareAmount` without checking the collateral vault balance delta. A malicious or degraded adapter can claim success, causing the router to burn source shares and leave the destination vault empty.
- **Reproduction**: Install a malicious adapter for the destination share, then invoke `rebalanceStrategiesByShares`; the router withdraws real assets, approves the adapter, and accepts its forged share report, leaving the system without the transferred collateral while the adapter keeps the funds.

### 9. Shortfall cap hides new deficits once underwater
- **Severity**: Critical
- **Component**: `contracts/vaults/dstake/DStakeRouterV2.sol:750-757`, `contracts/vaults/dstake/DStakeTokenV2.sol:357-367`
- **Impact**: `recordShortfall` caps debt at `totalManagedAssets`. Once the system is fully underwater, further losses revert instead of being tracked. After partial recapitalization the token reports a positive NAV, letting exiting users drain fresh liquidity while legacy liabilities remain unpaid.
- **Reproduction**: Drive total managed assets down (e.g., to 20) while liabilities are 80, then call `setSettlementShortfall(80)`—it reverts because `recordShortfall` refuses values above assets; deposit fresh capital and observe that existing holders can now redeem shares against that recapitalization even though 60 of losses remain unrecorded.

### 10. migrateCore can orphan router permissions and lock withdrawals
- **Severity**: Medium
- **Component**: `contracts/vaults/dstake/DStakeTokenV2.sol:371-389`, `contracts/vaults/dstake/DStakeCollateralVaultV2.sol:103-155`
- **Impact**: `migrateCore` only checks the new router’s token/collateral pairing. If governance calls it before `DStakeCollateralVaultV2.setRouter`, the updated router lacks `ROUTER_ROLE`, so every withdrawal reverts with `AccessControlUnauthorizedAccount` until a second transaction fixes the grant.

### 11. Router migration wipes recorded shortfall
- **Severity**: Critical
- **Component**: `contracts/vaults/dstake/DStakeTokenV2.sol:357-389`, `contracts/vaults/dstake/DStakeRouterV2.sol:732-758`
- **Impact**: `migrateCore` installs a fresh router without copying `settlementShortfall`. `totalAssets()` drops the liability instantly, so anyone withdrawing before governance re-records it can drain recapitalized funds that should cover past losses.
- **Reproduction**: With a recorded shortfall, deploy a new router and call `migrateCore`; before governance re-runs `setSettlementShortfall`, call `redeem` to withdraw assets at the inflated NAV, draining the funds earmarked to cover the deficit.

### 12. reinvestFees leaks shortfall collateral via incentives
- **Severity**: High
- **Component**: `contracts/vaults/dstake/DStakeRouterV2.sol:696-738`
- **Impact**: `reinvestFees` pays caller incentives and redeploys fees even when `settlementShortfall` is non-zero. Keepers can repeatedly collect up to the 20% incentive from assets meant to plug the shortfall, worsening insolvency and delaying recovery for legacy holders.
- **Reproduction**: After recording a shortfall, transfer fee revenue to the router and call `reinvestFees`; observe the incentive payment to the caller while `currentShortfall()` remains unchanged, proving that recovery capital leaks to opportunistic keepers.

## Acknowledged (Won't Fix)

*(none this cycle)*

## Open Questions

1. Should positive slippage be retained as router surplus (to be reinvested) instead of being paid out to the caller?
2. Do adapter rounding behaviours warrant additional guardrails so small precision gains cannot consistently exploit the slippage leak above?
