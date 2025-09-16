# Dual-Mode dSTAKE Routing Documentation

## Overview

The dSTAKE protocol now supports two distinct routing modes for deposits and withdrawals:

1. **Auto Routing Mode** - Deterministic on-chain vault selection with retry logic
2. **Solver Mode** - Off-chain optimized vault allocation with atomic execution

Both modes are accessible through the `DStakeToken` ERC4626 interface and the underlying `DStakeRouterV2`.

## Auto Routing Mode

### Description
Auto routing provides deterministic on-chain vault selection, ideal for simple integrations and users who prefer automated vault selection. The router selects a single vault based on the current allocation deltas and retries with other vaults if transient errors occur.

### Key Features
- **Single vault per operation** - Each deposit/withdrawal targets one vault
- **Deterministic selection** - Uses `DeterministicVaultSelector` to pick the most underallocated vault
- **Automatic retries** - Retries with next vault on transient errors:
  - `NoLiquidityAvailable`
  - `VaultNotActive`
  - `SlippageCheckFailed`
  - Insufficient balance/allowance errors
- **Standard ERC4626 interface** - Uses familiar deposit/withdraw methods

### Usage

#### Through DStakeToken (Recommended)
```solidity
// Deposit
uint256 shares = dStakeToken.deposit(assets, receiver);

// Withdraw
uint256 assets = dStakeToken.withdraw(assets, receiver, owner);

// Mint specific shares
uint256 assets = dStakeToken.mint(shares, receiver);

// Redeem shares for assets
uint256 assets = dStakeToken.redeem(shares, receiver, owner);
```

#### Direct Router Access (Requires DSTAKE_TOKEN_ROLE)
```solidity
// Deposit
uint256 shares = router.deposit(assets);

// Withdraw
uint256 assets = router.withdraw(assets, receiver, owner);
```

### Events
Auto routing emits `WeightedDeposit` and `WeightedWithdrawal` events with single-element arrays:
```solidity
event WeightedDeposit(address[] vaults, uint256[] assets, uint256[] shares);
event WeightedWithdrawal(address[] vaults, uint256[] assets, uint256[] shares);
```

## Solver Mode

### Description
Solver mode enables off-chain optimization of vault allocations for maximum capital efficiency. An external solver analyzes vault conditions and provides explicit allocation instructions that are executed atomically on-chain.

### Key Features
- **Multi-vault operations** - Deposits/withdrawals across multiple vaults in one transaction
- **Atomic execution** - All-or-nothing, no partial state on failure
- **No retries** - Any error causes complete reversion
- **Explicit allocations** - Caller specifies exact vault/amount pairs
- **Slippage protection** - `minShares`/`maxShares` parameters prevent unfavorable executions

### Usage

#### Through DStakeToken (Recommended)
```solidity
// Deposit assets to multiple vaults
uint256 shares = dStakeToken.solverDepositAssets(
    vaults,     // address[] - vault addresses
    assets,     // uint256[] - asset amounts per vault
    minShares,  // uint256 - minimum dSTAKE shares to receive
    receiver    // address - recipient of shares
);

// Deposit targeting specific vault shares
uint256 shares = dStakeToken.solverDepositShares(
    vaults,     // address[] - vault addresses
    shares,     // uint256[] - vault shares to acquire
    minShares,  // uint256 - minimum dSTAKE shares to receive
    receiver    // address - recipient of shares
);

// Withdraw assets from multiple vaults
uint256 sharesBurned = dStakeToken.solverWithdrawAssets(
    vaults,     // address[] - vault addresses
    assets,     // uint256[] - asset amounts to withdraw per vault
    maxShares,  // uint256 - maximum dSTAKE shares to burn
    receiver,   // address - recipient of assets
    owner       // address - owner of shares
);

// Withdraw specific vault shares
uint256 assetsReceived = dStakeToken.solverWithdrawShares(
    vaults,     // address[] - vault addresses
    shares,     // uint256[] - vault shares to redeem
    maxShares,  // uint256 - maximum dSTAKE shares to burn
    receiver,   // address - recipient of assets
    owner       // address - owner of shares
);
```

#### Direct Router Access (Requires DSTAKE_TOKEN_ROLE)
```solidity
// Deposit assets
(uint256 totalAssets, uint256 totalShares) = router.solverDepositAssets(vaults, assets);

// Deposit shares
(uint256 totalAssets, uint256 totalShares) = router.solverDepositShares(vaults, shares);

// Withdraw assets
(uint256 totalAssets, uint256 totalShares) = router.solverWithdrawAssets(
    vaults, assets, receiver, owner
);

// Withdraw shares
(uint256 totalAssets, uint256 totalShares) = router.solverWithdrawShares(
    vaults, shares, receiver, owner
);
```

### Events
Solver mode emits events with the full arrays provided:
```solidity
event WeightedDeposit(address[] vaults, uint256[] assets, uint256[] shares);
event WeightedWithdrawal(address[] vaults, uint256[] assets, uint256[] shares);
```

## Choosing Between Modes

### Use Auto Routing When:
- Building simple integrations
- Users prefer automated vault selection
- Gas efficiency for single-vault operations is preferred
- Resilience to transient errors is needed

### Use Solver Mode When:
- Optimizing for maximum capital efficiency
- Implementing sophisticated rebalancing strategies
- Requiring atomic multi-vault operations
- Building advanced DeFi integrations

## Error Handling

### Auto Routing Errors
Auto routing will retry on transient errors but will revert on:
- Persistent vault failures
- Insufficient total liquidity across all vaults
- Slippage tolerance exceeded on all vaults

### Solver Mode Errors
Solver mode reverts immediately on any error:
- `EmptyArrays()` - Empty vault/amount arrays provided
- `ArrayLengthMismatch()` - Vault and amount arrays have different lengths
- `SlippageCheckFailed()` - minShares/maxShares constraint violated
- Any vault-specific error (no retries)

## Integration Examples

### Simple User Deposit (Auto Routing)
```solidity
// User deposits 1000 DUSD, router automatically selects best vault
uint256 shares = dStakeToken.deposit(1000e18, msg.sender);
```

### Optimized Multi-Vault Deposit (Solver Mode)
```solidity
// Off-chain solver determines optimal allocation
address[] memory vaults = [vault1, vault2, vault3];
uint256[] memory amounts = [500e18, 300e18, 200e18]; // 50%, 30%, 20%

// Execute atomic multi-vault deposit with slippage protection
uint256 shares = dStakeToken.solverDepositAssets(
    vaults,
    amounts,
    990e18,     // minShares: accept up to 1% slippage
    msg.sender
);
```

### Rebalancing Between Vaults (Solver Mode)
```solidity
// Withdraw from overallocated vaults
address[] memory fromVaults = [vault1];
uint256[] memory withdrawAmounts = [1000e18];
uint256 sharesBurned = dStakeToken.solverWithdrawAssets(
    fromVaults,
    withdrawAmounts,
    1010e18,    // maxShares: accept up to 1% slippage
    address(this),
    msg.sender
);

// Deposit to underallocated vaults
address[] memory toVaults = [vault2, vault3];
uint256[] memory depositAmounts = [600e18, 400e18];
uint256 sharesMinted = dStakeToken.solverDepositAssets(
    toVaults,
    depositAmounts,
    sharesBurned - 10e18, // minShares: ensure no value loss
    msg.sender
);
```

## Security Considerations

1. **Solver Mode Atomicity** - All solver operations are atomic; partial failures cause complete reversion
2. **Approval Management** - Router automatically manages and cleans up vault approvals
3. **Slippage Protection** - Always use appropriate minShares/maxShares values in solver mode
4. **Role-Based Access** - Direct router access requires `DSTAKE_TOKEN_ROLE`
5. **Fee Awareness** - Both modes respect vault withdrawal fees; solver mode requires accurate fee prediction

## Migration Notes

### Breaking Changes from Previous Version
- Multi-vault splitting logic has been removed
- `_executeMultiVaultDeposits` and `_buildWithdrawalPlan` no longer exist
- Auto routing now uses single-vault selection with retries
- New solver mode methods added to both router and token

### Backwards Compatibility
- Standard ERC4626 methods (deposit/withdraw/mint/redeem) continue to work
- Auto routing maintains similar behavior but with single-vault execution
- Events remain compatible but with different array contents