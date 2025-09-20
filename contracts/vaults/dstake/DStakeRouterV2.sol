// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";

import { IDStakeRouterV2 } from "./interfaces/IDStakeRouterV2.sol";
import { IDStableConversionAdapterV2 } from "./interfaces/IDStableConversionAdapterV2.sol";
import { IDStakeCollateralVaultV2 } from "./interfaces/IDStakeCollateralVaultV2.sol";
import { DeterministicVaultSelector } from "./libraries/DeterministicVaultSelector.sol";
import { AllocationCalculator } from "./libraries/AllocationCalculator.sol";
import { BasisPointConstants } from "../../common/BasisPointConstants.sol";

/**
 * @title DStakeRouterV2
 * @notice Unified router that supports deterministic, multi-vault routing for deposits and withdrawals.
 * @dev Extends the original single-vault router with allocation-aware selection, vault governance tooling,
 *      and shared buffer logic for adapter conversions.
 */
contract DStakeRouterV2 is IDStakeRouterV2, AccessControl, ReentrancyGuard, Pausable {
  using SafeERC20 for IERC20;
  using AllocationCalculator for uint256[];

  // --- Errors ---
  error ZeroAddress();
  error AdapterNotFound(address strategyShare);
  error ZeroPreviewWithdrawAmount(address strategyShare);
  error InsufficientDStableFromAdapter(address strategyShare, uint256 expected, uint256 actual);
  error VaultAssetManagedByDifferentAdapter(address strategyShare, address existingAdapter);
  error ZeroInputDStableValue(address fromAsset, uint256 fromAmount);
  error AdapterAssetMismatch(address adapter, address expectedAsset, address actualAsset);
  error SlippageCheckFailed(address asset, uint256 actualAmount, uint256 requiredAmount);
  error InconsistentState(string message);
  error DepositConversionFailed(address vault, uint256 amount);
  error InvalidAmount();
  error InvalidVaultConfig();
  error VaultNotActive(address vault);
  error InsufficientActiveVaults();
  error TargetAllocationsMismatch();
  error VaultAlreadyExists(address vault);
  error InvalidTargetAllocation(uint256 target);
  error TotalAllocationInvalid(uint256 total);
  error NoLiquidityAvailable();
  error AllVaultsPaused();
  error InvalidMaxVaultCount(uint256 count);
  error VaultMustHaveZeroAllocation(address vault, uint256 currentAllocation);
  error RoutingCapacityExceeded(uint256 requested, uint256 fulfilled, uint256 vaultLimit);
  error EmptyArrays();
  error ArrayLengthMismatch();

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

  mapping(address => address) private _strategyShareToAdapter;
  address public defaultDepositStrategyShare;

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

  struct VaultConfig {
    address strategyVault;
    address adapter;
    uint256 targetBps;
    bool isActive;
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
  event SurplusHeld(uint256 amount);
  event SurplusSwept(uint256 amount, address vaultAsset);
  event ShortfallCovered(uint256 amount);
  event StrategyDepositRouted(address[] selectedVaults, uint256[] depositAmounts, uint256 totalDStableAmount, uint256 randomSeed);
  event StrategyWithdrawalRouted(address[] selectedVaults, uint256[] withdrawalAmounts, uint256 totalDStableAmount, uint256 randomSeed);
  event VaultConfigAdded(address indexed vault, address indexed adapter, uint256 targetBps);
  event VaultConfigUpdated(address indexed vault, address indexed adapter, uint256 targetBps, bool isActive);
  event VaultConfigRemoved(address indexed vault);
  event StrategiesRebalanced(address indexed fromVault, address indexed toVault, uint256 amount, address indexed initiator);
  event MaxVaultCountUpdated(uint256 oldCount, uint256 newCount);

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
    (address[] memory sortedVaults, ) = DeterministicVaultSelector.selectTopUnderallocated(
      activeVaults,
      currentAllocations,
      targetAllocations,
      activeVaults.length
    );

    IERC20(dStable).safeTransferFrom(msg.sender, address(this), dStableAmount);

    // Try vaults in allocation-aware order until one succeeds
    // This maintains balance across vaults according to target allocations
    for (uint256 i = 0; i < sortedVaults.length; i++) {
      address targetVault = sortedVaults[i];
      
      /**
       * @dev Uses external call for gas isolation and comprehensive error boundary.
       * This ensures that gas-greedy or failing adapters don't prevent fallback
       * to other vaults. The external call is protected by nonReentrant modifier
       * and only accepts calls from this contract address. Benefits:
       * - Gas limit isolation: Failed vault operations don't consume all available gas
       * - Complete exception boundary: Catches ALL failure modes (reverts, OOG, stack overflow)
       * - Stack depth reset: Prevents overflow in complex adapter call chains
       * - Graceful degradation: System remains functional even with problematic adapters
       */
      try this._depositToVaultWithRetry(targetVault, dStableAmount) {
        // Success - emit event and return
        address[] memory vaultArray = new address[](1);
        uint256[] memory amountArray = new uint256[](1);
        vaultArray[0] = targetVault;
        amountArray[0] = dStableAmount;
        emit StrategyDepositRouted(vaultArray, amountArray, dStableAmount, 0);
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

  function withdraw(uint256 dStableAmount)
    external
    override
    onlyRole(DSTAKE_TOKEN_ROLE)
    nonReentrant
    whenNotPaused
    returns (uint256 totalWithdrawn)
  {
    if (dStableAmount == 0) revert InvalidAmount();

    (
      address[] memory activeVaults,
      uint256[] memory currentAllocations,
      uint256[] memory targetAllocations
    ) = _getActiveVaultsAndAllocations(OperationType.WITHDRAWAL);

    if (activeVaults.length == 0) revert InsufficientActiveVaults();

    // Get vaults sorted by over-allocation (most over-allocated first)
    // Prioritizes over-allocated vaults to rebalance the system
    (address[] memory sortedVaults, ) = DeterministicVaultSelector.selectTopOverallocated(
      activeVaults,
      currentAllocations,
      targetAllocations,
      activeVaults.length
    );

    // Try vaults in allocation-aware order until one succeeds
    for (uint256 i = 0; i < sortedVaults.length; i++) {
      address targetVault = sortedVaults[i];
      
      /**
       * @dev Uses external call for gas isolation and comprehensive error boundary.
       * Similar to deposit logic, this pattern ensures robust fallback behavior
       * when withdrawing from multiple vaults. Protected by nonReentrant modifier.
       */
      try this._withdrawFromVaultWithRetry(targetVault, dStableAmount, false) returns (uint256 withdrawnAmount) {
        IERC20(dStable).safeTransfer(msg.sender, withdrawnAmount);

        address[] memory vaultArray = new address[](1);
        uint256[] memory amountArray = new uint256[](1);
        vaultArray[0] = targetVault;
        amountArray[0] = withdrawnAmount;

        emit StrategyWithdrawalRouted(vaultArray, amountArray, withdrawnAmount, 0);
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

    emit StrategyDepositRouted(vaults, assets, totalAssets, 0);
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
        if (!config.isActive) revert VaultNotActive(vaults[i]);

        // Use previewMint to determine assets needed to mint the desired shares
        uint256 assetsNeeded = IERC4626(vaults[i]).previewMint(shares[i]);
        assetAmounts[i] = assetsNeeded;
        totalAssets += assetsNeeded;
      }
    }

    if (totalAssets == 0) revert InvalidAmount();
    IERC20(dStable).safeTransferFrom(msg.sender, address(this), totalAssets);

    // Execute deposits through adapters to get exact shares
    uint256[] memory sharesReceived = new uint256[](vaults.length);
    for (uint256 i = 0; i < vaults.length; i++) {
      if (shares[i] > 0) {
        // Use adapter to deposit the required assets
        // Adapter will handle the conversion and ensure we get the shares
        _depositToVaultAtomically(vaults[i], assetAmounts[i]);
        sharesReceived[i] = shares[i]; // We deposited the amount needed for these shares
      }
    }

    emit StrategyDepositRouted(vaults, assetAmounts, totalAssets, 0);
  }

  function solverWithdrawAssets(address[] calldata vaults, uint256[] calldata assets)
    external
    onlyRole(DSTAKE_TOKEN_ROLE)
    nonReentrant
    whenNotPaused
    returns (uint256 totalWithdrawn)
  {
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

    emit StrategyWithdrawalRouted(vaults, assets, totalWithdrawn, 0);
    return totalWithdrawn;
  }

  function solverWithdrawShares(address[] calldata vaults, uint256[] calldata shares)
    external
    onlyRole(DSTAKE_TOKEN_ROLE)
    nonReentrant
    whenNotPaused
    returns (uint256 totalWithdrawn)
  {
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

    emit StrategyWithdrawalRouted(vaults, assetAmounts, totalWithdrawn, 0);
    return totalWithdrawn;
  }

  // --- Exchange Functions ---

  function exchangeStrategySharesInternal(
    address fromStrategyShare,
    address toStrategyShare,
    uint256 fromShareAmount,
    uint256 minToShareAmount
  ) external onlyRole(STRATEGY_REBALANCER_ROLE) nonReentrant {
    _exchangeStrategyShares(fromStrategyShare, toStrategyShare, fromShareAmount, minToShareAmount);
  }

  function _exchangeStrategyShares(
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
    collateralVault.transferStrategyShares(fromStrategyShare, fromShareAmount, address(this));

    IERC20(fromStrategyShare).forceApprove(fromAdapterAddress, fromShareAmount);
    uint256 receivedDStable = fromAdapter.withdrawFromStrategy(fromShareAmount);

    IERC20(dStable).forceApprove(toAdapterAddress, receivedDStable);
    (address actualToStrategyShare, uint256 resultingToShareAmount) = toAdapter.depositIntoStrategy(receivedDStable);
    if (actualToStrategyShare != toStrategyShare) {
      revert AdapterAssetMismatch(toAdapterAddress, toStrategyShare, actualToStrategyShare);
    }
    if (resultingToShareAmount < minToShareAmount) {
      revert SlippageCheckFailed(toStrategyShare, resultingToShareAmount, minToShareAmount);
    }

    {
      uint256 previewValue = toAdapter.previewWithdrawFromStrategy(resultingToShareAmount);
      uint256 minRequired = dStableAmountEquivalent - dustTolerance;
      if (previewValue < minRequired) {
        revert SlippageCheckFailed(dStable, previewValue, minRequired);
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

  function swapStrategySharesWithOperator(
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

    IERC20(fromStrategyShare).safeTransferFrom(msg.sender, address(this), fromShareAmount);
    IERC20(fromStrategyShare).forceApprove(locals.fromAdapterAddress, fromShareAmount);
    uint256 receivedDStable = locals.fromAdapter.withdrawFromStrategy(fromShareAmount);

    IERC20(dStable).forceApprove(locals.toAdapterAddress, receivedDStable);
    (address actualToStrategyShare, uint256 resultingToShareAmount) = locals.toAdapter.depositIntoStrategy(receivedDStable);
    if (actualToStrategyShare != toStrategyShare)
      revert AdapterAssetMismatch(locals.toAdapterAddress, toStrategyShare, actualToStrategyShare);

    // Validate that actual conversion result meets minimum requirements (allowing for dust tolerance)
    uint256 minRequiredWithDust = minToShareAmount > dustTolerance ? minToShareAmount - dustTolerance : 0;
    if (resultingToShareAmount < minRequiredWithDust) {
      revert SlippageCheckFailed(toStrategyShare, resultingToShareAmount, minToShareAmount);
    }

    // Only transfer shares to operator after actual conversion is complete and validated
    collateralVault.transferStrategyShares(toStrategyShare, resultingToShareAmount, msg.sender);

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

    if (!fromConfig.isActive || !toConfig.isActive) {
      revert VaultNotActive(fromConfig.isActive ? toVault : fromVault);
    }

    if (!_isVaultHealthyForDeposits(toVault)) revert VaultNotActive(toVault);
    if (!_isVaultHealthyForWithdrawals(fromVault)) revert VaultNotActive(fromVault);

    uint256 requiredVaultAssetAmount = IERC4626(fromVault).previewWithdraw(amount);
    _exchangeStrategyShares(fromVault, toVault, requiredVaultAssetAmount, minToShareAmount);

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

    IERC20(dStable).approve(adapterAddress, amountToSweep);
    (address mintedShare, ) = adapter.depositIntoStrategy(amountToSweep);
    if (mintedShare != strategyShare) revert AdapterAssetMismatch(adapterAddress, strategyShare, mintedShare);

    emit SurplusSwept(amountToSweep, mintedShare);
  }

  // --- Vault Configuration ---

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

  function addVaultConfig(VaultConfig calldata config) external onlyRole(VAULT_MANAGER_ROLE) {
    _addVaultConfig(config);
  }

  function addVaultConfig(address vault, address adapter, uint256 targetBps, bool isActive) external onlyRole(VAULT_MANAGER_ROLE) {
    _addVaultConfig(VaultConfig({ strategyVault: vault, adapter: adapter, targetBps: targetBps, isActive: isActive }));
  }

  function updateVaultConfig(VaultConfig calldata config) external onlyRole(VAULT_MANAGER_ROLE) {
    _updateVaultConfig(config);
  }

  function updateVaultConfig(address vault, address adapter, uint256 targetBps, bool isActive) external onlyRole(VAULT_MANAGER_ROLE) {
    _updateVaultConfig(VaultConfig({ strategyVault: vault, adapter: adapter, targetBps: targetBps, isActive: isActive }));
  }

  function removeVault(address vault) external onlyRole(VAULT_MANAGER_ROLE) {
    if (!vaultExists[vault]) revert AdapterNotFound(vault);
    _removeVault(vault);
  }

  function removeVaultConfig(address vault) external onlyRole(VAULT_MANAGER_ROLE) {
    if (!vaultExists[vault]) revert AdapterNotFound(vault);
    _removeVault(vault);
  }

  function emergencyPauseVault(address vault) external onlyRole(PAUSER_ROLE) {
    if (!vaultExists[vault]) revert AdapterNotFound(vault);
    uint256 index = vaultToIndex[vault];
    vaultConfigs[index].isActive = false;
    emit VaultConfigUpdated(vault, vaultConfigs[index].adapter, vaultConfigs[index].targetBps, false);
  }

  function setMaxVaultCount(uint256 _maxVaultCount) external onlyRole(CONFIG_MANAGER_ROLE) {
    if (_maxVaultCount == 0 || _maxVaultCount < vaultConfigs.length) {
      revert InvalidMaxVaultCount(_maxVaultCount);
    }

    uint256 oldValue = maxVaultCount;
    maxVaultCount = _maxVaultCount;
    emit MaxVaultCountUpdated(oldValue, _maxVaultCount);
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
    if (!vaultExists[vault]) revert AdapterNotFound(vault);
    return vaultConfigs[vaultToIndex[vault]];
  }

  function getVaultCount() external view returns (uint256) {
    return vaultConfigs.length;
  }

  function isVaultHealthy(address vault) external view returns (bool healthy) {
    return _isVaultHealthyForDeposits(vault);
  }

  function isVaultHealthyForDeposits(address vault) external view returns (bool healthy) {
    return _isVaultHealthyForDeposits(vault);
  }

  function isVaultHealthyForWithdrawals(address vault) external view returns (bool healthy) {
    return _isVaultHealthyForWithdrawals(vault);
  }

  function getActiveVaults() external view returns (address[] memory activeVaults) {
    (activeVaults, , ) = _getActiveVaultsAndAllocations(OperationType.DEPOSIT);
  }

  function getVaultConfigByIndex(uint256 index) external view returns (VaultConfig memory config) {
    require(index < vaultConfigs.length, "Index out of bounds");
    return vaultConfigs[index];
  }

  function validateTotalAllocations() external view returns (bool isValid, uint256 totalBps) {
    for (uint256 i = 0; i < vaultConfigs.length; i++) {
      totalBps += vaultConfigs[i].targetBps;
    }
    isValid = (totalBps == BasisPointConstants.ONE_HUNDRED_PERCENT_BPS);
  }

  // --- Internal Helpers ---

  /**
   * @notice External wrapper for internal deposit logic used in retry mechanism
   * @dev This function is intentionally external to provide gas isolation and comprehensive
   *      error boundary for the auto-routing fallback system. It can only be called by
   *      this contract itself to prevent unauthorized access while enabling the benefits
   *      of external call error handling.
   * @param vault Target vault for deposit
   * @param dStableAmount Amount to deposit
   */
  function _depositToVaultWithRetry(address vault, uint256 dStableAmount) external {
    require(msg.sender == address(this), "Only self-callable");
    // This is called by this contract only, for auto-routing retries
    _depositToVaultAtomically(vault, dStableAmount);
  }

  /**
   * @notice External wrapper for internal withdrawal logic used in retry mechanism.
   * @dev Similar to the deposit retry function, this provides gas isolation for withdrawal
   *      fallback operations. Only callable by this contract itself.
   * @param vault Target vault for withdrawal.
   * @param dStableAmount Gross dStable amount the router aims to obtain from the vault.
   * @return withdrawn The actual gross dStable amount obtained (must be ≥ `dStableAmount`).
   */
  function _withdrawFromVaultWithRetry(address vault, uint256 dStableAmount, bool allowSlippage)
    external
    returns (uint256 withdrawn)
  {
    require(msg.sender == address(this), "Only self-callable");
    // This is called by this contract only, for auto-routing retries
    withdrawn = _withdrawFromVaultAtomically(vault, dStableAmount, allowSlippage);
  }

  function _depositToVaultAtomically(address vault, uint256 dStableAmount) internal {
    VaultConfig memory config = _getVaultConfig(vault);
    if (!config.isActive) revert VaultNotActive(vault);

    IDStableConversionAdapterV2 adapter = IDStableConversionAdapterV2(config.adapter);

    (address vaultExpected, uint256 expectedShares) = adapter.previewDepositIntoStrategy(dStableAmount);
    if (vaultExpected != vault) revert AdapterAssetMismatch(config.adapter, vault, vaultExpected);

    uint256 beforeBal = IERC20(vault).balanceOf(address(collateralVault));

    IERC20(dStable).forceApprove(config.adapter, dStableAmount);
    try adapter.depositIntoStrategy(dStableAmount) returns (address actualVault, uint256 reportedShares) {
      if (actualVault != vault) {
        IERC20(dStable).forceApprove(config.adapter, 0);
        revert AdapterAssetMismatch(config.adapter, vault, actualVault);
      }

      uint256 afterBal = IERC20(vault).balanceOf(address(collateralVault));
      uint256 actualShares = afterBal - beforeBal;

      if (actualShares < expectedShares) {
        IERC20(dStable).forceApprove(config.adapter, 0);
        revert SlippageCheckFailed(vault, actualShares, expectedShares);
      }

      if (actualShares != reportedShares) {
        IERC20(dStable).forceApprove(config.adapter, 0);
        revert InconsistentState("Adapter mis-reported shares");
      }

      emit RouterDeposit(config.adapter, vault, msg.sender, actualShares, dStableAmount);
    } catch {
      IERC20(dStable).forceApprove(config.adapter, 0);
      // Re-throw the error
      revert DepositConversionFailed(vault, dStableAmount);
    }

    IERC20(dStable).forceApprove(config.adapter, 0);
  }

  function _withdrawFromVaultAtomically(address vault, uint256 dStableAmount, bool allowSlippage)
    internal
    returns (uint256 receivedDStable)
  {
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
    if (!config.isActive) revert VaultNotActive(vault);

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
      IERC20(vault).forceApprove(adapter, 0);
      // Return the shares to the collateral vault
      IERC20(vault).safeTransfer(address(collateralVault), shares);
      revert InconsistentState("Share withdrawal conversion failed");
    }
  }

  // Multi-vault planning helpers removed in favor of solver mode and simplified auto-routing

  function _withdrawFromVault(
    address vault,
    uint256 dStableAmount,
    bool allowSlippage
  ) internal returns (uint256 receivedDStable, uint256 strategyShareAmount, address adapter) {
    VaultConfig memory config = _getVaultConfig(vault);
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
          IERC20(vault).forceApprove(adapter, 0);
          IERC20(vault).safeTransfer(address(collateralVault), strategyShareAmount);
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
      if (vaultConfigs[i].isActive && _isVaultHealthyForOperation(vaultConfigs[i].strategyVault, operationType)) {
        activeCount++;
      }
    }

    if (activeCount == 0) return (new address[](0), new uint256[](0), new uint256[](0));

    activeVaults = new address[](activeCount);
    uint256[] memory balances = new uint256[](activeCount);
    targetAllocations = new uint256[](activeCount);

    uint256 activeIndex = 0;
    for (uint256 i = 0; i < vaultConfigs.length; i++) {
      VaultConfig memory config = vaultConfigs[i];
      if (config.isActive && _isVaultHealthyForOperation(config.strategyVault, operationType)) {
        activeVaults[activeIndex] = config.strategyVault;
        balances[activeIndex] = _getVaultBalance(config.strategyVault);
        targetAllocations[activeIndex] = config.targetBps;
        activeIndex++;
      }
    }

    (currentAllocations, ) = AllocationCalculator.calculateCurrentAllocations(balances);
    return (activeVaults, currentAllocations, targetAllocations);
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
    if (!vaultExists[vault]) revert AdapterNotFound(vault);
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

    if (config.isActive) {
      _addAdapter(config.strategyVault, config.adapter);
    }

    emit VaultConfigAdded(config.strategyVault, config.adapter, config.targetBps);
  }

  function _updateVaultConfig(VaultConfig memory config) internal {
    if (!vaultExists[config.strategyVault]) revert AdapterNotFound(config.strategyVault);

    uint256 index = vaultToIndex[config.strategyVault];
    vaultConfigs[index] = config;

    if (config.isActive) {
      _addAdapter(config.strategyVault, config.adapter);
    } else {
      _removeAdapter(config.strategyVault);
    }

    emit VaultConfigUpdated(config.strategyVault, config.adapter, config.targetBps, config.isActive);
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

    try collateralVault.removeSupportedStrategyShare(strategyShare) {} catch {}

    emit AdapterRemoved(strategyShare, adapterAddress);
    return true;
  }
}
