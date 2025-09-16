# dSTAKE Core Contract Security Audit Findings

**Audit Date**: 2025-09-15
**Auditor**: Claude Code Security Audit
**Contracts Audited**:
- `contracts/vaults/dstake/DStakeToken.sol`
- `contracts/vaults/dstake/DStakeCollateralVault.sol`
- `contracts/vaults/dstake/interfaces/IDStakeCollateralVault.sol`

## Summary

This audit focused on the core dSTAKE contracts implementing an ERC4626-based vault system with withdrawal fees and external adapter integrations. The audit identified **5 Critical**, **3 High**, **4 Medium**, and **2 Low** severity vulnerabilities across access control, ERC4626 implementation, and oracle dependency issues.

---

## [DSTAKE-CRITICAL-001] First Depositor Inflation Attack Vector
**Contract**: DStakeToken.sol:111
**Function**: totalAssets()
**Severity**: Critical

**Description**: The protocol acknowledges but does not mitigate the first depositor inflation attack where an attacker can manipulate share prices by donating assets.

**Impact**: First depositor after total vault drainage can receive accumulated yield from dust amounts, potentially draining future depositors' funds through share price manipulation.

**PoC**:
```solidity
// 1. All shares are redeemed, leaving ~1 wei in vault
// 2. Dust accumulates yield, increasing totalAssets()
// 3. First new depositor gets inflated share count
// 4. Subsequent depositors lose value to the first depositor
```

**Fix**: Implement minimum share requirement and burn initial shares to prevent inflation attacks, or enforce minimum deposit amounts that exceed potential accumulated dust value.

---

## [DSTAKE-CRITICAL-002] Router/CollateralVault Uninitialized State Allows Asset Theft
**Contract**: DStakeToken.sol:127-128
**Function**: _deposit()
**Severity**: Critical

**Description**: Deposits can proceed with uninitialized router/collateralVault, causing assets to be transferred but not properly processed.

**Impact**: User assets can be locked or stolen if admin sets zero addresses after initialization.

**PoC**:
```solidity
// Admin calls setRouter(address(0)) or setCollateralVault(address(0))
// User calls deposit() - assets transferred but revert on line 138
// Assets stuck in DStakeToken with shares minted
```

**Fix**: Add checks in setRouter/setCollateralVault to prevent setting zero addresses, or add reentrancy protection and better state validation.

---

## [DSTAKE-CRITICAL-003] Withdrawal Fee Bypass via Share Transfer
**Contract**: DStakeToken.sol:184-196
**Function**: redeem()
**Severity**: Critical

**Description**: Users can bypass withdrawal fees by transferring shares to another address and redeeming from there.

**Impact**: Complete bypass of withdrawal fees, protocol revenue loss.

**PoC**:
```solidity
// User with large position transfers shares to fresh address
// Fresh address calls redeem() - no fee history
// Original user avoids withdrawal fees
```

**Fix**: Implement per-share fee tracking or apply withdrawal fees consistently regardless of share holder history.

---

## [DSTAKE-CRITICAL-004] Adapter Oracle Manipulation via Asset Dusting
**Contract**: DStakeCollateralVault.sol:79-83
**Function**: totalValueInDStable()
**Severity**: Critical

**Description**: Missing adapter silently skips asset valuation, allowing manipulation through adapter deregistration after dusting vault with worthless tokens.

**Impact**: Total vault value can be manipulated by adding worthless tokens and deregistering their adapters, affecting share price calculations.

**PoC**:
```solidity
// Attacker dusts vault with worthless ERC20 tokens
// Admin removes adapter for those tokens
// totalValueInDStable() skips worthless tokens (lines 79-83)
// Share price appears higher than actual backing
```

**Fix**: Revert when adapters are missing for non-zero balance assets, or implement emergency adapter bypass with proper access controls.

---

## [DSTAKE-CRITICAL-005] Rounding Errors Favor Users Over Vault
**Contract**: DStakeToken.sol:241-252
**Function**: previewWithdraw(), previewRedeem()
**Severity**: Critical

**Description**: Preview functions use unfavorable rounding for the vault, potentially allowing value extraction through repeated small withdrawals.

**Impact**: Vault can be drained through rounding error exploitation in preview calculations.

**PoC**:
```solidity
// User repeatedly deposits and withdraws small amounts
// Rounding errors accumulate in user's favor
// Eventually drains vault reserves
```

**Fix**: Implement proper rounding that always favors the vault for withdrawal operations and users for deposit operations.

---

## [DSTAKE-HIGH-001] Unlimited Admin Privileges Without Timelock
**Contract**: DStakeToken.sol:261-289 & DStakeCollateralVault.sol:145-156
**Function**: setRouter(), setCollateralVault(), setWithdrawalFee()
**Severity**: High

**Description**: Admin functions lack timelock protection, allowing immediate changes to critical parameters.

**Impact**: Admin can immediately change router/vault addresses or withdrawal fees, potentially for malicious purposes.

**PoC**:
```solidity
// Malicious admin sets router to malicious contract
// All deposits/withdrawals now go through malicious router
// Assets can be stolen or redirected
```

**Fix**: Implement timelock for all admin functions affecting user funds and system security.

---

## [DSTAKE-HIGH-002] Reentrancy Risk in CollateralVault Asset Operations
**Contract**: DStakeCollateralVault.sol:103-105
**Function**: sendAsset()
**Severity**: High

**Description**: External token transfers can trigger reentrancy attacks through malicious token contracts.

**Impact**: Reentrancy can allow manipulation of vault state during asset transfers.

**PoC**:
```solidity
// Malicious ERC20 token calls back into vault during safeTransfer
// State manipulation during transfer execution
// Double spending or accounting errors
```

**Fix**: Add ReentrancyGuard to all external token interaction functions, particularly sendAsset().

---

## [DSTAKE-HIGH-003] Missing Asset Balance Validation in Adapter Calls
**Contract**: DStakeCollateralVault.sol:86-89
**Function**: totalValueInDStable()
**Severity**: High

**Description**: No validation that adapter conversions match actual token balances, allowing oracle manipulation.

**Impact**: Stale or manipulated adapter prices can misrepresent vault value, affecting share pricing.

**PoC**:
```solidity
// Malicious adapter returns inflated valuations
// totalValueInDStable() trusts adapter without validation
// Share price becomes disconnected from real asset values
```

**Fix**: Implement adapter result validation, price staleness checks, and maximum deviation limits.

---

## [DSTAKE-MEDIUM-001] Fee Calculation Precision Loss
**Contract**: DStakeToken.sol:219, SupportsWithdrawalFee.sol:56-57
**Function**: _calculateWithdrawalFee()
**Severity**: Medium

**Description**: Withdrawal fee calculation may lose precision for small amounts due to basis point divisions.

**Impact**: Fee calculation inaccuracies, potential for dust amount fee bypass.

**PoC**:
```solidity
// Very small withdrawal amounts (< 10000 wei) may result in zero fees
// User can split large withdrawals into many small ones to reduce fees
```

**Fix**: Implement minimum fee amounts or improve precision in fee calculations.

---

## [DSTAKE-MEDIUM-002] Asset Removal DoS via Balance Manipulation
**Contract**: DStakeCollateralVault.sol:126-135
**Function**: removeSupportedAsset()
**Severity**: Medium

**Description**: While the explicit balance check was removed, the comment indicates previous DoS concerns. Anyone can still dust the vault.

**Impact**: Griefing attacks by dusting vault with removed assets, affecting gas costs and complexity.

**PoC**:
```solidity
// Attacker sends 1 wei of asset before removal
// Asset remains in vault with no adapter
// totalValueInDStable() must handle missing adapter case
```

**Fix**: Implement asset cleanup procedures or minimum balance thresholds for supported assets.

---

## [DSTAKE-MEDIUM-003] ETH Rescue Function Gas Limit DoS
**Contract**: DStakeCollateralVault.sol:213-220
**Function**: rescueETH()
**Severity**: Medium

**Description**: ETH rescue uses call with no gas limit, vulnerable to gas griefing attacks from recipient contracts.

**Impact**: Rescue operations can fail due to gas exhaustion from malicious recipient contracts.

**PoC**:
```solidity
// Malicious recipient contract uses excessive gas in receive()
// rescueETH() fails due to out-of-gas condition
// Legitimate rescue operations blocked
```

**Fix**: Set reasonable gas limits for ETH rescue operations or use pull-payment pattern.

---

## [DSTAKE-MEDIUM-004] Missing Event Emissions for Critical State Changes
**Contract**: DStakeToken.sol:127-138
**Function**: _deposit(), _withdraw()
**Severity**: Medium

**Description**: Router/vault initialization state changes are not tracked through events.

**Impact**: Difficult to monitor when critical dependencies become available, affecting transparency.

**PoC**:
```solidity
// Router gets set after token deployment
// No event indicates when deposits become possible
// Users may attempt deposits before router is ready
```

**Fix**: Add events for router/vault address changes and initialization status.

---

## [DSTAKE-LOW-001] Inconsistent Zero Address Checks
**Contract**: DStakeToken.sol:64-66
**Function**: initialize()
**Severity**: Low

**Description**: Some parameters checked for zero address, others like router/vault are not checked in constructor.

**Impact**: Inconsistent validation may lead to deployment with partially invalid configuration.

**PoC**:
```solidity
// Contract deployed with zero router but non-zero admin
// Partial functionality available, confusing state
```

**Fix**: Implement consistent zero address validation for all critical addresses.

---

## [DSTAKE-LOW-002] Unused Immutable Variables Access Pattern
**Contract**: DStakeCollateralVault.sol:48-49
**Function**: Constructor
**Severity**: Low

**Description**: Immutable variables dStakeToken and dStable are set but dStakeToken is never used internally.

**Impact**: Gas optimization opportunity missed, potential code confusion.

**PoC**:
```solidity
// dStakeToken immutable variable serves no internal purpose
// Could be removed to save deployment gas
```

**Fix**: Remove unused immutable variables or document their intended external usage.

---

## Recommendations

### Critical Priority
1. Implement minimum share burns to prevent inflation attacks
2. Add comprehensive zero address validation in admin functions
3. Fix rounding directions to always favor the vault
4. Implement adapter validation and failure handling

### High Priority
1. Add timelock protection for all admin functions
2. Implement reentrancy protection for asset transfers
3. Add oracle staleness and deviation checks

### Medium Priority
1. Improve withdrawal fee precision and minimum amounts
2. Implement proper asset cleanup procedures
3. Add gas limits for ETH rescue operations

### Low Priority
1. Standardize zero address validation
2. Remove unused variables and optimize gas usage

---

**Total Findings**: 14 (5 Critical, 3 High, 4 Medium, 2 Low)
**Risk Assessment**: **HIGH** - Multiple critical vulnerabilities allow asset theft and manipulation