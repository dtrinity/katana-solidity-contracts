# Morpho Security Remediation Plan

## Immediate Actions (CRITICAL - Do Not Deploy)

### 1. Fix Basis Points Validation
**File**: `contracts/vaults/dstake/DStakeRouterMorpho.sol:298`
```solidity
// BEFORE (WRONG):
if (totalTargetBps != BasisPointConstants.ONE_PERCENT_BPS) {

// AFTER (CORRECT):
if (totalTargetBps != BasisPointConstants.ONE_HUNDRED_PERCENT_BPS) {
```

### 2. Fix Merkle Proof Bypass
**File**: `contracts/vaults/dstake/rewards/DStakeRewardManagerMetaMorpho.sol`
```solidity
// Add verification that rewards were sent to collateral vault
function claimRewardsFromURD(ClaimData[] calldata claimData) external {
    for (uint256 i = 0; i < claimData.length; i++) {
        uint256 balanceBefore = IERC20(claimData[i].rewardToken).balanceOf(dStakeCollateralVault);
        
        urd.claim(
            dStakeCollateralVault,
            claimData[i].rewardToken,
            claimData[i].claimableAmount,
            claimData[i].proof
        );
        
        uint256 balanceAfter = IERC20(claimData[i].rewardToken).balanceOf(dStakeCollateralVault);
        require(balanceAfter >= balanceBefore + claimData[i].claimableAmount, "Rewards not received");
    }
}
```

### 3. Fix ETH Transfer Vulnerability
**File**: `contracts/vaults/dstake/adapters/MetaMorphoConversionAdapter.sol:290`
```solidity
// Add gas limit to prevent reentrancy
(bool success, ) = msg.sender.call{ value: amount, gas: 30000 }("");
```

## High Priority Fixes (Pre-Mainnet Required)

### 4. Add Division by Zero Protection
**File**: `contracts/vaults/dstake/libraries/AllocationCalculator.sol`
```solidity
function calculateAllocations(...) {
    // Add check before division
    if (totalBalance == 0) {
        return allocations; // Return empty array
    }
    
    for (uint256 i = 0; i < vaultCount; i++) {
        allocations[i] = (vaultBalances[i] * BasisPointConstants.ONE_PERCENT_BPS) / totalBalance;
    }
}
```

### 5. Add Reentrancy Protection
**File**: `contracts/vaults/dstake/DStakeRouterMorpho.sol`
```solidity
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

contract DStakeRouterMorpho is DStakeRouter, ReentrancyGuard {
    function depositToVaults(...) external nonReentrant {
        // existing logic
    }
    
    function withdrawFromVaults(...) external nonReentrant {
        // existing logic
    }
}
```

### 6. Implement Gas Circuit Breaker
**File**: `contracts/vaults/dstake/DStakeRouterMorpho.sol`
```solidity
uint256 private constant MAX_ITERATIONS_PER_TX = 10;

function _getActiveVaultsAndAllocations() internal view returns (...) {
    uint256 iterations = 0;
    for (uint256 i = 0; i < vaultConfigs.length && iterations < MAX_ITERATIONS_PER_TX; i++) {
        if (vaultConfigs[i].isActive && _isVaultHealthy(vaultConfigs[i].vault)) {
            // process vault
            iterations++;
        }
    }
}
```

### 7. Fix Share Return Logic
**File**: `contracts/vaults/dstake/adapters/MetaMorphoConversionAdapter.sol`
```solidity
// Remove the transfer before revert
try metaMorphoVault.redeem(...) returns (uint256 assets) {
    actualAssets = assets;
} catch {
    // Don't transfer shares back, just revert
    revert VaultOperationFailed();
}
```

## Medium Priority Fixes

### 8. Add Integer Overflow Protection
**File**: `contracts/vaults/dstake/libraries/WeightedRandomSelector.sol`
```solidity
// Safe subtraction for weights
weights[i] = targetAllocations[i] > currentAllocations[i] 
    ? targetAllocations[i] - currentAllocations[i]
    : 0;
```

### 9. Add Fee Change Timelock
**File**: `contracts/common/RewardClaimable.sol`
```solidity
uint256 public pendingTreasuryFeeBps;
uint256 public feeChangeTimestamp;
uint256 constant FEE_CHANGE_DELAY = 24 hours;

function setTreasuryFeeBps(uint256 _feeBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
    pendingTreasuryFeeBps = _feeBps;
    feeChangeTimestamp = block.timestamp + FEE_CHANGE_DELAY;
    emit FeeChangeScheduled(_feeBps, feeChangeTimestamp);
}

function executeFeeChange() external {
    require(block.timestamp >= feeChangeTimestamp, "Too early");
    treasuryFeeBps = pendingTreasuryFeeBps;
}
```

### 10. Fix Slippage Rounding
**File**: `contracts/vaults/dstake/adapters/MetaMorphoConversionAdapter.sol`
```solidity
// Use ceiling for user protection
uint256 minShares = expectedShares.mulDiv(
    BasisPointConstants.ONE_HUNDRED_PERCENT_BPS - MAX_SLIPPAGE_BPS,
    BasisPointConstants.ONE_HUNDRED_PERCENT_BPS,
    Math.Rounding.Ceil  // Changed from Floor
);
```

## Implementation Timeline

### Week 1 (Critical)
- [ ] Day 1-2: Fix basis points, Merkle bypass, ETH transfer
- [ ] Day 3-4: Comprehensive testing of critical fixes
- [ ] Day 5: Internal review and validation

### Week 2 (High Priority)
- [ ] Day 1-2: Add reentrancy and zero checks
- [ ] Day 3-4: Implement gas limits and fix share logic
- [ ] Day 5: Integration testing

### Week 3 (Medium Priority)
- [ ] Day 1-2: Add overflow protection and timelocks
- [ ] Day 3-4: Fix rounding and remaining issues
- [ ] Day 5: Full system testing

### Week 4 (Validation)
- [ ] Day 1-2: External security review
- [ ] Day 3-4: Testnet deployment
- [ ] Day 5: Monitoring setup

## Testing Requirements

Create comprehensive test suite covering:
```javascript
describe("Security Fixes", () => {
    it("should handle zero total balance gracefully");
    it("should prevent reentrancy attacks");
    it("should enforce gas limits on vault operations");
    it("should validate Merkle proof claims correctly");
    it("should handle ETH transfers safely");
    it("should prevent integer underflows in weights");
    it("should enforce fee change delays");
    it("should calculate slippage correctly");
});
```

## Deployment Readiness Criteria

- [ ] All CRITICAL issues resolved and tested
- [ ] All HIGH issues resolved and tested  
- [ ] Security test suite passing 100%
- [ ] Gas profiling completed
- [ ] Testnet deployment successful
- [ ] Monitoring alerts configured
- [ ] Emergency response procedures documented
- [ ] Multi-sig controls implemented
- [ ] Audit report signed off

## Post-Deployment Monitoring

1. **Real-time Alerts**:
   - Unusual gas consumption
   - Failed transactions patterns
   - Large value movements
   - Access control changes

2. **Daily Reviews**:
   - Vault allocation distributions
   - Reward claim patterns
   - Emergency function usage
   - Gas usage trends

3. **Weekly Audits**:
   - Merkle root updates
   - URD claim totals
   - Treasury fee collections
   - System health metrics