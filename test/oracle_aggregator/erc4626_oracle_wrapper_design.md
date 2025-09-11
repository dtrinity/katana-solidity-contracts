# ERC4626 Oracle Wrapper Technical Plan (Simplified)

## Overview

This document outlines the technical design for a simplified `ERC4626OracleWrapper` that integrates any ERC-4626 vault into the existing `OracleAggregator.sol` system. The wrapper provides secure price feeds for ERC-4626 vaults with built-in protection against common DeFi attacks while maintaining full compatibility with the immutable `OracleAggregator` architecture.

## Design Philosophy

**Simplicity over Complexity**: Rather than implementing complex TWAP mechanisms that require external maintenance, this design relies on proven protection mechanisms that are self-contained and require no operational overhead.

## Architecture

### Core Components

1. **ERC4626OracleWrapper**: Main oracle wrapper implementing `IOracleWrapper`
2. **Bounds Checking**: Price deviation detection using stored baseline prices
3. **Security Layer**: Minimum share supply requirements and health validation
4. **Governance Interface**: Functions for managing vault configurations and price baselines

### Key Features

- **Pure View Interface**: Fully compatible with immutable `OracleAggregator` 
- **No External Dependencies**: Self-contained with no maintenance requirements
- **Multi-layered Security**: Defense in depth against manipulation
- **Gas Efficient**: Minimal storage and computation overhead
- **Generic Design**: Works with any compliant ERC-4626 vault

## Security Model

### Attack Vector Analysis

| Attack Type | Protection Mechanism | Implementation |
|-------------|---------------------|----------------|
| **Donation Attack** | Minimum Share Supply | Reject pricing if `totalSupply() < minShareSupply` |
| **Flash Loan Manipulation** | Bounds Checking | Compare against `lastValidPrice`, fallback if >5% deviation |
| **Gradual Manipulation** | Governance Oversight | Manual review and updates of `lastValidPrice` baselines |
| **Vault Draining** | Health Checks | Reject if `totalAssets() == 0` or vault paused |

### Multi-Layer Defense

1. **Vault Health Validation**
   - Check if vault is active and not paused
   - Verify minimum share supply threshold
   - Ensure vault has non-zero assets

2. **Price Deviation Protection**
   - Compare current price against stored `lastValidPrice`
   - If deviation >5%, return `lastValidPrice` instead
   - Governance can update baselines when appropriate

3. **ERC-4626 Compliance**
   - Leverage standard's built-in exchange rate calculation
   - Use `convertToAssets(BASE_CURRENCY_UNIT)` for consistent pricing

## Technical Implementation

### Core Data Structures

```solidity
struct VaultConfig {
    bool isActive;              // Whether vault is enabled for pricing
    uint256 minShareSupply;     // Minimum shares to prevent donation attacks  
    uint256 lastValidPrice;     // Baseline price for deviation checking
    address underlyingAsset;    // The vault's underlying asset
    bool isPaused;              // Emergency pause state
}
```

### Main Oracle Function

```solidity
function getPriceInfo(address vault) public view override returns (uint256 price, bool isAlive) {
    VaultConfig storage config = vaultConfigs[vault];
    
    // Health checks
    if (!_validateVaultHealth(vault)) {
        return (0, false);
    }

    // Get current exchange rate
    uint256 currentPrice = IERC4626(vault).convertToAssets(BASE_CURRENCY_UNIT);
    
    // Bounds checking for manipulation resistance
    if (config.lastValidPrice > 0 && _priceDeviatesSignificantly(currentPrice, config.lastValidPrice)) {
        // Suspicious deviation - use stored safe price
        return (config.lastValidPrice, true);
    }

    // Current price looks reasonable
    return (currentPrice, true);
}
```

### Security Validation

```solidity
function _validateVaultHealth(address vault) internal view returns (bool) {
    VaultConfig storage config = vaultConfigs[vault];
    
    // Basic configuration checks
    if (!config.isActive || config.isPaused) return false;
    
    // Liquidity requirements (anti-donation attack)
    if (IERC4626(vault).totalSupply() < config.minShareSupply) return false;
    
    // Asset availability check
    if (IERC4626(vault).totalAssets() == 0) return false;
    
    return true;
}

function _priceDeviatesSignificantly(uint256 newPrice, uint256 baselinePrice) internal view returns (bool) {
    if (baselinePrice == 0) return false;
    
    uint256 diff = newPrice > baselinePrice ? newPrice - baselinePrice : baselinePrice - newPrice;
    return diff * 10000 > baselinePrice * maxDeviation; // Default: 5% = 500 basis points
}
```

## Operational Model

### Vault Onboarding Process

1. **Governance adds vault** via `addVault(vault, minShares, underlyingAsset)`
2. **Initial price** set automatically as `convertToAssets(BASE_CURRENCY_UNIT)`
3. **Minimum shares** configured based on vault size and security requirements
4. **Oracle becomes active** immediately - no warmup period needed

### Ongoing Operations

**Normal Operation**: 
- Oracle functions purely as view calls
- No maintenance transactions required
- Automatic bounds checking on every price query

**Governance Oversight**:
- Monitor for legitimate price movements vs. attacks
- Update `lastValidPrice` baselines when market conditions change
- Adjust `minShareSupply` if needed based on vault growth
- Emergency pause capability for discovered issues

### Example Configuration

```solidity
// Adding a new vault (e.g., Yearn USDC vault)
addVault(
    0x5f18C75AbDAe578b483E5F43f12a39cF75b973a9,  // yvUSDC vault
    100 * 1e6,                                      // 100 USDC minimum (anti-donation)
    0xA0b86a33E6411da92a1bb2f9a8F45d3a7B5E6F1a   // USDC address
);

// This automatically sets lastValidPrice to current exchange rate
// Oracle immediately becomes active for OracleAggregator integration
```

## Benefits of Simplified Design

### Advantages

1. **Zero Operational Overhead**: No bots, scripts, or periodic maintenance
2. **Immediate Compatibility**: Works with immutable `OracleAggregator` out of the box
3. **Robust Security**: Multi-layered protection without complexity
4. **Gas Efficiency**: Minimal storage and computation costs
5. **Predictable Behavior**: Easy to reason about and audit

### Trade-offs

1. **Manual Baseline Updates**: Governance must update `lastValidPrice` for major market movements
2. **Potential Price Staleness**: During high volatility, may use older "safe" prices
3. **Governance Dependency**: Requires active governance for optimal performance

### Risk Mitigation

- **Staleness Risk**: Bounded by governance responsiveness and deviation threshold
- **Governance Risk**: Multi-sig requirements and timelock mechanisms
- **False Positives**: Conservative deviation threshold (5%) to minimize disruption

## Integration Examples

### With OracleAggregator

```solidity
// Deploy wrapper
ERC4626OracleWrapper wrapper = new ERC4626OracleWrapper(
    USDC_ADDRESS,     // Base currency  
    1e6               // USDC has 6 decimals
);

// Add vaults
wrapper.addVault(yvUSDC, 100e6, USDC_ADDRESS);
wrapper.addVault(yvDAI, 100e18, DAI_ADDRESS);

// OracleAggregator can now use wrapper.getPriceInfo() directly
// No additional setup or maintenance required
```

### Governance Operations

```solidity
// Update baseline after legitimate market movement
wrapper.updateLastValidPrice(yvUSDC, newExchangeRate);

// Emergency pause if issue discovered
wrapper.pauseVault(yvUSDC);

// Resume when issue resolved
wrapper.unPauseVault(yvUSDC);
```

## Testing Strategy

### Unit Tests Coverage

1. **Basic Oracle Functionality**
   - Correct price calculation from ERC-4626 exchange rates
   - Base currency unit scaling
   - Vault health validation

2. **Security Mechanisms**
   - Donation attack resistance (minimum share supply)
   - Price deviation detection and fallback
   - Paused vault handling

3. **Edge Cases**
   - Zero asset vaults
   - Extreme price movements  
   - Invalid vault configurations

4. **Integration Tests**
   - OracleAggregator compatibility
   - Multiple vault management
   - Governance function access control

## Conclusion

This simplified design provides robust security for ERC-4626 oracle integration while maintaining operational simplicity. By focusing on proven protection mechanisms rather than complex TWAP calculations, the oracle achieves the security goals with minimal complexity and zero maintenance overhead.

The design is immediately production-ready and fully compatible with the existing immutable `OracleAggregator` architecture, making it an ideal solution for secure ERC-4626 vault pricing.