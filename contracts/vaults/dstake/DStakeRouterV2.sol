// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IDStakeRouterV2 } from "./interfaces/IDStakeRouterV2.sol";
import { IDStableConversionAdapterV2 } from "./interfaces/IDStableConversionAdapterV2.sol";
import { IDStakeCollateralVaultV2 } from "./interfaces/IDStakeCollateralVaultV2.sol";
import { DeterministicVaultSelector } from "./libraries/DeterministicVaultSelector.sol";
import { AllocationCalculator } from "./libraries/AllocationCalculator.sol";
import { BasisPointConstants } from "../../common/BasisPointConstants.sol";

/**
 * @title DStakeRouterV2
 * @notice Supports deterministic, multi-vault routing for deposits and withdrawals.
 * @dev Extends the original single-dLEND router with allocation-aware selection and off-chain solver support.
 */
contract DStakeRouterV2 is IDStakeRouterV2, AccessControl, ReentrancyGuard, Pausable {
  using SafeERC20 for IERC20;
  using AllocationCalculator for uint256[];
  using Math for uint256;

  // --- Errors ---
  error ZeroAddress();
  error AdapterNotFound(address strategyShare);
  error ZeroPreviewWithdrawAmount(address strategyShare);
  error VaultAssetManagedByDifferentAdapter(address strategyShare, address existingAdapter);
  error ZeroInputDStableValue(address fromAsset, uint256 fromAmount);
  error AdapterAssetMismatch(address adapter, address expectedAsset, address actualAsset);
  error SlippageCheckFailed(address asset, uint256 actualAmount, uint256 requiredAmount);
  error AdapterSharesMismatch(uint256 actualShares, uint256 reportedShares);
  error ShareWithdrawalConversionFailed();
  error DepositConversionFailed(address vault, uint256 amount);
  error SolverShareDepositShortfall(address vault, uint256 expectedShares, uint256 actualShares);
  error InvalidAmount();
  error InvalidVaultConfig();
  error VaultNotActive(address vault);
  error VaultNotFound(address vault);
  error InsufficientActiveVaults();
  error VaultAlreadyExists(address vault);
  error TotalAllocationInvalid(uint256 total);
  error NoLiquidityAvailable();
  error InvalidMaxVaultCount(uint256 count);
  error EmptyArrays();
  error ArrayLengthMismatch();
  error InvalidMaxRoutingAttempts(uint256 attempts);
  error OnlySelfCallable();
  error IndexOutOfBounds();
  error InsufficientRetryGas(uint256 gasLeft, uint256 requiredGas);
  error InvalidRetryGasConfig();

  // --- Roles ---
  bytes32 public constant DSTAKE_TOKEN_ROLE = keccak256("DSTAKE_TOKEN_ROLE");
  bytes32 public constant STRATEGY_REBALANCER_ROLE = keccak256("STRATEGY_REBALANCER_ROLE");
  bytes32 public constant ADAPTER_MANAGER_ROLE = keccak256("ADAPTER_MANAGER_ROLE");
  bytes32 public constant CONFIG_MANAGER_ROLE = keccak256("CONFIG_MANAGER_ROLE");
  bytes32 public constant VAULT_MANAGER_ROLE = keccak256("VAULT_MANAGER_ROLE");
  bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

  // --- State ---
  address public immutable dStakeToken;
  IDStakeCollateralVaultV2 public immutable collateralVault;
  address public immutable dStable;

  uint256 public dustTolerance = 1;
  uint256 public maxVaultCount = 10;
  uint256 public maxRoutingAttempts = 3;

  mapping(address => address) private _strategyShareToAdapter;
  address public defaultDepositStrategyShare;

  // --- Retry Gas Controls ---
  uint256 public retryCompletionReserve;
  uint256 public retryMinCallGas;
  uint256 public retryOverheadBuffer;

  struct ExchangeLocals {
    address fromAdapterAddress;
    address toAdapterAddress;
    IDStableConversionAdapterV2 fromAdapter;
    IDStableConversionAdapterV2 toAdapter;
    uint256 dStableValueIn;
    uint256 calculatedToStrategyShareAmount;
  }

  enum OperationType {
    DEPOSIT,
    WITHDRAWAL
  }

  enum VaultStatus {
    Active,
    Suspended,
    Impaired
  }

  struct VaultConfig {
    address strategyVault;
    address adapter;
    uint256 targetBps;
    VaultStatus status;
  }

  VaultConfig[] public vaultConfigs;
  mapping(address => uint256) public vaultToIndex;
  mapping(address => bool) public vaultExists;

  // --- Events ---
  event RouterDeposit(
    address indexed adapter,
    address indexed strategyShare,
    address indexed dStakeToken,
    uint256 strategyShareAmount,
    uint256 dStableAmount
  );
  event Withdrawn(address indexed strategyShare, uint256 strategyShareAmount, uint256 dStableAmount, address owner, address receiver);
  event StrategySharesExchanged(
    address indexed fromStrategyShare,
    address indexed toStrategyShare,
    uint256 fromShareAmount,
    uint256 toShareAmount,
    uint256 dStableAmountEquivalent,
    address indexed exchanger
  );
  event AdapterSet(address indexed strategyShare, address adapterAddress);
  event AdapterRemoved(address indexed strategyShare, address adapterAddress);
  event DefaultDepositStrategyShareSet(address indexed strategyShare);
  event DustToleranceSet(uint256 newDustTolerance);
  event SurplusSwept(uint256 amount, address vaultAsset);
  event StrategyDepositRouted(address[] selectedVaults, uint256[] depositAmounts, uint256 totalDStableAmount);
  event StrategyWithdrawalRouted(address[] selectedVaults, uint256[] withdrawalAmounts, uint256 totalDStableAmount);
  event VaultConfigAdded(address indexed vault, address indexed adapter, uint256 targetBps, VaultStatus status);
  event VaultConfigUpdated(address indexed vault, address indexed adapter, uint256 targetBps, VaultStatus status);
  event VaultConfigRemoved(address indexed vault);
  event StrategiesRebalanced(address indexed fromVault, address indexed toVault, uint256 amount, address indexed initiator);
  event MaxVaultCountUpdated(uint256 oldCount, uint256 newCount);
  event MaxRoutingAttemptsUpdated(uint256 oldCount, uint256 newCount);
  event RetryGasConfigUpdated(uint256 minCallGas, uint256 completionReserve, uint256 overheadBuffer);

  constructor(address _dStakeToken, address _collateralVault) {
    if (_dStakeToken == address(0) || _collateralVault == address(0)) {
      revert ZeroAddress();
    }

    dStakeToken = _dStakeToken;
    collateralVault = IDStakeCollateralVaultV2(_collateralVault);
    dStable = collateralVault.dStable();
    if (dStable == address(0)) {
      revert ZeroAddress();
    }

    _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    _grantRole(ADAPTER_MANAGER_ROLE, msg.sender);
    _grantRole(CONFIG_MANAGER_ROLE, msg.sender);
    _grantRole(VAULT_MANAGER_ROLE, msg.sender);
    _grantRole(PAUSER_ROLE, msg.sender);
    _grantRole(DSTAKE_TOKEN_ROLE, _dStakeToken);

    // initialise retry gas defaults
    retryCompletionReserve = 50_000;
    retryMinCallGas = 150_000;
    retryOverheadBuffer = 5_000;
  }

  // --- Core Router Functions ---

  function strategyShareToAdapter(address strategyShare) external view returns (address) {
    return _strategyShareToAdapter[strategyShare];
  }

  function deposit(uint256 dStableAmount) external override onlyRole(DSTAKE_TOKEN_ROLE) nonReentrant whenNotPaused {
    if (dStableAmount == 0) revert InvalidAmount();

    (
      address[] memory activeVaults,
      uint256[] memory currentAllocations,
      uint256[] memory targetAllocations
    ) = _getActiveVaultsAndAllocations(OperationType.DEPOSIT);

    if (activeVaults.length == 0) revert InsufficientActiveVaults();

    // Get vaults sorted by under-allocation (most under-allocated first)
    uint256 selectionCount = activeVaults.length > maxRoutingAttempts ? maxRoutingAttempts : activeVaults.length;
    (address[] memory sortedVaults, ) = DeterministicVaultSelector.selectTopUnderallocated(
      activeVaults,
      currentAllocations,
      targetAllocations,
      selectionCount
    );

    IERC20(dStable).safeTransferFrom(msg.sender, address(this), dStableAmount);

    // Try vaults in allocation-aware order until one succeeds
    // This maintains balance across vaults according to target allocations
    for (uint256 i = 0; i < sortedVaults.length; i++) {
      address targetVault = sortedVaults[i];
      uint256 callGas = _computeRetryCallGas(sortedVaults.length - i);

      /**
       * @dev External self-call with try/catch to isolate adapter failures and allow fallback.
       * Notes:
       * - Reentrancy: the public entrypoint is nonReentrant; the called wrapper is self-callable only.
       * - Gas: there is no explicit gas cap. Under EIP-150 the caller retains ~1/64 gas on callee
       *   failure, which usually allows continuing, but a callee can still consume most gas and
       *   jeopardize subsequent attempts.
       * - Exceptions: try/catch captures callee-side failures (revert/panic/OOG/call failure). It
       *   cannot catch if this function itself runs out of gas.
       * - Call frames: the external self-call creates a new call frame (separate operand stack) but
       *   increases call depth; it does not prevent call-depth overflow.
       * - Behavior: on any failure, continue to the next vault.
       */
      try this._depositToVaultWithRetry{ gas: callGas }(targetVault, dStableAmount) returns (uint256) {
        // Success - emit event and return
        address[] memory vaultArray = new address[](1);
        uint256[] memory amountArray = new uint256[](1);
        vaultArray[0] = targetVault;
        amountArray[0] = dStableAmount;
        emit StrategyDepositRouted(vaultArray, amountArray, dStableAmount);
        return;
      } catch {
        // Continue to next vault on any error (transient or permanent)
        // External call pattern allows graceful fallback without gas exhaustion
        if (i == sortedVaults.length - 1) {
          // All vaults failed, no liquidity available
          revert NoLiquidityAvailable();
        }
      }
    }

    revert NoLiquidityAvailable();
  }

  function withdraw(
    uint256 dStableAmount
  ) external override onlyRole(DSTAKE_TOKEN_ROLE) nonReentrant whenNotPaused returns (uint256 totalWithdrawn) {
    if (dStableAmount == 0) revert InvalidAmount();

    (
      address[] memory activeVaults,
      uint256[] memory currentAllocations,
      uint256[] memory targetAllocations
    ) = _getActiveVaultsAndAllocations(OperationType.WITHDRAWAL);

    if (activeVaults.length == 0) revert InsufficientActiveVaults();

    // Get vaults sorted by over-allocation (most over-allocated first)
    // Prioritizes over-allocated vaults to rebalance the system
    uint256 selectionCount = activeVaults.length > maxRoutingAttempts ? maxRoutingAttempts : activeVaults.length;
    (address[] memory sortedVaults, ) = DeterministicVaultSelector.selectTopOverallocated(
      activeVaults,
      currentAllocations,
      targetAllocations,
      selectionCount
    );

    // Try vaults in allocation-aware order until one succeeds
    for (uint256 i = 0; i < sortedVaults.length; i++) {
      address targetVault = sortedVaults[i];

      /**
       * @dev External self-call with try/catch for withdrawals to enable fallback across vaults.
       * Mirrors the deposit path semantics regarding gas, exceptions, and call depth. The
       * entrypoint is nonReentrant; the called wrapper is self-callable only.
       */
      uint256 callGas = _computeRetryCallGas(sortedVaults.length - i);

      try this._withdrawFromVaultWithRetry{ gas: callGas }(targetVault, dStableAmount, false) returns (uint256 withdrawnAmount) {
        IERC20(dStable).safeTransfer(msg.sender, withdrawnAmount);

        address[] memory vaultArray = new address[](1);
        uint256[] memory amountArray = new uint256[](1);
        vaultArray[0] = targetVault;
        amountArray[0] = withdrawnAmount;

        emit StrategyWithdrawalRouted(vaultArray, amountArray, withdrawnAmount);
        return withdrawnAmount;
      } catch {
        // Continue to next vault on any error (transient or permanent)
        // External call pattern allows graceful fallback without gas exhaustion
        if (i == sortedVaults.length - 1) {
          // All vaults failed, no liquidity available
          revert NoLiquidityAvailable();
        }
      }
    }

    revert NoLiquidityAvailable();
  }

  // --- Solver Mode Entrypoints ---

  function solverDepositAssets(
    address[] calldata vaults,
    uint256[] calldata assets
  ) external onlyRole(DSTAKE_TOKEN_ROLE) nonReentrant whenNotPaused {
    if (vaults.length == 0) revert EmptyArrays();
    if (vaults.length != assets.length) revert ArrayLengthMismatch();

    uint256 totalAssets = 0;
    for (uint256 i = 0; i < assets.length; i++) {
      totalAssets += assets[i];
    }

    if (totalAssets == 0) revert InvalidAmount();
    IERC20(dStable).safeTransferFrom(msg.sender, address(this), totalAssets);

    // Execute deposits atomically - any failure reverts the entire transaction
    for (uint256 i = 0; i < vaults.length; i++) {
      if (assets[i] > 0) {
        _depositToVaultAtomically(vaults[i], assets[i]);
      }
    }

    emit StrategyDepositRouted(vaults, assets, totalAssets);
  }

  function solverDepositShares(
    address[] calldata vaults,
    uint256[] calldata shares
  ) external onlyRole(DSTAKE_TOKEN_ROLE) nonReentrant whenNotPaused {
    if (vaults.length == 0) revert EmptyArrays();
    if (vaults.length != shares.length) revert ArrayLengthMismatch();

    uint256[] memory assetAmounts = new uint256[](vaults.length);
    uint256 totalAssets = 0;

    // Validate vaults and calculate assets needed
    for (uint256 i = 0; i < vaults.length; i++) {
      if (shares[i] > 0) {
        // Validate vault is registered and active
        VaultConfig memory config = _getVaultConfig(vaults[i]);
        if (config.status != VaultStatus.Active) revert VaultNotActive(vaults[i]);

        // Use previewMint to determine assets needed to mint the desired shares
        uint256 assetsNeeded = IERC4626(vaults[i]).previewMint(shares[i]);
        assetAmounts[i] = assetsNeeded;
        totalAssets += assetsNeeded;
      }
    }

    if (totalAssets == 0) revert InvalidAmount();
    IERC20(dStable).safeTransferFrom(msg.sender, address(this), totalAssets);

    // Execute deposits through adapters to get exact shares
    for (uint256 i = 0; i < vaults.length; i++) {
      if (shares[i] > 0) {
        // Use adapter to deposit the required assets
        // Adapter will handle the conversion and ensure we get the shares
        uint256 mintedShares = _depositToVaultAtomically(vaults[i], assetAmounts[i]);
        if (mintedShares < shares[i]) {
          revert SolverShareDepositShortfall(vaults[i], shares[i], mintedShares);
        }
      }
    }

    emit StrategyDepositRouted(vaults, assetAmounts, totalAssets);
  }

  function solverWithdrawAssets(
    address[] calldata vaults,
    uint256[] calldata assets
  ) external onlyRole(DSTAKE_TOKEN_ROLE) nonReentrant whenNotPaused returns (uint256 totalWithdrawn) {
    if (vaults.length == 0) revert EmptyArrays();
    if (vaults.length != assets.length) revert ArrayLengthMismatch();

    uint256 totalAssets = 0;
    for (uint256 i = 0; i < assets.length; i++) {
      totalAssets += assets[i];
    }

    if (totalAssets == 0) revert InvalidAmount();

    // Execute withdrawals atomically, enforcing strict slippage checks
    for (uint256 i = 0; i < vaults.length; i++) {
      if (assets[i] > 0) {
        totalWithdrawn += _withdrawFromVaultAtomically(vaults[i], assets[i], false);
      }
    }

    IERC20(dStable).safeTransfer(msg.sender, totalWithdrawn);

    emit StrategyWithdrawalRouted(vaults, assets, totalWithdrawn);
    return totalWithdrawn;
  }

  function solverWithdrawShares(
    address[] calldata vaults,
    uint256[] calldata shares
  ) external onlyRole(DSTAKE_TOKEN_ROLE) nonReentrant whenNotPaused returns (uint256 totalWithdrawn) {
    if (vaults.length == 0) revert EmptyArrays();
    if (vaults.length != shares.length) revert ArrayLengthMismatch();

    uint256[] memory assetAmounts = new uint256[](vaults.length);
    uint256 totalAssets = 0;

    // Convert shares to vault asset amounts
    for (uint256 i = 0; i < vaults.length; i++) {
      if (shares[i] > 0) {
        assetAmounts[i] = IERC4626(vaults[i]).previewRedeem(shares[i]);
        totalAssets += assetAmounts[i];
      }
    }

    if (totalAssets == 0) revert InvalidAmount();
    uint256 balanceBefore = IERC20(dStable).balanceOf(address(this));

    // Execute withdrawals atomically
    for (uint256 i = 0; i < vaults.length; i++) {
      if (shares[i] > 0) {
        _withdrawSharesFromVaultAtomically(vaults[i], shares[i]);
      }
    }

    totalWithdrawn = IERC20(dStable).balanceOf(address(this)) - balanceBefore;
    IERC20(dStable).safeTransfer(msg.sender, totalWithdrawn);

    emit StrategyWithdrawalRouted(vaults, assetAmounts, totalWithdrawn);
    return totalWithdrawn;
  }

  // --- Rebalance/Exchange Functions ---

  function rebalanceStrategiesByShares(
    address fromStrategyShare,
    address toStrategyShare,
    uint256 fromShareAmount,
    uint256 minToShareAmount
  ) external onlyRole(STRATEGY_REBALANCER_ROLE) nonReentrant {
    _rebalanceStrategiesByShares(fromStrategyShare, toStrategyShare, fromShareAmount, minToShareAmount);
  }

  function _rebalanceStrategiesByShares(
    address fromStrategyShare,
    address toStrategyShare,
    uint256 fromShareAmount,
    uint256 minToShareAmount
  ) internal {
    address fromAdapterAddress = _strategyShareToAdapter[fromStrategyShare];
    address toAdapterAddress = _strategyShareToAdapter[toStrategyShare];
    if (fromAdapterAddress == address(0)) revert AdapterNotFound(fromStrategyShare);
    if (toAdapterAddress == address(0)) revert AdapterNotFound(toStrategyShare);

    IDStableConversionAdapterV2 fromAdapter = IDStableConversionAdapterV2(fromAdapterAddress);
    IDStableConversionAdapterV2 toAdapter = IDStableConversionAdapterV2(toAdapterAddress);

    uint256 dStableAmountEquivalent = fromAdapter.previewWithdrawFromStrategy(fromShareAmount);
    if (dStableAmountEquivalent <= dustTolerance) {
      return;
    }
    collateralVault.transferStrategyShares(fromStrategyShare, fromShareAmount, address(this));

    IERC20(fromStrategyShare).forceApprove(fromAdapterAddress, fromShareAmount);
    uint256 receivedDStable = fromAdapter.withdrawFromStrategy(fromShareAmount);
    IERC20(fromStrategyShare).forceApprove(fromAdapterAddress, 0);

    IERC20(dStable).forceApprove(toAdapterAddress, receivedDStable);
    (address actualToStrategyShare, uint256 resultingToShareAmount) = toAdapter.depositIntoStrategy(receivedDStable);
    if (actualToStrategyShare != toStrategyShare) {
      revert AdapterAssetMismatch(toAdapterAddress, toStrategyShare, actualToStrategyShare);
    }
    if (resultingToShareAmount < minToShareAmount) {
      revert SlippageCheckFailed(toStrategyShare, resultingToShareAmount, minToShareAmount);
    }
    IERC20(dStable).forceApprove(toAdapterAddress, 0);

    {
      uint256 previewValue = toAdapter.previewWithdrawFromStrategy(resultingToShareAmount);
      uint256 dustAdjusted = dStableAmountEquivalent > dustTolerance ? dStableAmountEquivalent - dustTolerance : 0;
      if (previewValue < dustAdjusted) {
        revert SlippageCheckFailed(dStable, previewValue, dustAdjusted);
      }
    }

    emit StrategySharesExchanged(
      fromStrategyShare,
      toStrategyShare,
      fromShareAmount,
      resultingToShareAmount,
      dStableAmountEquivalent,
      msg.sender
    );
  }

  function rebalanceStrategiesBySharesViaExternalLiquidity(
    address fromStrategyShare,
    address toStrategyShare,
    uint256 fromShareAmount,
    uint256 minToShareAmount
  ) external onlyRole(STRATEGY_REBALANCER_ROLE) nonReentrant {
    if (fromShareAmount == 0) revert ZeroInputDStableValue(fromStrategyShare, 0);
    if (fromStrategyShare == address(0) || toStrategyShare == address(0)) revert ZeroAddress();

    ExchangeLocals memory locals;
    locals.fromAdapterAddress = _strategyShareToAdapter[fromStrategyShare];
    locals.toAdapterAddress = _strategyShareToAdapter[toStrategyShare];

    if (locals.fromAdapterAddress == address(0)) revert AdapterNotFound(fromStrategyShare);
    if (locals.toAdapterAddress == address(0)) revert AdapterNotFound(toStrategyShare);

    locals.fromAdapter = IDStableConversionAdapterV2(locals.fromAdapterAddress);
    locals.toAdapter = IDStableConversionAdapterV2(locals.toAdapterAddress);

    locals.dStableValueIn = locals.fromAdapter.previewWithdrawFromStrategy(fromShareAmount);
    if (locals.dStableValueIn == 0) revert ZeroInputDStableValue(fromStrategyShare, fromShareAmount);

    (address expectedToShare, uint256 tmpToAmount) = locals.toAdapter.previewDepositIntoStrategy(locals.dStableValueIn);
    if (expectedToShare != toStrategyShare) revert AdapterAssetMismatch(locals.toAdapterAddress, toStrategyShare, expectedToShare);
    locals.calculatedToStrategyShareAmount = tmpToAmount;

    if (locals.calculatedToStrategyShareAmount < minToShareAmount) {
      revert SlippageCheckFailed(toStrategyShare, locals.calculatedToStrategyShareAmount, minToShareAmount);
    }

    collateralVault.transferStrategyShares(fromStrategyShare, fromShareAmount, address(this));
    IERC20(fromStrategyShare).forceApprove(locals.fromAdapterAddress, fromShareAmount);
    uint256 receivedDStable = locals.fromAdapter.withdrawFromStrategy(fromShareAmount);
    IERC20(fromStrategyShare).forceApprove(locals.fromAdapterAddress, 0);

    IERC20(dStable).forceApprove(locals.toAdapterAddress, receivedDStable);
    (address actualToStrategyShare, uint256 resultingToShareAmount) = locals.toAdapter.depositIntoStrategy(receivedDStable);
    if (actualToStrategyShare != toStrategyShare)
      revert AdapterAssetMismatch(locals.toAdapterAddress, toStrategyShare, actualToStrategyShare);

    // Validate actual conversion result by measuring the share shortfall in dStable units and comparing to tolerance
    if (resultingToShareAmount < minToShareAmount) {
      uint256 shareShortfall = minToShareAmount - resultingToShareAmount;
      uint256 shortfallValue = shareShortfall.mulDiv(
        locals.dStableValueIn,
        locals.calculatedToStrategyShareAmount,
        Math.Rounding.Ceil
      );

      if (shortfallValue > dustTolerance) {
        revert SlippageCheckFailed(toStrategyShare, resultingToShareAmount, minToShareAmount);
      }
    }

    IERC20(dStable).forceApprove(locals.toAdapterAddress, 0);

    emit StrategySharesExchanged(
      fromStrategyShare,
      toStrategyShare,
      fromShareAmount,
      resultingToShareAmount,
      locals.dStableValueIn,
      msg.sender
    );
  }

  function rebalanceStrategiesByValue(
    address fromVault,
    address toVault,
    uint256 amount,
    uint256 minToShareAmount
  ) external onlyRole(STRATEGY_REBALANCER_ROLE) nonReentrant {
    if (amount == 0) revert InvalidAmount();
    if (fromVault == toVault) revert InvalidVaultConfig();

    VaultConfig memory fromConfig = _getVaultConfig(fromVault);
    VaultConfig memory toConfig = _getVaultConfig(toVault);

    if (fromConfig.status != VaultStatus.Active || toConfig.status != VaultStatus.Active) {
      revert VaultNotActive(fromConfig.status == VaultStatus.Active ? toVault : fromVault);
    }

    if (!_isVaultHealthyForDeposits(toVault)) revert VaultNotActive(toVault);
    if (!_isVaultHealthyForWithdrawals(fromVault)) revert VaultNotActive(fromVault);

    uint256 requiredVaultAssetAmount = IERC4626(fromVault).previewWithdraw(amount);
    _rebalanceStrategiesByShares(fromVault, toVault, requiredVaultAssetAmount, minToShareAmount);

    emit StrategiesRebalanced(fromVault, toVault, amount, msg.sender);
  }

  // --- Adapter Management ---

  function addAdapter(address strategyShare, address adapterAddress) external onlyRole(ADAPTER_MANAGER_ROLE) {
    _addAdapter(strategyShare, adapterAddress);
  }

  function _addAdapter(address strategyShare, address adapterAddress) internal {
    if (adapterAddress == address(0) || strategyShare == address(0)) revert ZeroAddress();
    address adapterStrategyShare = IDStableConversionAdapterV2(adapterAddress).strategyShare();
    if (adapterStrategyShare != strategyShare) revert AdapterAssetMismatch(adapterAddress, strategyShare, adapterStrategyShare);
    if (_strategyShareToAdapter[strategyShare] != address(0) && _strategyShareToAdapter[strategyShare] != adapterAddress) {
      revert VaultAssetManagedByDifferentAdapter(strategyShare, _strategyShareToAdapter[strategyShare]);
    }
    _strategyShareToAdapter[strategyShare] = adapterAddress;

    try collateralVault.addSupportedStrategyShare(strategyShare) {} catch {}

    emit AdapterSet(strategyShare, adapterAddress);
  }

  function removeAdapter(address strategyShare) external onlyRole(ADAPTER_MANAGER_ROLE) {
    if (!_removeAdapter(strategyShare)) revert AdapterNotFound(strategyShare);
  }

  function _syncAdapter(address strategyShare, address adapterAddress) internal {
    address currentAdapter = _strategyShareToAdapter[strategyShare];
    if (currentAdapter == adapterAddress) {
      return;
    }

    if (currentAdapter != address(0)) {
      _removeAdapter(strategyShare);
    }

    _addAdapter(strategyShare, adapterAddress);
  }

  function setDefaultDepositStrategyShare(address strategyShare) external onlyRole(CONFIG_MANAGER_ROLE) {
    if (_strategyShareToAdapter[strategyShare] == address(0)) revert AdapterNotFound(strategyShare);
    defaultDepositStrategyShare = strategyShare;
    emit DefaultDepositStrategyShareSet(strategyShare);
  }

  function setDustTolerance(uint256 _dustTolerance) external onlyRole(CONFIG_MANAGER_ROLE) {
    dustTolerance = _dustTolerance;
    emit DustToleranceSet(_dustTolerance);
  }

  function sweepSurplus(uint256 maxAmount) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
    uint256 balance = IERC20(dStable).balanceOf(address(this));
    if (balance == 0) revert ZeroInputDStableValue(dStable, 0);

    uint256 amountToSweep = (maxAmount == 0 || maxAmount > balance) ? balance : maxAmount;
    address adapterAddress = _strategyShareToAdapter[defaultDepositStrategyShare];
    if (adapterAddress == address(0)) revert AdapterNotFound(defaultDepositStrategyShare);

    IDStableConversionAdapterV2 adapter = IDStableConversionAdapterV2(adapterAddress);
    address strategyShare = adapter.strategyShare();

    IERC20(dStable).forceApprove(adapterAddress, amountToSweep);
    (address mintedShare, ) = adapter.depositIntoStrategy(amountToSweep);
    if (mintedShare != strategyShare) revert AdapterAssetMismatch(adapterAddress, strategyShare, mintedShare);

    // Prevent residual allowances for the adapter regardless of token behaviour.
    IERC20(dStable).forceApprove(adapterAddress, 0);

    emit SurplusSwept(amountToSweep, mintedShare);
  }

  // --- Vault Configuration ---

  /**
   * @notice Replaces all vault configs and enforces total target allocations sum to 100%.
   * @dev This is the ONLY mutator that enforces the allocation-sum invariant on-chain.
   *      Reverts with `TotalAllocationInvalid(total)` if the sum of all provided `targetBps`
   *      is not exactly `BasisPointConstants.ONE_HUNDRED_PERCENT_BPS` (1,000,000 bps).
   *      Use this after operational changes (add/remove/pause) to restore precise targets.
   */
  function setVaultConfigs(VaultConfig[] calldata configs) external onlyRole(VAULT_MANAGER_ROLE) {
    uint256 totalTargetBps = 0;
    for (uint256 i = 0; i < configs.length; i++) {
      totalTargetBps += configs[i].targetBps;
    }
    if (totalTargetBps != BasisPointConstants.ONE_HUNDRED_PERCENT_BPS) {
      revert TotalAllocationInvalid(totalTargetBps);
    }

    _clearVaultConfigs();
    for (uint256 i = 0; i < configs.length; i++) {
      _addVaultConfig(configs[i]);
    }
  }

  /**
   * @notice Adds a vault configuration without enforcing total target-sum normalization.
   * @dev Does NOT validate that the sum of all targets equals 100%. This is intentional to
   *      allow emergency/operational changes. When totals differ from 100% across the active set:
   *      - Deposits/withdrawals still function; routing uses `targetBps` as-is (no normalization).
   *      - Behavior may become biased or perpetually chasing targets. Prefer calling
   *        `setVaultConfigs` afterward to restore a strict 100% total.
   */
  function addVaultConfig(VaultConfig calldata config) external onlyRole(VAULT_MANAGER_ROLE) {
    _addVaultConfig(config);
  }

  /**
   * @notice Adds a vault configuration without enforcing total target-sum normalization.
   * @dev See notes on the overload above. Intended for operational flexibility.
   */
  function addVaultConfig(address vault, address adapter, uint256 targetBps, VaultStatus status) external onlyRole(VAULT_MANAGER_ROLE) {
    _addVaultConfig(VaultConfig({ strategyVault: vault, adapter: adapter, targetBps: targetBps, status: status }));
  }

  /**
   * @notice Updates a vault configuration without enforcing total target-sum normalization.
   * @dev Does NOT enforce that the new overall total equals 100%. Safe to use during
   *      emergencies (e.g., temporarily setting a vault inactive). Consider following
   *      up with `setVaultConfigs` to re-establish an exact 100% layout.
   */
  function updateVaultConfig(VaultConfig calldata config) external onlyRole(VAULT_MANAGER_ROLE) {
    _updateVaultConfig(config);
  }

  /**
   * @notice Updates a vault configuration without enforcing total target-sum normalization.
   * @dev See notes on the overload above. Targets are used as-is by the router.
   */
  function updateVaultConfig(address vault, address adapter, uint256 targetBps, VaultStatus status) external onlyRole(VAULT_MANAGER_ROLE) {
    _updateVaultConfig(VaultConfig({ strategyVault: vault, adapter: adapter, targetBps: targetBps, status: status }));
  }

  /**
   * @notice Updates only the status of a vault configuration.
   * @dev Convenience helper for governance to quickly quarantine or reactivate vaults without
   *      needing to resupply adapter/target details.
   * @param vault Address of the vault to update.
   * @param status New status to set.
   */
  function setVaultStatus(address vault, VaultStatus status) external onlyRole(VAULT_MANAGER_ROLE) {
    if (!vaultExists[vault]) revert VaultNotFound(vault);
    uint256 index = vaultToIndex[vault];
    VaultConfig storage config = vaultConfigs[index];
    if (config.status == status) {
      return;
    }

    config.status = status;

    emit VaultConfigUpdated(config.strategyVault, config.adapter, config.targetBps, status);
  }

  /**
   * @notice Removes a vault configuration without rebalancing or normalizing targets.
   * @dev Does NOT enforce that the remaining targets sum to 100%. Routing continues to
   *      use the remaining `targetBps` values verbatim. For precise allocation behavior,
   *      call `setVaultConfigs` after removals to rebalance back to 100%.
   */
  function removeVault(address vault) external onlyRole(VAULT_MANAGER_ROLE) {
    if (!vaultExists[vault]) revert VaultNotFound(vault);
    _removeVault(vault);
  }

  /**
   * @notice Alias for removing a vault configuration (no allocation-sum enforcement).
   * @dev Identical behavior to `removeVault`. Totals may deviate from 100% after removal.
   *      This is acceptable for emergency operations. Prefer re-normalizing with
   *      `setVaultConfigs` when feasible.
   */
  function removeVaultConfig(address vault) external onlyRole(VAULT_MANAGER_ROLE) {
    if (!vaultExists[vault]) revert VaultNotFound(vault);
    _removeVault(vault);
  }

  /**
   * @notice Marks a vault inactive without altering its stored `targetBps`.
   * @dev This does NOT change totals or perform normalization. The inactive vault is
   *      excluded from routing decisions, and the active-set targets are used as-is.
   *      After emergencies, call `setVaultConfigs` if you require active targets to
   *      sum to exactly 100% again.
   */
  function emergencyPauseVault(address vault) external onlyRole(PAUSER_ROLE) {
    if (!vaultExists[vault]) revert VaultNotFound(vault);
    uint256 index = vaultToIndex[vault];
    vaultConfigs[index].status = VaultStatus.Suspended;
    emit VaultConfigUpdated(vault, vaultConfigs[index].adapter, vaultConfigs[index].targetBps, VaultStatus.Suspended);
  }

  function setMaxVaultCount(uint256 _maxVaultCount) external onlyRole(CONFIG_MANAGER_ROLE) {
    if (_maxVaultCount == 0 || _maxVaultCount < vaultConfigs.length) {
      revert InvalidMaxVaultCount(_maxVaultCount);
    }

    uint256 oldValue = maxVaultCount;
    maxVaultCount = _maxVaultCount;
    emit MaxVaultCountUpdated(oldValue, _maxVaultCount);
  }

  function setMaxRoutingAttempts(uint256 _maxRoutingAttempts) external onlyRole(CONFIG_MANAGER_ROLE) {
    if (_maxRoutingAttempts == 0 || _maxRoutingAttempts > maxVaultCount) {
      revert InvalidMaxRoutingAttempts(_maxRoutingAttempts);
    }

    uint256 oldValue = maxRoutingAttempts;
    maxRoutingAttempts = _maxRoutingAttempts;
    emit MaxRoutingAttemptsUpdated(oldValue, _maxRoutingAttempts);
  }

  function pause() external onlyRole(PAUSER_ROLE) {
    _pause();
  }

  function unpause() external onlyRole(PAUSER_ROLE) {
    _unpause();
  }

  // --- View Functions ---

  function getCurrentAllocations()
    external
    view
    returns (address[] memory vaults, uint256[] memory currentAllocations, uint256[] memory targetAllocations, uint256 totalBalance)
  {
    return _getAllVaultsAndAllocations();
  }

  function getVaultConfig(address vault) external view returns (VaultConfig memory config) {
    if (!vaultExists[vault]) revert VaultNotFound(vault);
    return vaultConfigs[vaultToIndex[vault]];
  }

  function getVaultCount() external view returns (uint256) {
    return vaultConfigs.length;
  }

  function isVaultHealthyForDeposits(address vault) external view returns (bool healthy) {
    return _isVaultHealthyForDeposits(vault);
  }

  function isVaultHealthyForWithdrawals(address vault) external view returns (bool healthy) {
    return _isVaultHealthyForWithdrawals(vault);
  }

  /**
   * @notice Returns strategy vaults that are active and healthy for deposits.
   * @dev Uses deposit health checks; does not guarantee suitability for withdrawals.
   *      Prefer explicitness over the old generic name to avoid ambiguity.
   */
  function getActiveVaultsForDeposits() external view returns (address[] memory activeVaults) {
    (activeVaults, , ) = _getActiveVaultsAndAllocations(OperationType.DEPOSIT);
  }

  /**
   * @notice Returns strategy vaults that are active and healthy for withdrawals.
   * @dev Uses withdrawal health checks; does not guarantee suitability for deposits.
   */
  function getActiveVaultsForWithdrawals() external view returns (address[] memory activeVaults) {
    (activeVaults, , ) = _getActiveVaultsAndAllocations(OperationType.WITHDRAWAL);
  }

  function setRetryGasConfig(uint256 minCallGas, uint256 completionReserve, uint256 overheadBuffer) external onlyRole(CONFIG_MANAGER_ROLE) {
    if (minCallGas == 0) revert InvalidRetryGasConfig();
    retryMinCallGas = minCallGas;
    retryCompletionReserve = completionReserve;
    retryOverheadBuffer = overheadBuffer;
    emit RetryGasConfigUpdated(minCallGas, completionReserve, overheadBuffer);
  }

  function getVaultConfigByIndex(uint256 index) external view returns (VaultConfig memory config) {
    if (index >= vaultConfigs.length) revert IndexOutOfBounds();
    return vaultConfigs[index];
  }

  function getMaxSingleVaultWithdraw() external view returns (uint256 maxAssets) {
    (address[] memory activeVaults, , ) = _getActiveVaultsAndAllocations(OperationType.WITHDRAWAL);

    for (uint256 i = 0; i < activeVaults.length; i++) {
      uint256 vaultBalance = _getVaultBalance(activeVaults[i]);
      if (vaultBalance > maxAssets) {
        maxAssets = vaultBalance;
      }
    }
  }

  // --- Internal Helpers ---

  function _computeRetryCallGas(uint256 attemptsRemaining) private view returns (uint256 callGas) {
    if (attemptsRemaining == 0) {
      return gasleft();
    }

    uint256 rawGasLeft = gasleft();
    if (rawGasLeft <= retryOverheadBuffer) {
      revert InsufficientRetryGas(rawGasLeft, retryOverheadBuffer + 1);
    }

    uint256 gasLeft = rawGasLeft - retryOverheadBuffer;
    uint256 required = (attemptsRemaining * retryMinCallGas) + retryCompletionReserve;
    if (gasLeft <= required) {
      revert InsufficientRetryGas(rawGasLeft, required + retryOverheadBuffer);
    }

    if (attemptsRemaining == 1) {
      callGas = gasLeft - retryCompletionReserve;
    } else {
      uint256 available = gasLeft - retryCompletionReserve;
      uint256 perAttempt = available / attemptsRemaining;
      if (perAttempt <= retryMinCallGas) {
        revert InsufficientRetryGas(rawGasLeft, required + retryOverheadBuffer);
      }
      callGas = perAttempt;
    }

    return callGas;
  }

  /**
   * @notice External wrapper for internal deposit logic used in retry mechanism
   * @dev External self-call wrapper used solely by the router's auto-routing loop. Rationale:
   *      - Enables try/catch around the adapter path to tolerate callee failures and fall back.
   *      - No explicit gas cap is applied; under EIP-150 the caller retains ~1/64 gas on callee
   *        failure, but a misbehaving callee can still consume most remaining gas.
   *      - Creates a new call frame (separate operand stack) but increases call depth; it does not
   *        prevent call-depth overflow. Internal state changes before the call still revert on failure.
   *      - Guarded via `require(msg.sender == address(this))` so only the router can invoke it.
   * @param vault Target vault for deposit
   * @param dStableAmount Amount to deposit
   */
  function _depositToVaultWithRetry(address vault, uint256 dStableAmount) external returns (uint256 actualShares) {
    if (msg.sender != address(this)) revert OnlySelfCallable();
    // This is called by this contract only, for auto-routing retries
    actualShares = _depositToVaultAtomically(vault, dStableAmount);
  }

  /**
   * @notice External wrapper for internal withdrawal logic used in retry mechanism.
   * @dev External self-call wrapper for the withdrawal retry path. Semantics mirror the deposit
   *      wrapper:
   *      - try/catch allows fallback on callee failures; no hard gas isolation (EIP-150 applies).
   *      - New call frame but increased call depth; does not avoid call-depth overflow.
   *      - Only callable by this contract via `require(msg.sender == address(this))`.
   * @param vault Target vault for withdrawal.
   * @param dStableAmount Gross dStable amount the router aims to obtain from the vault.
   * @return withdrawn The actual gross dStable amount obtained (must be ≥ `dStableAmount`).
   */
  function _withdrawFromVaultWithRetry(address vault, uint256 dStableAmount, bool allowSlippage) external returns (uint256 withdrawn) {
    if (msg.sender != address(this)) revert OnlySelfCallable();
    // This is called by this contract only, for auto-routing retries
    withdrawn = _withdrawFromVaultAtomically(vault, dStableAmount, allowSlippage);
  }

  function _depositToVaultAtomically(address vault, uint256 dStableAmount) internal returns (uint256 actualShares) {
    VaultConfig memory config = _getVaultConfig(vault);
    if (!_isVaultStatusEligible(config.status, OperationType.DEPOSIT)) {
      revert VaultNotActive(vault);
    }

    IDStableConversionAdapterV2 adapter = IDStableConversionAdapterV2(config.adapter);

    (address vaultExpected, uint256 expectedShares) = adapter.previewDepositIntoStrategy(dStableAmount);
    if (vaultExpected != vault) revert AdapterAssetMismatch(config.adapter, vault, vaultExpected);

    uint256 beforeBal = IERC20(vault).balanceOf(address(collateralVault));

    IERC20(dStable).forceApprove(config.adapter, dStableAmount);
    try adapter.depositIntoStrategy(dStableAmount) returns (address actualVault, uint256 reportedShares) {
      if (actualVault != vault) {
        revert AdapterAssetMismatch(config.adapter, vault, actualVault);
      }

      uint256 afterBal = IERC20(vault).balanceOf(address(collateralVault));
      actualShares = afterBal - beforeBal;

      if (actualShares < expectedShares) {
        revert SlippageCheckFailed(vault, actualShares, expectedShares);
      }

      if (actualShares != reportedShares) {
        revert AdapterSharesMismatch(actualShares, reportedShares);
      }

      emit RouterDeposit(config.adapter, vault, msg.sender, actualShares, dStableAmount);
    } catch {
      // Re-throw the error
      revert DepositConversionFailed(vault, dStableAmount);
    }

    IERC20(dStable).forceApprove(config.adapter, 0);
    return actualShares;
  }

  function _withdrawFromVaultAtomically(
    address vault,
    uint256 dStableAmount,
    bool allowSlippage
  ) internal returns (uint256 receivedDStable) {
    uint256 strategyShareAmount;
    address adapter;
    (receivedDStable, strategyShareAmount, adapter) = _withdrawFromVault(vault, dStableAmount, allowSlippage);
    if (receivedDStable == 0) revert NoLiquidityAvailable();

    IERC20(vault).forceApprove(adapter, 0);
    emit Withdrawn(vault, strategyShareAmount, receivedDStable, msg.sender, msg.sender);
    return receivedDStable;
  }

  function _withdrawSharesFromVaultAtomically(address vault, uint256 shares) internal {
    VaultConfig memory config = _getVaultConfig(vault);

    address adapter = config.adapter;
    IDStableConversionAdapterV2 conversionAdapter = IDStableConversionAdapterV2(adapter);

    uint256 availableShares = IERC20(vault).balanceOf(address(collateralVault));
    if (shares > availableShares) revert NoLiquidityAvailable();

    collateralVault.transferStrategyShares(vault, shares, address(this));
    IERC20(vault).forceApprove(adapter, shares);

    try conversionAdapter.withdrawFromStrategy(shares) returns (uint256 receivedDStable) {
      IERC20(vault).forceApprove(adapter, 0);
      emit Withdrawn(vault, shares, receivedDStable, msg.sender, msg.sender);
    } catch {
      // No cleanup needed before revert; state will roll back
      revert ShareWithdrawalConversionFailed();
    }
  }

  function _withdrawFromVault(
    address vault,
    uint256 dStableAmount,
    bool allowSlippage
  ) internal returns (uint256 receivedDStable, uint256 strategyShareAmount, address adapter) {
    VaultConfig memory config = _getVaultConfig(vault);
    if (!_isVaultStatusEligible(config.status, OperationType.WITHDRAWAL)) {
      revert VaultNotActive(vault);
    }
    adapter = config.adapter;
    IDStableConversionAdapterV2 conversionAdapter = IDStableConversionAdapterV2(adapter);

    // Use the vault's direct preview without slippage discount for planning
    // The adapter's preview includes slippage which is for conservative estimation only
    strategyShareAmount = IERC4626(vault).previewWithdraw(dStableAmount);
    if (strategyShareAmount == 0) revert ZeroPreviewWithdrawAmount(vault);

    uint256 availableShares = IERC20(vault).balanceOf(address(collateralVault));
    if (strategyShareAmount > availableShares) {
      // Don't silently truncate - revert if insufficient shares
      revert NoLiquidityAvailable();
    }

    if (strategyShareAmount == 0) {
      return (0, 0, adapter);
    }

    collateralVault.transferStrategyShares(vault, strategyShareAmount, address(this));
    IERC20(vault).forceApprove(adapter, strategyShareAmount);

    uint256 minAcceptable = dStableAmount;
    if (allowSlippage) {
      try conversionAdapter.previewWithdrawFromStrategy(strategyShareAmount) returns (uint256 conservativeAmount) {
        if (conservativeAmount > 0 && conservativeAmount < minAcceptable) {
          minAcceptable = conservativeAmount;
        }
      } catch {
        // If preview fails, fall back to requiring the full amount
        minAcceptable = dStableAmount;
      }
    }

    try conversionAdapter.withdrawFromStrategy(strategyShareAmount) returns (uint256 converted) {
      receivedDStable = converted;
      // Verify we received at least what was requested (respecting slippage allowance if enabled)
      uint256 requiredAmount = allowSlippage ? minAcceptable : dStableAmount;
      if (receivedDStable < requiredAmount) {
        if (!allowSlippage) {
          // No cleanup needed before revert; state will roll back
          revert SlippageCheckFailed(vault, receivedDStable, requiredAmount);
        }
        // allowSlippage == true: accept the shortfall to avoid user-facing reverts
      }
    } catch {
      // If conversion fails (e.g., due to slippage/fees), clean up and return 0
      // This allows the withdrawal plan to continue with other vaults
      IERC20(vault).forceApprove(adapter, 0);
      IERC20(vault).safeTransfer(address(collateralVault), strategyShareAmount);
      return (0, 0, adapter);
    }
  }

  function _getActiveVaultsAndAllocations(
    OperationType operationType
  ) internal view returns (address[] memory activeVaults, uint256[] memory currentAllocations, uint256[] memory targetAllocations) {
    uint256 activeCount = 0;
    for (uint256 i = 0; i < vaultConfigs.length; i++) {
      VaultConfig memory config = vaultConfigs[i];
      if (!_isVaultEligibleForOperation(config, operationType)) continue;
      if (!_isVaultHealthyForOperation(config.strategyVault, operationType)) continue;
      activeCount++;
    }

    if (activeCount == 0) return (new address[](0), new uint256[](0), new uint256[](0));

    activeVaults = new address[](activeCount);
    uint256[] memory balances = new uint256[](activeCount);
    targetAllocations = new uint256[](activeCount);

    uint256 activeIndex = 0;
    for (uint256 i = 0; i < vaultConfigs.length; i++) {
      VaultConfig memory config = vaultConfigs[i];
      if (!_isVaultEligibleForOperation(config, operationType)) continue;
      if (!_isVaultHealthyForOperation(config.strategyVault, operationType)) continue;

      activeVaults[activeIndex] = config.strategyVault;
      balances[activeIndex] = _getVaultBalance(config.strategyVault);
      targetAllocations[activeIndex] = config.targetBps;
      activeIndex++;
    }

    (currentAllocations, ) = AllocationCalculator.calculateCurrentAllocations(balances);
    return (activeVaults, currentAllocations, targetAllocations);
  }

  function _isVaultEligibleForOperation(VaultConfig memory config, OperationType operationType) internal pure returns (bool) {
    if (!_isVaultStatusEligible(config.status, operationType)) {
      return false;
    }

    if (operationType == OperationType.DEPOSIT && config.targetBps == 0) {
      return false;
    }

    return true;
  }

  function _isVaultStatusEligible(VaultStatus status, OperationType operationType) internal pure returns (bool) {
    if (operationType == OperationType.DEPOSIT) {
      return status == VaultStatus.Active;
    }

    return status == VaultStatus.Active || status == VaultStatus.Impaired;
  }

  function _getAllVaultsAndAllocations()
    internal
    view
    returns (address[] memory vaults, uint256[] memory currentAllocations, uint256[] memory targetAllocations, uint256 totalBalance)
  {
    uint256 vaultCount = vaultConfigs.length;
    vaults = new address[](vaultCount);
    uint256[] memory balances = new uint256[](vaultCount);
    targetAllocations = new uint256[](vaultCount);

    for (uint256 i = 0; i < vaultCount; i++) {
      VaultConfig memory config = vaultConfigs[i];
      vaults[i] = config.strategyVault;
      balances[i] = _getVaultBalance(config.strategyVault);
      targetAllocations[i] = config.targetBps;
    }

    (currentAllocations, totalBalance) = AllocationCalculator.calculateCurrentAllocations(balances);
  }

  function _getVaultBalance(address vault) internal view returns (uint256 balance) {
    return _getVaultBalanceWithAdapter(vault, address(0));
  }

  function _getVaultBalanceWithAdapter(address vault, address adapter) internal view returns (uint256 balance) {
    try IERC20(vault).balanceOf(address(collateralVault)) returns (uint256 shares) {
      if (shares == 0) return 0;

      if (adapter == address(0)) {
        adapter = _strategyShareToAdapter[vault];
      }
      if (adapter == address(0)) return 0;

      try IDStableConversionAdapterV2(adapter).strategyShareValueInDStable(vault, shares) returns (uint256 value) {
        return value;
      } catch {
        return 0;
      }
    } catch {
      return 0;
    }
  }

  function _getVaultConfig(address vault) internal view returns (VaultConfig memory config) {
    if (!vaultExists[vault]) revert VaultNotFound(vault);
    return vaultConfigs[vaultToIndex[vault]];
  }

  function _isVaultHealthyForOperation(address vault, OperationType operationType) internal view returns (bool healthy) {
    if (operationType == OperationType.DEPOSIT) {
      return _isVaultHealthyForDeposits(vault);
    } else {
      return _isVaultHealthyForWithdrawals(vault);
    }
  }

  function _isVaultHealthyForDeposits(address vault) internal view returns (bool healthy) {
    try IERC4626(vault).totalAssets() returns (uint256) {
      try IERC4626(vault).previewDeposit(1e18) returns (uint256 shares) {
        return shares > 0;
      } catch {
        return false;
      }
    } catch {
      return false;
    }
  }

  function _isVaultHealthyForWithdrawals(address vault) internal view returns (bool healthy) {
    try IERC4626(vault).totalAssets() returns (uint256) {
      uint256 vaultShares = IERC20(vault).balanceOf(address(collateralVault));
      if (vaultShares == 0) return false;

      try IERC4626(vault).previewRedeem(vaultShares) returns (uint256 assets) {
        return assets > 0;
      } catch {
        return false;
      }
    } catch {
      return false;
    }
  }

  function _totalSystemLiquidity(address[] memory activeVaults) internal view returns (uint256 totalLiquidity) {
    for (uint256 i = 0; i < activeVaults.length; i++) {
      uint256 vaultShares = IERC20(activeVaults[i]).balanceOf(address(collateralVault));
      if (vaultShares == 0) continue;
      try IERC4626(activeVaults[i]).previewRedeem(vaultShares) returns (uint256 assets) {
        totalLiquidity += assets;
      } catch {}
    }
  }

  function _addVaultConfig(VaultConfig memory config) internal {
    if (config.strategyVault == address(0) || config.adapter == address(0)) revert ZeroAddress();
    if (vaultExists[config.strategyVault]) revert VaultAlreadyExists(config.strategyVault);
    if (vaultConfigs.length >= maxVaultCount) revert InvalidVaultConfig();

    uint256 index = vaultConfigs.length;
    vaultConfigs.push(config);
    vaultToIndex[config.strategyVault] = index;
    vaultExists[config.strategyVault] = true;

    _syncAdapter(config.strategyVault, config.adapter);

    emit VaultConfigAdded(config.strategyVault, config.adapter, config.targetBps, config.status);
  }

  function _updateVaultConfig(VaultConfig memory config) internal {
    if (!vaultExists[config.strategyVault]) revert VaultNotFound(config.strategyVault);

    uint256 index = vaultToIndex[config.strategyVault];
    vaultConfigs[index] = config;

    _syncAdapter(config.strategyVault, config.adapter);

    emit VaultConfigUpdated(config.strategyVault, config.adapter, config.targetBps, config.status);
  }

  function _removeVault(address vault) internal {
    uint256 indexToRemove = vaultToIndex[vault];
    uint256 lastIndex = vaultConfigs.length - 1;

    if (indexToRemove != lastIndex) {
      VaultConfig memory lastConfig = vaultConfigs[lastIndex];
      vaultConfigs[indexToRemove] = lastConfig;
      vaultToIndex[lastConfig.strategyVault] = indexToRemove;
    }

    vaultConfigs.pop();
    delete vaultToIndex[vault];
    delete vaultExists[vault];

    if (_strategyShareToAdapter[vault] != address(0)) {
      _removeAdapter(vault);
    }

    emit VaultConfigRemoved(vault);
  }

  function _clearVaultConfigs() internal {
    for (uint256 i = 0; i < vaultConfigs.length; i++) {
      address vault = vaultConfigs[i].strategyVault;
      delete vaultToIndex[vault];
      delete vaultExists[vault];
      _removeAdapter(vault);
    }
    delete vaultConfigs;
  }

  function _removeAdapter(address strategyShare) internal returns (bool removed) {
    address adapterAddress = _strategyShareToAdapter[strategyShare];
    if (adapterAddress == address(0)) {
      return false;
    }

    delete _strategyShareToAdapter[strategyShare];

    // Preserve valuation coverage when collateral is still held by keeping the share registered.
    if (IERC20(strategyShare).balanceOf(address(collateralVault)) == 0) {
      try collateralVault.removeSupportedStrategyShare(strategyShare) {} catch {}
    }

    emit AdapterRemoved(strategyShare, adapterAddress);
    return true;
  }
}
