# Dual-Mode dSTAKE Routing (Auto vs Solver)

## Background
- `DStakeRouterV2` currently performs single-vault routing with on-chain retries for a small set of adapter errors. All deposits/withdrawals come from `DStakeToken`’s ERC4626 interface.
- We want to expose **two distinct flows**:
  1. **Auto routing** for on-chain integrations (single vault per attempt, deterministic fallback order, retries only on transient liquidity/balance/allowance/paused errors).
  2. **Solver mode** where an off-chain planner provides explicit vault/amount allocations for deposits and withdrawals. These should execute atomically with zero retries and bubble any failure.
- To support solver mode cleanly we must update both the router and `DStakeToken` (users interact via the token).
- No backwards compatibility requirement: we can remove the current retry logic and multi-vault helpers in favour of the new structure.

## Goals
1. Split router entrypoints into auto vs solver variants, both under `DSTAKE_TOKEN_ROLE`.
2. Mirror solver functionality on `DStakeToken` so frontends/integrations can call through the token and keep share accounting correct.
3. Keep events, accounting, and allowance hygiene intact (no residual approvals, no partial state on failure).
4. Update documentation, comments, and tests to reflect the new API.

## Deliverables
### Router (`contracts/vaults/dstake/DStakeRouterV2.sol`)
- Maintain auto-routing ERC4626-style entrypoints:
  - `deposit(uint256 assets)`
  - `withdraw(uint256 assets, address receiver, address owner)`
  - These should continue to pick the highest-delta vault, retrying other vaults when they throw well-known transient errors; revert otherwise.
- Add solver-mode entrypoints (all or nothing, no retries, bubble every revert):
  - `solverDepositAssets(address[] calldata vaults, uint256[] calldata assets)`
  - `solverDepositShares(address[] calldata vaults, uint256[] calldata shares)`
  - `solverWithdrawAssets(address[] calldata vaults, uint256[] calldata assets, address receiver, address owner)`
  - `solverWithdrawShares(address[] calldata vaults, uint256[] calldata shares, address receiver, address owner)`
- Implementation notes:
  - Arrays must be same length & non-empty.
  - Sum assets/shares for reporting/events; emit `WeightedDeposit/WeightedWithdrawal` with the arrays provided.
  - Loop through inputs; if any adapter interaction fails (any revert), reset approvals/shares that were moved in that iteration and revert the whole call.
  - Remove the existing multi-vault planning helpers (`_executeMultiVaultDeposits`, `_buildWithdrawalPlan`, etc.). Auto mode should only rely on simple deterministic ordering + transient-error retries.
  - Consider naming helper(s) for shared per-vault deposit/withdraw mechanics to avoid duplication between auto & solver flows.

### Token (`contracts/vaults/dstake/DStakeToken.sol`)
- Introduce solver-facing methods (names TBD but should make intent clear). Suggested signature pairs:
  - `function solverDepositAssets(address[] calldata vaults, uint256[] calldata assets, uint256 minShares, address receiver) external returns (uint256 shares);`
  - `function solverDepositShares(address[] calldata vaults, uint256[] calldata shares, uint256 minShares, address receiver) external returns (uint256 shares);`
  - `function solverWithdrawAssets(address[] calldata vaults, uint256[] calldata assets, uint256 maxShares, address receiver, address owner) external returns (uint256 shares);`
  - `function solverWithdrawShares(address[] calldata vaults, uint256[] calldata shares, uint256 maxShares, address receiver, address owner) external returns (uint256 assets);`
- These should:
  - Perform ERC4626-style share/asset validation (respect min/max limits, consistent with existing `deposit/mint/withdraw/redeem`).
  - Call the router solver entrypoints.
  - Mint/burn the correct amount of dSTAKE shares once the router returns.
  - Emit the existing ERC4626 events (`Deposit`/`Withdraw`).
- Decide whether to expose solver entrypoints publicly or behind roles; default assumption is keep public like ERC4626 but document that frontends are expected to preload parameters via an off-chain solver.

### Events & Accounting
- Auto mode emits single-element arrays; solver mode emits arrays provided by caller.
- Ensure router approvals are zeroed on both success and failure.
- No surplus/shortfall state handling; we revert on any mismatch.

### Docs & Tests
- Update or create documentation describing auto vs solver flows (e.g., `docs/dstake/withdrawal_brainstorm.md` or a new doc).
- Add/adjust tests covering:
  - Auto route success, fallback retry behaviour.
  - Solver-mode success for assets & shares (deposit + withdraw).
  - Solver-mode revert when any leg fails, including allowance/liquidity errors.
  - Token share accounting (mint/burn) across new methods.
- Update deploy scripts, Hardhat fixtures, and interfaces (TypeChain, ABIs) to reference the new entrypoints.

## Non-Goals / Constraints
- No backwards compatibility required with the prior multi-vault splitting logic.
- We are not optimizing for minimal gas beyond removing unused logic; clarity > micro-optimizations right now.
- Keep reliance on existing adapters; do not refactor adapter interfaces in this pass.

## Acceptance Criteria
- All four solver router entrypoints exist and behave atomically.
- DStakeToken exposes corresponding solver helpers and maintains ERC4626 invariants.
- Auto routing still works with deterministic single-vault attempts and bounded retries.
- Existing tests pass plus new solver coverage; lint/compile succeed.
- Documentation reflects the dual-mode design.

## Implementation Plan

### Phase 1: Analysis & Preparation
1. Analyze current DStakeRouterV2 implementation to understand existing structure
2. Analyze DStakeToken implementation for ERC4626 integration
3. Identify multi-vault planning helpers to remove

### Phase 2: Router Refactoring
1. Remove multi-vault planning helpers (`_executeMultiVaultDeposits`, `_buildWithdrawalPlan`, etc.)
2. Implement solver-mode entrypoints (4 new methods)
3. Update auto-routing logic to use simple deterministic ordering with retry on transient errors

### Phase 3: Token Enhancement
1. Implement solver-facing methods in DStakeToken (4 new methods)
2. Ensure proper share accounting and ERC4626 event emission
3. Integrate with router's solver entrypoints

### Phase 4: Testing & Documentation
1. Write comprehensive tests for solver mode
2. Update tests for auto-routing mode
3. Fix any test failures
4. Update documentation

## Status Updates

**2025-09-16 - Starting Implementation**
- Created comprehensive implementation plan
- Starting parallel analysis of router and token contracts

**2025-09-16 - Implementation Complete**
- ✅ Removed multi-vault planning helpers from DStakeRouterV2
- ✅ Implemented 4 solver-mode entrypoints in router
- ✅ Updated auto-routing to use single-vault deterministic selection with retry
- ✅ Added 4 solver-facing methods to DStakeToken
- ✅ Created comprehensive test suite for solver mode (22 tests)
- ✅ Updated existing tests for new single-vault auto-routing behavior
- ✅ Fixed all test failures (655 tests passing)
- ✅ Resolved linting issues (0 errors, 6 unrelated warnings)
- ✅ Created detailed documentation in docs/dstake/dual-mode-routing.md

## Summary of Changes

### DStakeRouterV2.sol
- Removed: `_executeMultiVaultDeposits`, `_buildWithdrawalPlan`, `_executeWithdrawalPlan`
- Added solver methods: `solverDepositAssets`, `solverDepositShares`, `solverWithdrawAssets`, `solverWithdrawShares`
- Refactored auto-routing to single-vault with retry on transient errors
- Added helper functions for atomic operations and error detection

### DStakeToken.sol
- Added: `solverDepositAssets`, `solverDepositShares`, `solverWithdrawAssets`, `solverWithdrawShares`
- Integrated with router's solver entrypoints
- Maintains ERC4626 compatibility with proper share accounting

### Testing
- Created DStakeSolverMode.test.ts with 22 comprehensive tests
- Updated DStakeRouterV2.test.ts and DStakeRouterV2Fixes.test.ts for single-vault behavior
- Fixed MetaMorphoLifecycle.test.ts access control issue
- All 655 tests passing

### Documentation
- Created comprehensive dual-mode-routing.md documentation
- Includes usage examples, integration patterns, and migration notes

## Acceptance Criteria Status
✅ All four solver router entrypoints exist and behave atomically
✅ DStakeToken exposes corresponding solver helpers and maintains ERC4626 invariants
✅ Auto routing works with deterministic single-vault attempts and bounded retries
✅ All tests pass with new solver coverage
✅ Lint/compile succeed
✅ Documentation reflects the dual-mode design
