# SIMPLIFY: dSTAKE Token + Router Engine Split

## Motivation
- Keep `DStakeTokenV2` as close to vanilla ERC4626 as feasible for easier auditing, upgrade safety, and reuse of OZ behavior.
- Push mutable business logic (strategy routing, fee handling, settlement management, solver flows) into a replaceable periphery module.
- Enable iterative feature development without touching the token proxy or breaking ERC4626 semantics.

## High-Level Components
- `DStakeTokenV2` (lean ERC4626)
  - Inherits `ERC4626Upgradeable` with minimal overrides.
  - Holds immutable pointer (set during initialize) to the periphery: `routerEngine`.
  - Exposes stock ERC4626 interface + admin setters, no solver-specific surface.
- `RouterEngine`
  - Performs all asset routing, fee application (fees retained in vault), reinvestment, settlement shortfall accounting, pausing/caps.
  - Talks to existing strategy router + collateral vault.
  - Provides read helpers for token (`totalManagedAssets`, `maxDeposit`, etc.).

## Contract Responsibilities

### DStakeTokenV2 (Thin ERC4626)
- `totalAssets()` → call `routerEngine.totalManagedAssets() - routerEngine.currentShortfall()`.
- `afterDeposit(assets, shares, receiver)` → `routerEngine.onDeposit(_msgSender(), assets, shares, receiver)`.
- `beforeWithdraw(assets, shares, owner, receiver)` → `routerEngine.onWithdraw(_msgSender(), assets, shares, owner, receiver)`; engine takes custody and settles net transfer directly to receiver.
- Provide optional maintenance hooks (`mintForMaintenance`, `burnForMaintenance`) gated to engine if needed; no public solver entrypoints.
- Emits standard ERC4626 events; periphery emits fee/solver detail events.

### RouterEngine (Periphery Brain)
- State:
  - `IERC20 asset`, `IDStakeRouter router`, `IDStakeCollateralVault collateralVault`, `DStakeTokenV2 token`.
  - Fee config (`withdrawalFeeBps`, `incentiveBps`, `dustTolerance`).
  - Settlement tracking (`uint256 settlementShortfall`).
  - Control flags (`pausedDeposits`, `pausedWithdrawals`, deposit caps) shared across user + solver flows.
- External entrypoints:
  - Core hooks: `onDeposit(address initiator, uint256 assets, uint256 shares, address receiver)` and `onWithdraw(address initiator, uint256 grossAssets, uint256 shares, address owner, address receiver)` returning `WithdrawMeta`.
  - Solver flows: `solverDepositAssets`, `solverDepositShares`, `solverWithdrawAssets`, `solverWithdrawShares` (directly exposed; no separate gateway).
  - Reinvestment: `reinvestFees()` (engine compounds residual balances back into strategies, after optional incentive).
  - Settlement updates: `recordShortfall(uint256 delta)`, `clearShortfall(uint256 amount)`.
  - Config setters: `setFeeBps`, `setIncentive`, `setPauseState`, `setDepositCap`, etc.
- View helpers consumed by token + UIs: `totalManagedAssets()`, `currentShortfall()`, `maxDeposit(address)`, `maxWithdraw(address)`, `isPaused()`.
- Internals handle:
  - Receiving assets from token on deposit (token approves engine as necessary) and distributing through router.
  - Computing withdrawal fees and incentives once; fees remain in engine/token balance so all shareholders benefit.
  - Settling withdrawals by transferring net assets directly to receiver from engine (token trusts engine for payout).
  - Emitting detailed fee/solver events for analytics.
  - Unified pause logic—solver and user flows respect the same flags.

## Sequence Sketches (Pseudocode)

### ERC4626 User Deposit
```solidity
function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
    shares = previewDeposit(assets); // pure OZ math
    _deposit(msg.sender, receiver, assets, shares); // OZ transfer + share mint
}

function afterDeposit(uint256 assets, uint256 shares, address receiver) internal override {
    routerEngine.onDeposit(msg.sender, assets, shares, receiver);
}
```

`RouterEngine.onDeposit` pseudocode:
```solidity
function onDeposit(address initiator, uint256 assets, uint256 shares, address receiver) external onlyToken {
    require(!pausedDeposits);
    asset.safeTransferFrom(token, address(this), assets); // token already holds assets
    asset.forceApprove(address(router), assets);
    router.deposit(assets); // distribute into strategy vaults
    _updateAccounting(shares, assets);
    emit EngineDepositRouted(initiator, receiver, assets, shares);
}
```

### ERC4626 User Withdraw
```solidity
function beforeWithdraw(uint256 assets, uint256 shares, address owner, address receiver) internal override {
    routerEngine.onWithdraw(msg.sender, assets, shares, owner, receiver);
}
```

`RouterEngine.onWithdraw` pseudocode:
```solidity
function onWithdraw(...) external onlyToken {
    require(!pausedWithdrawals);
    uint256 grossRequested = assets;
    uint256 grossReceived = router.withdraw(grossRequested);
    require(grossReceived >= grossRequested);
    uint256 fee = _calcFee(grossReceived);
    uint256 netAssets = grossReceived - fee;
    asset.safeTransfer(receiver, netAssets); // engine pays receiver directly
    _retainFee(fee); // keep balance on engine/token so share price rises
    emit EngineWithdrawSettled(initiator, receiver, netAssets, fee);
}
```

### Solver Deposit (direct on Engine)
```solidity
function solverDepositAssets(address[] calldata vaults, uint256[] calldata amounts, uint256 minShares, address receiver) external returns (uint256 shares) {
    uint256 totalAssets = sum(amounts);
    require(totalAssets > 0);
    asset.safeTransferFrom(msg.sender, address(this), totalAssets);
    asset.forceApprove(address(router), totalAssets);
    router.solverDepositAssets(vaults, amounts);
    shares = token.previewDeposit(totalAssets);
    require(shares >= minShares);
    token.mint(receiver, shares); // restricted mint callable by engine
    emit EngineSolverDeposit(msg.sender, receiver, totalAssets, shares);
}
```

### Solver Withdraw (direct on Engine)
```solidity
function solverWithdrawShares(address[] calldata vaults, uint256[] calldata shares, uint256 maxShares, address receiver, address owner) external returns (uint256 netAssets) {
    uint256 dStakeShares = token.previewWithdrawByShares(shares);
    require(dStakeShares <= maxShares);
    token.burnFrom(owner, dStakeShares); // engine holds allowance from owner via solver controller
    uint256 grossReceived = router.solverWithdrawShares(vaults, shares);
    uint256 fee = _calcFee(grossReceived);
    netAssets = grossReceived - fee;
    asset.safeTransfer(receiver, netAssets);
    _retainFee(fee);
    emit EngineSolverWithdraw(msg.sender, receiver, netAssets, fee);
}
```

### Fee Reinvestment
```solidity
function reinvestFees() external returns (uint256 amountReinvested) {
    uint256 balance = asset.balanceOf(address(this));
    if (balance == 0) return 0;
    uint256 incentive = balance * incentiveBps / 1e4;
    if (incentive > 0) asset.safeTransfer(msg.sender, incentive);
    uint256 reinvestAmount = balance - incentive;
    asset.forceApprove(address(router), reinvestAmount);
    router.deposit(reinvestAmount);
    emit EngineFeesReinvested(reinvestAmount, incentive, msg.sender);
    return reinvestAmount;
}
```

## Open Questions / Iteration Hooks
- How should allowances be handled between token ↔ engine for mint/burn? Likely `token.mintToEngine` restricted to engine and `engine` maintains per-user approvals for solver withdrawals.
- Ensure shortfall management keeps `totalAssets` consistent: token subtracts `routerEngine.currentShortfall()`, engine updates when settlements occur.
- Revisit dust handling to avoid rounding issues when fees accumulate and are reinvested.

## Next Steps
1. Define `IRouterEngine` interface with deposit/withdraw hooks, solver flows, and views.
2. Modify `DStakeTokenV2` to rely solely on engine hooks; strip solver methods from token.
3. Port existing unit tests to call engine solver methods and validate ERC4626 behavior remains unchanged.
4. Iterate on fee retention + reinvest tests to confirm share price uplift matches expectations.
