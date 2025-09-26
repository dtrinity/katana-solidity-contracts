# SIMPLIFY: dSTAKE Token + Router Split

## Motivation
- Keep `DStakeTokenV2` as close to vanilla ERC4626 as possible for auditability and shared library coverage.
- Concentrate mutable business logic—routing, solver flows, fees, incentives, settlement shortfall—in `DStakeRouterV2`, which is already the operational control surface.
- Preserve the router’s fail-fast philosophy (single-vault attempts, solver overrides) while letting the token act purely as an ERC4626 share ledger.

## High-Level Components
- `DStakeTokenV2` (lean ERC4626)
  - Minimal overrides that delegate side effects to the router.
  - Holds references set during initialization: `router`, `collateralVault`.
  - Emits only standard ERC4626 events and shares settlement; no solver-specific entrypoints.
- `DStakeRouterV2` (periphery)
  - Owns all movement of assets and strategy shares, fee calculation, reinvestment, caps/pauses, solver tooling, and settlement tracking.
  - Exposes deterministic single-vault paths for user flows and multi-vault solver flows.
  - Surfaces view helpers consumed by the token and UIs.

## Contract Responsibilities

### DStakeTokenV2 (Thin ERC4626)
- `totalAssets()` → `router.totalManagedAssets() - router.currentShortfall()`.
- `afterDeposit(assets, shares, receiver)` → invokes `router.handleDeposit(_msgSender(), assets, shares, receiver)`.
- `beforeWithdraw(assets, shares, owner, receiver)` → invokes `router.handleWithdraw(_msgSender(), assets, shares, owner, receiver)`.
- Token trusts router to deliver net withdrawals directly to the receiver and to retain fees locally; token only handles share accounting.
- Optional maintenance hooks (`mintForRouter`, `burnForRouter`) restricted to the router for admin operations.

### DStakeRouterV2 (Orchestrator)
- State
  - `IERC20 asset`, `IDStakeCollateralVaultV2 collateralVault`, `DStakeTokenV2 token`.
  - Fee config (`withdrawalFeeBps`, `incentiveBps`, `dustTolerance`).
  - Settlement tracking (`settlementShortfall`).
  - Unified control flags (`pausedDeposits`, `pausedWithdrawals`, `depositCap`).
- External entrypoints
  - Hook targets: `handleDeposit(...)`, `handleWithdraw(...)` (callable only by token).
  - Solver tooling: `solverDepositAssets`, `solverDepositShares`, `solverWithdrawAssets`, `solverWithdrawShares` (accessible to end users / automation).
  - Fee upkeep: `reinvestFees()` reinjects accumulated balances after paying optional caller incentive.
  - Governance knobs: `setWithdrawalFee`, `setReinvestIncentive`, `setPauseState`, `setDepositCap`, `recordShortfall`, `clearShortfall`.
- Views
  - `totalManagedAssets()`, `currentShortfall()`, `maxDeposit(address)`, `maxMint(address)`, `maxWithdraw(address)`, `maxRedeem(address)`, `paused()`.
- Behavioural guarantees
  - Deposits: single-strategy attempt using the existing deterministic ranking; any adapter revert bubbles up to the token caller (fail fast).
  - Withdraws: single-strategy unwind with strict slippage check; revert on adapter failure; no partial fills unless caller uses solver endpoints.
  - Allowances: always use OZ `forceApprove` so non-standard ERC20s are supported; no additional manual zeroing needed because `forceApprove` already clears stale allowances.
  - Fees: deducted once per withdrawal, retained inside router/token balance, reinvested via `reinvestFees()` so share price increases.
  - Dust: respect router `dustTolerance` for solver operations to avoid dust donations or endless loops.
  - Net transfers: router transfers net assets directly to recipients; token does not intermediate.

## Sequence Sketches (Pseudocode)

### ERC4626 User Deposit
```solidity
function afterDeposit(uint256 assets, uint256 shares, address receiver) internal override {
    router.handleDeposit(_msgSender(), assets, shares, receiver);
}

function handleDeposit(address initiator, uint256 assets, uint256 shares, address receiver) external onlyToken {
    require(!pausedDeposits);
    asset.safeTransferFrom(address(token), address(this), assets); // token already holds funds
    _depositIntoSingleStrategy(assets); // fails fast if adapter reverts
    emit RouterDepositRouted(initiator, receiver, assets, shares);
}
```

### ERC4626 User Withdraw
```solidity
function beforeWithdraw(uint256 assets, uint256 shares, address owner, address receiver) internal override {
    router.handleWithdraw(_msgSender(), assets, shares, owner, receiver);
}

function handleWithdraw(...) external onlyToken {
    require(!pausedWithdrawals);
    uint256 grossReceived = _withdrawFromSingleStrategy(assets);
    require(grossReceived >= assets);
    uint256 fee = _calculateWithdrawalFee(grossReceived);
    uint256 netAssets = grossReceived - fee;
    asset.safeTransfer(receiver, netAssets);
    _retainFee(fee); // stays in router balance so all shareholders benefit
    emit RouterWithdrawSettled(_msgSender(), receiver, netAssets, fee);
}
```

### Solver Deposit (multi-vault)
```solidity
function solverDepositAssets(address[] calldata vaults, uint256[] calldata amounts, uint256 minShares, address receiver) external returns (uint256 shares) {
    uint256 totalAssets = _sum(amounts);
    require(totalAssets > 0);
    asset.safeTransferFrom(msg.sender, address(this), totalAssets);
    _solverDistributeDeposits(vaults, amounts);
    shares = token.previewDeposit(totalAssets);
    require(shares >= minShares);
    token.mintForRouter(receiver, shares); // restricted to router
    emit RouterSolverDeposit(msg.sender, receiver, totalAssets, shares);
}
```

### Solver Withdraw (multi-vault)
```solidity
function solverWithdrawShares(address[] calldata vaults, uint256[] calldata strategyShares, uint256 maxShares, address receiver, address owner) external returns (uint256 netAssets) {
    uint256 dStakeShares = token.previewWithdrawByShares(strategyShares);
    require(dStakeShares <= maxShares);
    token.burnFromRouter(owner, dStakeShares); // router-enforced allowance
    uint256 grossReceived = _solverCollectWithdrawals(vaults, strategyShares);
    uint256 fee = _calculateWithdrawalFee(grossReceived);
    netAssets = grossReceived - fee;
    asset.safeTransfer(receiver, netAssets);
    _retainFee(fee);
    emit RouterSolverWithdraw(msg.sender, receiver, netAssets, fee);
}
```

### Fee Reinvestment
```solidity
function reinvestFees() external returns (uint256 amountReinvested) {
    uint256 balance = asset.balanceOf(address(this));
    if (balance == 0) return 0;

    uint256 incentive = balance * reinvestIncentiveBps / BASIS_POINTS_DENOMINATOR;
    if (incentive > 0) asset.safeTransfer(msg.sender, incentive);

    amountReinvested = balance - incentive;
    _depositIntoSingleStrategy(amountReinvested);
    emit RouterFeesReinvested(amountReinvested, incentive, msg.sender);
}
```

## Checked Lessons
- Preserve fail-fast routing; no retry loops or silent fallbacks.
- Use `forceApprove` when approvals are needed; no separate zeroing step required because the helper already clears stale allowances.
- Keep solver & user flows under shared pause flags.
- Ensure dust tolerance is respected during solver distribution/collection.
- Fees stay inside router/token and are reinvested promptly; events originate from router for analytics.
- Adapter failures should revert without partial side effects to minimize exploit surface.

## Next Steps
1. Define `IDStakeRouterV2` interface for token hooks, solver flows, and view helpers.
2. Strip solver entrypoints and fee logic from `DStakeTokenV2`, delegating to router hooks.
3. Refactor `DStakeRouterV2` to implement the new hook functions while preserving existing public behaviour for operators.
4. Update tests to cover token-router integration (user flows) and direct router solver flows.
5. Add regression tests for fee retention, reinvestment, dust handling, and fail-fast adapter reverts.
