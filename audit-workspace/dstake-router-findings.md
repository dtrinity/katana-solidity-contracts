# dSTAKE Router Security Audit Findings

## Executive Summary

This audit examined the dSTAKE router contracts integrating with Morpho markets, focusing on critical security vulnerabilities in the multi-vault routing system. The audit identified **3 Critical**, **4 High**, **6 Medium**, and **5 Low** severity findings across the examined contracts.

### Key Areas of Concern

1. **Exchange Rate Manipulation Vulnerabilities** - Critical risks in collateral exchange mechanisms
2. **Withdrawal Plan Calculation Issues** - Complex edge cases leading to potential fund loss
3. **Morpho Integration Risks** - External protocol dependencies and failure modes
4. **Deterministic Vault Selection Manipulation** - Potential griefing through allocation gaming
5. **Rounding Errors in Multi-Vault Operations** - Precision loss in complex calculations

---

## CRITICAL FINDINGS

## [DSTAKE-ROUTER-CRITICAL-01] Exchange Rate Manipulation via Morpho Vault Share Inflation
**Contract**: DStakeRouterMorpho.sol:260-294
**Function**: rebalanceStrategiesByValue()
**Severity**: Critical

**Description**: The collateral exchange function uses `IERC4626.previewWithdraw()` without considering potential vault share inflation attacks that could manipulate exchange rates.

**Impact**: Attacker could inflate strategy shares by donating underlying assets, causing dramatic changes in exchange rates and allowing extraction of value during collateral exchanges.

**PoC**:
```solidity
// Attacker inflates strategy shares by donating assets directly to Morpho vault
// This changes the exchange rate dramatically
vault.asset().transfer(vault, LARGE_AMOUNT);

// Now when router calculates required shares for withdrawal:
uint256 requiredShares = IERC4626(fromVault).previewWithdraw(amount); // Very low due to inflation

// Attacker profits from the exchange at manipulated rate
router.rebalanceStrategiesByValue(fromVault, toVault, amount, minStrategyShareAmount);
```

**Fix**: Implement exchange rate bounds checking and use time-weighted average rates or oracle-based validation for large exchanges.

---

## [DSTAKE-ROUTER-CRITICAL-02] Insufficient Withdrawal Validation Allows Fund Drainage
**Contract**: DStakeRouterMorpho.sol:880-1085
**Function**: _calculateWithdrawalAmounts()
**Severity**: Critical

**Description**: Complex withdrawal calculation logic has edge cases where `totalUsed < totalAmount` but system continues, potentially allowing withdrawals beyond available liquidity.

**Impact**: Users could withdraw more than their proportional share by exploiting calculation edge cases, draining vault funds.

**PoC**:
```solidity
// Setup scenario where selected vaults have limited liquidity
// But calculation allows withdrawal proceeding with totalUsed < totalAmount
// Lines 1065-1082 have insufficient validation
if (totalUsed < totalAmount) {
    // Check total liquidity but still allows partial fulfillment
    // Missing validation that user gets exactly what they requested
}
```

**Fix**: Add strict validation that `totalUsed == totalAmount` or revert. Implement proper shortfall handling with explicit user consent.

---

## [DSTAKE-ROUTER-CRITICAL-03] Morpho Adapter Slippage Bypass via Malicious Vault
**Contract**: MetaMorphoConversionAdapter.sol:109-164
**Function**: convertToVaultAsset()
**Severity**: Critical

**Description**: The adapter's slippage protection can be bypassed if the MetaMorpho vault is malicious or compromised, allowing unlimited value extraction.

**Impact**: Complete loss of funds if MetaMorpho vault is compromised and returns manipulated preview values while executing different actual exchanges.

**PoC**:
```solidity
// Malicious vault returns optimistic preview
function previewDeposit(uint256) external pure returns (uint256) {
    return LARGE_AMOUNT; // Fake high return
}

// But actually mints much less during deposit
function deposit(uint256 assets, address receiver) external returns (uint256) {
    return SMALL_AMOUNT; // Actual low return, value extracted
}
```

**Fix**: Implement additional validation layers including post-execution balance checks and oracle-based slippage validation for critical operations.

---

## HIGH SEVERITY FINDINGS

## [DSTAKE-ROUTER-HIGH-01] Deterministic Vault Selection Manipulation
**Contract**: DeterministicVaultSelector.sol:262-269
**Function**: _selectTopVaultsByDelta()
**Severity**: High

**Description**: The deterministic selection algorithm uses original index for tie-breaking, allowing manipulation of vault selection order through strategic allocation timing.

**Impact**: Attackers could front-run operations and manipulate vault allocations to force selection of specific vaults, potentially affecting yield or creating MEV opportunities.

**PoC**:
```solidity
// Attacker monitors mempool for large deposits
// Front-runs with small deposit to specific vault to change allocation deltas
// This changes the deterministic selection outcome
// Tie-breaking on line 264 uses originalIndex, making this predictable
```

**Fix**: Use cryptographically secure tie-breaking mechanism or implement commit-reveal scheme for large operations.

---

## [DSTAKE-ROUTER-HIGH-02] Withdrawal Plan Insufficient Liquidity Check
**Contract**: DStakeRouterMorpho.sol:888-906
**Function**: _calculateWithdrawalAmounts()
**Severity**: High

**Description**: The function calculates available liquidity using `previewRedeem()` but doesn't account for vault-specific withdrawal limitations or temporary pauses.

**Impact**: Withdrawal calculations may succeed but actual execution fails, causing DoS or forcing users into unfavorable partial withdrawals.

**PoC**:
```solidity
// Vault reports liquidity via previewRedeem
uint256 availableLiquidity = vault.previewRedeem(shares);

// But vault is actually paused or has withdrawal limits
// Calculation proceeds but execution will fail
vault.redeem(shares, receiver, owner); // Reverts
```

**Fix**: Add vault health checks that verify actual withdrawal capability, not just balance-based calculations.

---

## [DSTAKE-ROUTER-HIGH-03] Role Escalation in Router Configuration
**Contract**: DStakeRouterMorpho.sol:117-120
**Function**: constructor()
**Severity**: High

**Description**: Constructor grants multiple critical roles to `msg.sender` without validation, and roles can be escalated through adapter management.

**Impact**: Deployment with wrong sender or compromised deployer key leads to permanent admin control loss or malicious role escalation.

**PoC**:
```solidity
// Deployer gets VAULT_MANAGER_ROLE and PAUSER_ROLE
_grantRole(VAULT_MANAGER_ROLE, msg.sender);
_grantRole(PAUSER_ROLE, msg.sender);

// Can add malicious adapters or pause system at will
// No mechanism to revoke if deployer key is compromised
```

**Fix**: Implement multi-sig deployment process and time-delayed role transfers with explicit governance approval.

---

## [DSTAKE-ROUTER-HIGH-04] Adapter Asset Mismatch in Multi-Vault Operations
**Contract**: DStakeRouterMorpho.sol:778-783
**Function**: _executeMultiVaultDeposits()
**Severity**: High

**Description**: Asset mismatch check only validates expected vs actual strategy shares but doesn't validate adapter configuration consistency across operations.

**Impact**: Inconsistent adapter configurations could lead to funds being sent to wrong vaults or lost during multi-vault operations.

**PoC**:
```solidity
// Adapter configured for vaultA but points to vaultB
if (strategyShareExpected != selectedVaults[i]) {
    revert AdapterAssetMismatch(...); // Checks expected vs vault
}
// But doesn't check if adapter.strategyShare() == expectedVault
// Could route funds to wrong destination
```

**Fix**: Add comprehensive adapter-vault consistency validation in multi-vault operations.

---

## MEDIUM SEVERITY FINDINGS

## [DSTAKE-ROUTER-MEDIUM-01] Allocation Calculator Rounding Accumulation
**Contract**: AllocationCalculator.sol:135-164
**Function**: splitAmountProportionally()
**Severity**: Medium

**Description**: Repeated proportional splits can accumulate rounding errors, especially in high-frequency operations or with small amounts.

**Impact**: Over time, rounding errors could lead to allocation drift and unfair distribution of funds among vaults.

**PoC**:
```solidity
// Small amounts with many vaults lead to precision loss
uint256 amount = 100;  // Small amount
uint256[] weights = [1, 1, 1]; // Even distribution
// Each vault gets 33, remainder is 1
// Repeatedly calling this biases toward first vaults
```

**Fix**: Implement precise decimal arithmetic library or accumulate remainders in separate tracking mechanism.

---

## [DSTAKE-ROUTER-MEDIUM-02] Emergency Pause Race Condition
**Contract**: DStakeRouterMorpho.sol:426-435
**Function**: emergencyPauseVault()
**Severity**: Medium

**Description**: Emergency pause only sets `isActive = false` but doesn't prevent ongoing operations that already passed the health check.

**Impact**: Emergency pause may not immediately stop problematic operations, allowing potential exploitation to continue.

**PoC**:
```solidity
// Transaction 1: Passes health check, starts deposit process
// Transaction 2: Emergency pause triggered
// Transaction 1: Completes deposit to now-paused vault
```

**Fix**: Implement immediate circuit breaker pattern with global operation pause capabilities.

---

## [DSTAKE-ROUTER-MEDIUM-03] Vault Health Check Temporal Inconsistency
**Contract**: DStakeRouterMorpho.sol:721-755
**Function**: _isVaultHealthyForWithdrawals()
**Severity**: Medium

**Description**: Health checks are performed separately from actual operations, creating temporal gap where vault state could change.

**Impact**: Operations could proceed on stale health information, leading to failed transactions or suboptimal routing decisions.

**PoC**:
```solidity
// Health check passes
bool healthy = _isVaultHealthyForWithdrawals(vault);

// Vault state changes (external transaction)
// Actual operation fails despite health check
vault.redeem(...); // Reverts due to changed state
```

**Fix**: Implement atomic health-check-and-execute pattern or add retry mechanisms with fresh health validation.

---

## [DSTAKE-ROUTER-MEDIUM-04] Maximum Vault Count Bypass
**Contract**: DStakeRouterMorpho.sol:470-484
**Function**: setMaxVaultCount()
**Severity**: Medium

**Description**: The function prevents setting max vault count below current vault count but doesn't handle the case where vaults are added simultaneously.

**Impact**: Race conditions could allow vault count to exceed intended maximum, leading to gas limit issues in operations.

**PoC**:
```solidity
// Current vaults: 9, maxVaultCount: 10
// Transaction 1: Add vault (vaults become 10)
// Transaction 2: setMaxVaultCount(8) fails
// Transaction 1: Succeeds, now 10 vaults with max 10
// But if Transaction 2 was setMaxVaultCount(9), it would succeed
// Creating inconsistent state
```

**Fix**: Add atomic vault count management with proper synchronization mechanisms.

---

## [DSTAKE-ROUTER-MEDIUM-05] Surplus Handling in Multi-Vault Withdrawals
**Contract**: DStakeRouterMorpho.sol:862-867
**Function**: _executeMultiVaultWithdrawals()
**Severity**: Medium

**Description**: Surplus dStable is retained in router contract but lacks proper accounting or redistribution mechanism.

**Impact**: Accumulated surplus could represent user funds not properly returned, creating accounting discrepancies.

**PoC**:
```solidity
// Multiple withdrawals each leave small surplus
uint256 surplus = IERC20(dStable).balanceOf(address(this));
if (surplus > 0) {
    emit SurplusHeld(surplus); // Only emitted, not redistributed
}
// Surplus accumulates with no clear ownership or distribution
```

**Fix**: Implement proper surplus accounting and redistribution mechanism to vault participants.

---

## [DSTAKE-ROUTER-MEDIUM-06] External Call Failure Handling
**Contract**: DStakeRouterMorpho.sol:1128
**Function**: _clearVaultConfigs()
**Severity**: Medium

**Description**: The function uses empty catch blocks when calling `removeAdapter()`, potentially masking important failure conditions.

**Impact**: Silent failures in adapter removal could leave system in inconsistent state with dangling references.

**PoC**:
```solidity
try this.removeAdapter(vault) {} catch {}
// Failure is silently ignored
// Adapter mapping remains but vault config is cleared
// Inconsistent state between router and parent contract
```

**Fix**: Implement proper error handling and logging for external call failures.

---

## LOW SEVERITY FINDINGS

## [DSTAKE-ROUTER-LOW-01] Inefficient Array Operations
**Contract**: DStakeRouterMorpho.sol:159-171
**Function**: deposit()
**Severity**: Low

**Description**: Nested loops for extracting allocation data could be optimized with mapping-based lookups.

**Impact**: Higher gas costs for deposits, especially with many vaults configured.

**Fix**: Pre-compute allocation mappings or use more efficient data structures.

---

## [DSTAKE-ROUTER-LOW-02] Missing Event Parameter Validation
**Contract**: DStakeRouterMorpho.sol:195
**Function**: deposit()
**Severity**: Low

**Description**: Events use randomSeed parameter hardcoded to 0, reducing event informativeness.

**Impact**: Reduced observability and potential confusion in off-chain monitoring systems.

**Fix**: Either remove unused parameter or implement proper random seed generation.

---

## [DSTAKE-ROUTER-LOW-03] Inconsistent Error Messages
**Contract**: DStakeRouterMorpho.sol:345
**Function**: updateVaultConfig()
**Severity**: Low

**Description**: Function uses `AdapterNotFound` error for vault not found condition, creating semantic confusion.

**Impact**: Debugging difficulty and potential confusion in error handling.

**Fix**: Create specific `VaultNotFound` error type for clarity.

---

## [DSTAKE-ROUTER-LOW-04] Redundant Calculations in Allocation Calculator
**Contract**: AllocationCalculator.sol:194-201
**Function**: distributeRemainder()
**Severity**: Low

**Description**: Total weight calculation is repeated unnecessarily in remainder distribution.

**Impact**: Minor gas inefficiency in allocation calculations.

**Fix**: Cache total weight calculation result.

---

## [DSTAKE-ROUTER-LOW-05] Unbounded Loop in Vault Selection
**Contract**: DeterministicVaultSelector.sol:255-277
**Function**: _selectTopVaultsByDelta()
**Severity**: Low

**Description**: Nested loops with O(k*n) complexity could cause gas issues with many vaults.

**Impact**: Potential gas limit issues with large vault counts, though mitigated by maxVaultCount.

**Fix**: Implement gas-efficient sorting algorithm or add explicit gas limit checks.

---

## Recommendations

### Immediate Actions Required
1. **Fix Critical Issues**: Address exchange rate manipulation and withdrawal validation issues immediately
2. **Implement Rate Limiting**: Add time delays and limits on large collateral exchanges
3. **Enhance Slippage Protection**: Implement multi-layer validation for Morpho integrations
4. **Add Circuit Breakers**: Implement emergency stop mechanisms for critical operations

### Medium-Term Improvements
1. **Upgrade Role Management**: Implement multi-signature governance for critical roles
2. **Add Comprehensive Monitoring**: Implement real-time vault health monitoring
3. **Optimize Gas Usage**: Improve efficiency of multi-vault operations
4. **Enhanced Testing**: Add property-based tests for edge cases and invariant validation

### Architecture Considerations
1. **Consider Upgradeability**: Current non-upgradeable design limits fix deployment
2. **Implement Gradual Rollout**: Use progressive limits for new vault integrations
3. **Add Oracle Integration**: Include price feed validation for cross-vault operations
4. **Documentation**: Improve inline documentation for complex calculation logic

---

*This audit was conducted on the dSTAKE Router smart contracts with focus on Morpho integration security. All findings should be validated through comprehensive testing before deployment.*