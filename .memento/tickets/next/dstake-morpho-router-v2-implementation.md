# Implementation: DStake Morpho Router V2 - Weighted Random Routing

## Summary
Implement a new DStakeRouter variant that uses weighted random selection to route deposits and withdrawals across multiple Morpho vaults, achieving target allocations through natural convergence without explicit rebalancing.

## Background
Current DStakeRouter uses a simple defaultDepositVaultAsset approach. We need a system that can:
- Distribute deposits across multiple Morpho vaults
- Converge toward target allocations without gas-intensive rebalancing
- Handle emergency situations through collateral exchange
- Remain simple, auditable, and gas-efficient

## Design Decisions

### Core Algorithm: Weighted Random Selection

**Deposits:**
- Always split into exactly 3 vaults (or fewer if not enough active vaults)
- Vaults selected via weighted randomness where weight = max(0, targetBps - currentBps)
- Equal split among selected vaults (amount/3 each)
- Natural velocity adjustment: underweight vaults have higher selection probability

**Withdrawals:**
- Also use weighted random selection where weight = max(0, currentBps - targetBps)
- Select 3 vaults weighted by how overweight they are
- Pull proportionally based on available liquidity

**Benefits:**
- No magic numbers or complex math
- Predictable gas costs (always touch 3 vaults)
- Natural convergence without explicit rebalancing
- Smooth allocation changes over time

### Architecture Decisions

1. **Router-Level Implementation**
   - Routing logic lives directly in DStakeRouterMorpho (not separate strategy contract)
   - Router is already swappable via governance
   - Simpler architecture, fewer external calls

2. **Direct Morpho Integration**
   - Read vault states directly from Morpho contracts
   - No internal vault state management
   - Trust Morpho's pause/guardian mechanisms

3. **No Explicit Rebalancing**
   - Deposits and withdrawals naturally move toward target
   - Collateral exchange function for emergency/manual optimization only
   - No automatic rebalancing transactions

4. **Pseudo-Random Selection**
   - Use block.prevrandao + msg.sender + nonce for randomness
   - Good enough for vault selection (not security-critical)
   - Provides natural load balancing

## Detailed Specification

### Contract: DStakeRouterMorpho

```solidity
contract DStakeRouterMorpho is DStakeRouter {
    // State variables
    struct VaultConfig {
        address vault;           // MetaMorpho vault address
        address adapter;         // Conversion adapter address
        uint256 targetBps;      // Target allocation in basis points (60% = 6000)
    }
    
    VaultConfig[] public vaultConfigs;
    uint256 private nonce;  // For pseudo-randomness
    
    // Constants
    uint256 constant MAX_VAULTS_PER_OPERATION = 3;
    uint256 constant BPS_BASE = 10000;
    
    // Core functions
    function deposit(address dStable, uint256 amount, address receiver) external returns (uint256 shares);
    function withdraw(address dStable, uint256 amount, address receiver) external returns (uint256);
    function exchangeCollateral(address fromVault, address toVault, uint256 amount) external;
    
    // Admin functions
    function setVaultConfigs(VaultConfig[] calldata configs) external onlyOwner;
    function emergencyPause(address vault) external onlyGuardian;
    
    // View functions
    function getCurrentAllocations() external view returns (uint256[] memory);
    function getActiveVaults() external view returns (address[] memory);
}
```

### Deposit Flow
```
1. Get all active vaults and calculate weights
   - Weight = max(0, targetBps - currentBps)
   - Skip paused vaults (check Morpho contract)

2. Select 3 vaults using weighted random selection
   - Generate pseudo-random number
   - Select without replacement
   - If <3 active vaults, use all

3. Split deposit equally among selected vaults
   - amount/3 to each vault (handle rounding on last)
   - Call adapter.deposit() for each
   - Track shares minted

4. Return total shares to user
```

### Withdrawal Flow
```
1. Get all vaults and calculate weights
   - Weight = max(0, currentBps - targetBps)  // Opposite of deposit
   - Include liquidity check from Morpho

2. Select 3 vaults using weighted random selection
   - Prioritize overweight vaults
   - Consider available liquidity

3. Calculate withdrawal amounts
   - Split proportionally based on available liquidity
   - May need to try additional vaults if insufficient

4. Execute withdrawals
   - Call adapter.withdraw() for each
   - Handle any rounding/remainder
```

### Collateral Exchange Flow
```
1. Verify permissions (COLLATERAL_EXCHANGER_ROLE)
2. Check target vault is active and healthy
3. Pull assets from source vault via collateralVault
4. Redeem from source MetaMorpho vault
5. Deposit to target MetaMorpho vault
6. Update collateralVault accounting
```

### Pseudo-Random Implementation
```solidity
function _pseudoRandom() internal returns (uint256) {
    nonce++;
    return uint256(keccak256(abi.encodePacked(
        block.timestamp,
        block.prevrandao,  // Replaces block.difficulty post-merge
        msg.sender,
        nonce
    )));
}

function _selectWeightedRandom(
    address[] memory items,
    uint256[] memory weights,
    uint256 count
) internal returns (address[] memory selected) {
    // Implementation:
    // 1. Calculate cumulative weights
    // 2. Generate random number in range [0, totalWeight)
    // 3. Find item where cumulative weight > random
    // 4. Remove selected item from next iteration
    // 5. Repeat for count selections
}
```

## Implementation Tasks

### Phase 1: Core Router Development
- [ ] Create DStakeRouterMorpho contract inheriting from DStakeRouter
- [ ] Implement weighted random selection algorithm
- [ ] Add deposit routing with 3-vault split
- [ ] Add withdrawal routing with liquidity awareness
- [ ] Implement collateral exchange function
- [ ] Add vault configuration management

### Phase 2: Integration
- [ ] Create MetaMorphoConversionAdapter if not exists
- [ ] Update deployment scripts to deploy new router
- [ ] Add router upgrade migration script
- [ ] Configure initial vault weights

### Phase 3: Testing
- [ ] Unit tests for weighted random selection
- [ ] Integration tests with mock Morpho vaults
- [ ] Convergence simulation (1000+ deposits/withdrawals)
- [ ] Gas optimization tests
- [ ] Edge case testing (single vault, all paused, etc.)
- [ ] Fuzz testing for random selection

### Phase 4: Deployment
- [ ] Deploy to testnet with 2-3 test vaults
- [ ] Monitor convergence behavior
- [ ] Test collateral exchange
- [ ] Security review
- [ ] Mainnet deployment plan

## Test Scenarios

### Convergence Test
```javascript
it("Should converge to target allocations over time", async function () {
    // Setup: 3 vaults with targets [50%, 30%, 20%]
    // Start with skewed allocations [70%, 20%, 10%]
    
    // Execute 100 random deposits of varying sizes
    for (let i = 0; i < 100; i++) {
        const amount = randomAmount(100, 10000);
        await router.deposit(dStable.address, amount, user.address);
    }
    
    // Check allocations are within 5% of targets
    const allocations = await router.getCurrentAllocations();
    expect(allocations[0]).to.be.closeTo(5000, 500); // 50% ± 5%
    expect(allocations[1]).to.be.closeTo(3000, 500); // 30% ± 5%
    expect(allocations[2]).to.be.closeTo(2000, 500); // 20% ± 5%
});
```

### Gas Cost Test
```javascript
it("Should maintain consistent gas costs", async function () {
    // Small deposit (3 vaults)
    const tx1 = await router.deposit(dStable.address, parseEther("100"), user.address);
    expect(tx1.gasUsed).to.be.below(200000);
    
    // Large deposit (still 3 vaults)
    const tx2 = await router.deposit(dStable.address, parseEther("1000000"), user.address);
    expect(tx2.gasUsed).to.be.below(200000);
    
    // Gas should be similar regardless of deposit size
    expect(Math.abs(tx1.gasUsed - tx2.gasUsed)).to.be.below(10000);
});
```

### Edge Cases to Test
1. Single vault active (others paused)
2. All vaults at target allocation
3. New vault with 0 balance
4. Vault becomes paused mid-transaction
5. Insufficient liquidity for withdrawal
6. Extreme skew (one vault at 95%)
7. Rounding errors with small amounts

## Deployment Configuration

### Initial Testnet Configuration
```javascript
const vaultConfigs = [
    {
        vault: "0x...", // MetaMorpho USDC vault
        adapter: "0x...", // MetaMorphoConversionAdapter
        targetBps: 5000  // 50%
    },
    {
        vault: "0x...", // MetaMorpho WETH vault
        adapter: "0x...", 
        targetBps: 3000  // 30%
    },
    {
        vault: "0x...", // MetaMorpho DAI vault
        adapter: "0x...",
        targetBps: 2000  // 20%
    }
];
```

### Monitoring Requirements
- Track allocation drift from targets
- Monitor gas costs per operation
- Log vault selection patterns
- Alert on convergence anomalies
- Track collateral exchange usage

## Security Considerations

### Risks and Mitigations
1. **Randomness Manipulation**
   - Risk: Miner/validator could influence vault selection
   - Mitigation: Not security-critical, only affects vault selection
   - Note: Consider upgrading to VRF if becomes critical

2. **Vault Pause/Exploit**
   - Risk: Depositing to compromised vault
   - Mitigation: Check Morpho pause status before operations
   - Emergency: Collateral exchange to move funds

3. **Convergence Failure**
   - Risk: Allocations don't converge to targets
   - Mitigation: Monitor and use collateral exchange if needed
   - Fallback: Upgrade to new router version

4. **Gas Griefing**
   - Risk: Attacker forces expensive operations
   - Mitigation: Fixed 3-vault limit keeps costs bounded

### Audit Focus Areas
- Weighted random selection correctness
- Rounding error handling
- Reentrancy protection
- Access control on admin functions
- Integration with MetaMorpho contracts

## Success Metrics
- Allocations within 5% of targets after 50+ operations
- Gas cost <200k for deposits, <250k for withdrawals
- Zero failed transactions due to router logic
- Convergence time <1 week with normal volume
- No manual interventions required

## Migration Plan

### From Current Router
1. Deploy new DStakeRouterMorpho
2. Configure vault weights
3. Transfer roles to new router
4. Update DStakeToken to point to new router
5. Move funds via collateral exchange if needed

### Rollback Plan
1. Pause new router
2. Deploy previous router version
3. Update DStakeToken pointer
4. Transfer funds back if needed

## Open Questions (Resolved)
1. ~~Should we use separate strategy contract?~~ → No, keep in router
2. ~~How many vaults per operation?~~ → Always 3 (or fewer if not enough)
3. ~~Explicit rebalancing function?~~ → No, only collateral exchange
4. ~~Cache liquidity data?~~ → No, direct reads are simpler
5. ~~Overshoot protection needed?~~ → No, natural distribution prevents it

## References
- [MetaMorpho Documentation](https://docs.morpho.org/metamorpho/overview)
- [ERC-4626 Tokenized Vault Standard](https://eips.ethereum.org/EIPS/eip-4626)
- [Weighted Random Selection Algorithms](https://en.wikipedia.org/wiki/Fitness_proportionate_selection)
- Current DStakeRouter implementation: `contracts/vaults/dstake/DStakeRouter.sol`

## Acceptance Criteria
- [ ] All unit tests passing
- [ ] Gas costs within specified bounds
- [ ] Convergence demonstrated in simulation
- [ ] Security review completed
- [ ] Documentation updated
- [ ] Deployment scripts ready
- [ ] Monitoring dashboard configured