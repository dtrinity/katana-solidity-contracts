// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";

import { IDStakeRouter } from "./interfaces/IDStakeRouter.sol";
import { IDStableConversionAdapter } from "./interfaces/IDStableConversionAdapter.sol";
import { IDStakeCollateralVault } from "./interfaces/IDStakeCollateralVault.sol";
import { DeterministicVaultSelector } from "./libraries/DeterministicVaultSelector.sol";
import { AllocationCalculator } from "./libraries/AllocationCalculator.sol";
import { BasisPointConstants } from "../../common/BasisPointConstants.sol";

/**
 * @title DStakeRouterV2
 * @notice Unified router that supports deterministic, multi-vault routing for deposits and withdrawals.
 * @dev Extends the original single-vault router with allocation-aware selection, vault governance tooling,
 *      and shared buffer logic for adapter conversions.
 */
contract DStakeRouterV2 is IDStakeRouter, AccessControl, ReentrancyGuard, Pausable {
  using SafeERC20 for IERC20;
  using AllocationCalculator for uint256[];

  // --- Errors ---
  error ZeroAddress();
  error AdapterNotFound(address vaultAsset);
  error ZeroPreviewWithdrawAmount(address vaultAsset);
  error InsufficientDStableFromAdapter(address vaultAsset, uint256 expected, uint256 actual);
  error VaultAssetManagedByDifferentAdapter(address vaultAsset, address existingAdapter);
  error ZeroInputDStableValue(address fromAsset, uint256 fromAmount);
  error AdapterAssetMismatch(address adapter, address expectedAsset, address actualAsset);
  error SlippageCheckFailed(address asset, uint256 actualAmount, uint256 requiredAmount);
  error InconsistentState(string message);
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
  error InvalidMaxVaultsPerOperation(uint256 count);
  error InsufficientActiveVaultsForOperation(uint256 activeCount);
  error RoutingCapacityExceeded(uint256 requested, uint256 fulfilled, uint256 vaultLimit);

  // --- Roles ---
  bytes32 public constant DSTAKE_TOKEN_ROLE = keccak256("DSTAKE_TOKEN_ROLE");
  bytes32 public constant COLLATERAL_EXCHANGER_ROLE = keccak256("COLLATERAL_EXCHANGER_ROLE");
  bytes32 public constant ADAPTER_MANAGER_ROLE = keccak256("ADAPTER_MANAGER_ROLE");
  bytes32 public constant CONFIG_MANAGER_ROLE = keccak256("CONFIG_MANAGER_ROLE");
  bytes32 public constant VAULT_MANAGER_ROLE = keccak256("VAULT_MANAGER_ROLE");
  bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

  // --- State ---
  address public immutable dStakeToken;
  IDStakeCollateralVault public immutable collateralVault;
  address public immutable dStable;

  uint256 public dustTolerance = 1;
  uint256 public maxVaultsPerOperation = 1;
  uint256 public maxVaultCount = 10;

  mapping(address => address) private _vaultAssetToAdapter;
  address public defaultDepositVaultAsset;

  struct ExchangeLocals {
    address fromAdapterAddress;
    address toAdapterAddress;
    IDStableConversionAdapter fromAdapter;
    IDStableConversionAdapter toAdapter;
    uint256 dStableValueIn;
    uint256 calculatedToVaultAssetAmount;
  }

  enum OperationType {
    DEPOSIT,
    WITHDRAWAL
  }

  struct VaultConfig {
    address vault;
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
    address indexed vaultAsset,
    address indexed dStakeToken,
    uint256 vaultAssetAmount,
    uint256 dStableAmount
  );
  event Withdrawn(address indexed vaultAsset, uint256 vaultAssetAmount, uint256 dStableAmount, address owner, address receiver);
  event Exchanged(
    address indexed fromAsset,
    address indexed toAsset,
    uint256 fromAssetAmount,
    uint256 toAssetAmount,
    uint256 dStableAmountEquivalent,
    address indexed exchanger
  );
  event AdapterSet(address indexed vaultAsset, address adapterAddress);
  event AdapterRemoved(address indexed vaultAsset, address adapterAddress);
  event DefaultDepositVaultAssetSet(address indexed vaultAsset);
  event DustToleranceSet(uint256 newDustTolerance);
  event SurplusHeld(uint256 amount);
  event SurplusSwept(uint256 amount, address vaultAsset);
  event ShortfallCovered(uint256 amount);
  event WeightedDeposit(address[] selectedVaults, uint256[] depositAmounts, uint256 totalDStableAmount, uint256 randomSeed);
  event WeightedWithdrawal(address[] selectedVaults, uint256[] withdrawalAmounts, uint256 totalDStableAmount, uint256 randomSeed);
  event VaultConfigAdded(address indexed vault, address indexed adapter, uint256 targetBps);
  event VaultConfigUpdated(address indexed vault, address indexed adapter, uint256 targetBps, bool isActive);
  event VaultConfigRemoved(address indexed vault);
  event CollateralExchanged(address indexed fromVault, address indexed toVault, uint256 amount, address indexed initiator);
  event MaxVaultCountUpdated(uint256 oldCount, uint256 newCount);
  event MaxVaultsPerOperationUpdated(uint256 oldCount, uint256 newCount);

  constructor(address _dStakeToken, address _collateralVault) {
    if (_dStakeToken == address(0) || _collateralVault == address(0)) {
      revert ZeroAddress();
    }

    dStakeToken = _dStakeToken;
    collateralVault = IDStakeCollateralVault(_collateralVault);
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

  function vaultAssetToAdapter(address vaultAsset) external view returns (address) {
    return _vaultAssetToAdapter[vaultAsset];
  }

  function deposit(uint256 dStableAmount) external override onlyRole(DSTAKE_TOKEN_ROLE) nonReentrant whenNotPaused {
    if (dStableAmount == 0) revert InvalidAmount();

    (
      address[] memory activeVaults,
      uint256[] memory currentAllocations,
      uint256[] memory targetAllocations
    ) = _getActiveVaultsAndAllocations(OperationType.DEPOSIT);

    if (activeVaults.length == 0) revert InsufficientActiveVaults();

    uint256 selectCount = _selectionLimit(activeVaults.length);
    (address[] memory selectedVaults, uint256[] memory selectedIndices) = DeterministicVaultSelector.selectTopUnderallocated(
      activeVaults,
      currentAllocations,
      targetAllocations,
      selectCount
    );

    uint256[] memory underallocationsFull = DeterministicVaultSelector.calculateUnderallocations(currentAllocations, targetAllocations);
    uint256[] memory underallocations = new uint256[](selectedVaults.length);
    for (uint256 i = 0; i < selectedVaults.length; i++) {
      underallocations[i] = underallocationsFull[selectedIndices[i]];
    }

    (uint256[] memory depositAmounts, uint256 remainder) = AllocationCalculator.splitAmountProportionally(dStableAmount, underallocations);
    if (remainder > 0) {
      depositAmounts = AllocationCalculator.distributeRemainder(depositAmounts, dStableAmount, underallocations, remainder);
    }

    bool allZero = true;
    for (uint256 i = 0; i < underallocations.length; i++) {
      if (underallocations[i] > 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) {
      depositAmounts = AllocationCalculator.splitAmountEvenly(dStableAmount, selectedVaults.length);
    }

    _executeMultiVaultDeposits(selectedVaults, depositAmounts, dStableAmount);

    emit WeightedDeposit(selectedVaults, depositAmounts, dStableAmount, 0);
  }

  function withdraw(
    uint256 dStableAmount,
    address receiver,
    address owner
  ) external override onlyRole(DSTAKE_TOKEN_ROLE) nonReentrant whenNotPaused {
    if (dStableAmount == 0) revert InvalidAmount();

    (
      address[] memory activeVaults,
      uint256[] memory currentAllocations,
      uint256[] memory targetAllocations
    ) = _getActiveVaultsAndAllocations(OperationType.WITHDRAWAL);

    if (activeVaults.length == 0) revert InsufficientActiveVaults();

    (address[] memory withdrawalVaults, uint256[] memory withdrawalAmounts) = _buildWithdrawalPlan(
      dStableAmount,
      activeVaults,
      currentAllocations,
      targetAllocations
    );

    _executeWithdrawalPlan(withdrawalVaults, withdrawalAmounts, dStableAmount, receiver, owner);

    emit WeightedWithdrawal(withdrawalVaults, withdrawalAmounts, dStableAmount, 0);
  }

  // --- Exchange Functions ---

  function exchangeAssetsUsingAdapters(
    address fromVaultAsset,
    address toVaultAsset,
    uint256 fromVaultAssetAmount,
    uint256 minToVaultAssetAmount
  ) external onlyRole(COLLATERAL_EXCHANGER_ROLE) nonReentrant {
    _exchangeAssetsUsingAdapters(fromVaultAsset, toVaultAsset, fromVaultAssetAmount, minToVaultAssetAmount);
  }

  function _exchangeAssetsUsingAdapters(
    address fromVaultAsset,
    address toVaultAsset,
    uint256 fromVaultAssetAmount,
    uint256 minToVaultAssetAmount
  ) internal {
    address fromAdapterAddress = _vaultAssetToAdapter[fromVaultAsset];
    address toAdapterAddress = _vaultAssetToAdapter[toVaultAsset];
    if (fromAdapterAddress == address(0)) revert AdapterNotFound(fromVaultAsset);
    if (toAdapterAddress == address(0)) revert AdapterNotFound(toVaultAsset);

    IDStableConversionAdapter fromAdapter = IDStableConversionAdapter(fromAdapterAddress);
    IDStableConversionAdapter toAdapter = IDStableConversionAdapter(toAdapterAddress);

    uint256 dStableAmountEquivalent = fromAdapter.previewConvertFromVaultAsset(fromVaultAssetAmount);
    collateralVault.sendAsset(fromVaultAsset, fromVaultAssetAmount, address(this));

    IERC20(fromVaultAsset).forceApprove(fromAdapterAddress, fromVaultAssetAmount);
    uint256 receivedDStable = fromAdapter.convertFromVaultAsset(fromVaultAssetAmount);

    IERC20(dStable).forceApprove(toAdapterAddress, receivedDStable);
    (address actualToVaultAsset, uint256 resultingToVaultAssetAmount) = toAdapter.convertToVaultAsset(receivedDStable);
    if (actualToVaultAsset != toVaultAsset) {
      revert AdapterAssetMismatch(toAdapterAddress, toVaultAsset, actualToVaultAsset);
    }
    if (resultingToVaultAssetAmount < minToVaultAssetAmount) {
      revert SlippageCheckFailed(toVaultAsset, resultingToVaultAssetAmount, minToVaultAssetAmount);
    }

    {
      uint256 previewValue = toAdapter.previewConvertFromVaultAsset(resultingToVaultAssetAmount);
      uint256 minRequired = dStableAmountEquivalent - dustTolerance;
      if (previewValue < minRequired) {
        revert SlippageCheckFailed(dStable, previewValue, minRequired);
      }
    }

    emit Exchanged(fromVaultAsset, toVaultAsset, fromVaultAssetAmount, resultingToVaultAssetAmount, dStableAmountEquivalent, msg.sender);
  }

  function exchangeAssets(
    address fromVaultAsset,
    address toVaultAsset,
    uint256 fromVaultAssetAmount,
    uint256 minToVaultAssetAmount
  ) external onlyRole(COLLATERAL_EXCHANGER_ROLE) nonReentrant {
    if (fromVaultAssetAmount == 0) revert ZeroInputDStableValue(fromVaultAsset, 0);
    if (fromVaultAsset == address(0) || toVaultAsset == address(0)) revert ZeroAddress();

    ExchangeLocals memory locals;
    locals.fromAdapterAddress = _vaultAssetToAdapter[fromVaultAsset];
    locals.toAdapterAddress = _vaultAssetToAdapter[toVaultAsset];

    if (locals.fromAdapterAddress == address(0)) revert AdapterNotFound(fromVaultAsset);
    if (locals.toAdapterAddress == address(0)) revert AdapterNotFound(toVaultAsset);

    locals.fromAdapter = IDStableConversionAdapter(locals.fromAdapterAddress);
    locals.toAdapter = IDStableConversionAdapter(locals.toAdapterAddress);

    locals.dStableValueIn = locals.fromAdapter.previewConvertFromVaultAsset(fromVaultAssetAmount);
    if (locals.dStableValueIn == 0) revert ZeroInputDStableValue(fromVaultAsset, fromVaultAssetAmount);

    (address expectedToAsset, uint256 tmpToAmount) = locals.toAdapter.previewConvertToVaultAsset(locals.dStableValueIn);
    if (expectedToAsset != toVaultAsset) revert AdapterAssetMismatch(locals.toAdapterAddress, toVaultAsset, expectedToAsset);
    locals.calculatedToVaultAssetAmount = tmpToAmount;

    if (locals.calculatedToVaultAssetAmount < minToVaultAssetAmount) {
      revert SlippageCheckFailed(toVaultAsset, locals.calculatedToVaultAssetAmount, minToVaultAssetAmount);
    }

    collateralVault.sendAsset(toVaultAsset, locals.calculatedToVaultAssetAmount, msg.sender);

    IERC20(fromVaultAsset).safeTransferFrom(msg.sender, address(this), fromVaultAssetAmount);
    IERC20(fromVaultAsset).forceApprove(locals.fromAdapterAddress, fromVaultAssetAmount);
    uint256 receivedDStable = locals.fromAdapter.convertFromVaultAsset(fromVaultAssetAmount);

    IERC20(dStable).forceApprove(locals.toAdapterAddress, receivedDStable);
    (address actualToVaultAsset, uint256 resultingToVaultAssetAmount) = locals.toAdapter.convertToVaultAsset(receivedDStable);
    if (actualToVaultAsset != toVaultAsset) revert AdapterAssetMismatch(locals.toAdapterAddress, toVaultAsset, actualToVaultAsset);

    if (resultingToVaultAssetAmount < minToVaultAssetAmount) {
      revert SlippageCheckFailed(toVaultAsset, resultingToVaultAssetAmount, minToVaultAssetAmount);
    }

    emit Exchanged(fromVaultAsset, toVaultAsset, fromVaultAssetAmount, resultingToVaultAssetAmount, locals.dStableValueIn, msg.sender);
  }

  function exchangeCollateral(
    address fromVault,
    address toVault,
    uint256 amount,
    uint256 minToVaultAssetAmount
  ) external onlyRole(COLLATERAL_EXCHANGER_ROLE) nonReentrant {
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
    _exchangeAssetsUsingAdapters(fromVault, toVault, requiredVaultAssetAmount, minToVaultAssetAmount);

    emit CollateralExchanged(fromVault, toVault, amount, msg.sender);
  }

  // --- Adapter Management ---

  function addAdapter(address vaultAsset, address adapterAddress) external onlyRole(ADAPTER_MANAGER_ROLE) {
    if (adapterAddress == address(0) || vaultAsset == address(0)) revert ZeroAddress();
    address adapterVaultAsset = IDStableConversionAdapter(adapterAddress).vaultAsset();
    if (adapterVaultAsset != vaultAsset) revert AdapterAssetMismatch(adapterAddress, vaultAsset, adapterVaultAsset);
    if (_vaultAssetToAdapter[vaultAsset] != address(0) && _vaultAssetToAdapter[vaultAsset] != adapterAddress) {
      revert VaultAssetManagedByDifferentAdapter(vaultAsset, _vaultAssetToAdapter[vaultAsset]);
    }
    _vaultAssetToAdapter[vaultAsset] = adapterAddress;

    try collateralVault.addSupportedAsset(vaultAsset) {} catch {}

    emit AdapterSet(vaultAsset, adapterAddress);
  }

  function removeAdapter(address vaultAsset) external onlyRole(ADAPTER_MANAGER_ROLE) {
    address adapterAddress = _vaultAssetToAdapter[vaultAsset];
    if (adapterAddress == address(0)) revert AdapterNotFound(vaultAsset);
    delete _vaultAssetToAdapter[vaultAsset];

    collateralVault.removeSupportedAsset(vaultAsset);

    emit AdapterRemoved(vaultAsset, adapterAddress);
  }

  function setDefaultDepositVaultAsset(address vaultAsset) external onlyRole(CONFIG_MANAGER_ROLE) {
    if (_vaultAssetToAdapter[vaultAsset] == address(0)) revert AdapterNotFound(vaultAsset);
    defaultDepositVaultAsset = vaultAsset;
    emit DefaultDepositVaultAssetSet(vaultAsset);
  }

  function setDustTolerance(uint256 _dustTolerance) external onlyRole(CONFIG_MANAGER_ROLE) {
    dustTolerance = _dustTolerance;
    emit DustToleranceSet(_dustTolerance);
  }

  function sweepSurplus(uint256 maxAmount) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
    uint256 balance = IERC20(dStable).balanceOf(address(this));
    if (balance == 0) revert ZeroInputDStableValue(dStable, 0);

    uint256 amountToSweep = (maxAmount == 0 || maxAmount > balance) ? balance : maxAmount;
    address adapterAddress = _vaultAssetToAdapter[defaultDepositVaultAsset];
    if (adapterAddress == address(0)) revert AdapterNotFound(defaultDepositVaultAsset);

    IDStableConversionAdapter adapter = IDStableConversionAdapter(adapterAddress);
    address vaultAsset = adapter.vaultAsset();

    IERC20(dStable).approve(adapterAddress, amountToSweep);
    (address mintedAsset, ) = adapter.convertToVaultAsset(amountToSweep);
    if (mintedAsset != vaultAsset) revert AdapterAssetMismatch(adapterAddress, vaultAsset, mintedAsset);

    emit SurplusSwept(amountToSweep, mintedAsset);
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
    _addVaultConfig(VaultConfig({ vault: vault, adapter: adapter, targetBps: targetBps, isActive: isActive }));
  }

  function updateVaultConfig(VaultConfig calldata config) external onlyRole(VAULT_MANAGER_ROLE) {
    _updateVaultConfig(config);
  }

  function updateVaultConfig(address vault, address adapter, uint256 targetBps, bool isActive) external onlyRole(VAULT_MANAGER_ROLE) {
    _updateVaultConfig(VaultConfig({ vault: vault, adapter: adapter, targetBps: targetBps, isActive: isActive }));
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

  function setMaxVaultsPerOperation(uint256 _maxVaultsPerOperation) external onlyRole(CONFIG_MANAGER_ROLE) {
    if (_maxVaultsPerOperation == 0) revert InvalidMaxVaultsPerOperation(_maxVaultsPerOperation);

    uint256 activeVaultCount = _countActiveVaults();
    if (activeVaultCount == 0) revert InsufficientActiveVaultsForOperation(activeVaultCount);
    if (_maxVaultsPerOperation > activeVaultCount) {
      revert InvalidMaxVaultsPerOperation(_maxVaultsPerOperation);
    }

    uint256 oldValue = maxVaultsPerOperation;
    maxVaultsPerOperation = _maxVaultsPerOperation;
    emit MaxVaultsPerOperationUpdated(oldValue, _maxVaultsPerOperation);
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

  function _selectionLimit(uint256 activeCount) internal view returns (uint256) {
    if (maxVaultsPerOperation == 0) return activeCount;
    return maxVaultsPerOperation < activeCount ? maxVaultsPerOperation : activeCount;
  }

  function _executeMultiVaultDeposits(address[] memory selectedVaults, uint256[] memory depositAmounts, uint256 totalAmount) internal {
    IERC20(dStable).safeTransferFrom(msg.sender, address(this), totalAmount);

    for (uint256 i = 0; i < selectedVaults.length; i++) {
      if (depositAmounts[i] == 0) continue;

      VaultConfig memory config = _getVaultConfig(selectedVaults[i]);
      IDStableConversionAdapter adapter = IDStableConversionAdapter(config.adapter);

      (address vaultAssetExpected, uint256 expectedShares) = adapter.previewConvertToVaultAsset(depositAmounts[i]);
      if (vaultAssetExpected != selectedVaults[i]) revert AdapterAssetMismatch(config.adapter, selectedVaults[i], vaultAssetExpected);

      uint256 beforeBal = IERC20(selectedVaults[i]).balanceOf(address(collateralVault));
      IERC20(dStable).forceApprove(config.adapter, depositAmounts[i]);
      (, uint256 reportedShares) = adapter.convertToVaultAsset(depositAmounts[i]);
      IERC20(dStable).forceApprove(config.adapter, 0);

      uint256 afterBal = IERC20(selectedVaults[i]).balanceOf(address(collateralVault));
      uint256 actualShares = afterBal - beforeBal;
      if (actualShares < expectedShares) revert SlippageCheckFailed(selectedVaults[i], actualShares, expectedShares);
      if (actualShares != reportedShares) revert InconsistentState("Adapter mis-reported shares");

      emit RouterDeposit(config.adapter, selectedVaults[i], msg.sender, actualShares, depositAmounts[i]);
    }
  }

  function _buildWithdrawalPlan(
    uint256 totalAmount,
    address[] memory activeVaults,
    uint256[] memory currentAllocations,
    uint256[] memory targetAllocations
  ) internal view returns (address[] memory vaults, uint256[] memory amounts) {
    (address[] memory orderedVaults, ) = DeterministicVaultSelector.selectTopOverallocated(
      activeVaults,
      currentAllocations,
      targetAllocations,
      activeVaults.length
    );

    // Use a more generous limit to allow for vault failures
    uint256 limit = activeVaults.length;
    if (maxVaultsPerOperation > 0 && maxVaultsPerOperation < activeVaults.length) {
      // Allow up to double the max vaults per operation to handle failures
      limit = (maxVaultsPerOperation * 3) / 2;
      if (limit > activeVaults.length) limit = activeVaults.length;
    }

    address[] memory tempVaults = new address[](limit);
    uint256[] memory tempAmounts = new uint256[](limit);

    uint256 remaining = totalAmount;
    uint256 used = 0;

    for (uint256 i = 0; i < orderedVaults.length && remaining > 0 && used < limit; i++) {
      VaultConfig memory config = _getVaultConfig(orderedVaults[i]);
      if (!config.isActive) continue;

      uint256 available = _getVaultBalanceWithAdapter(orderedVaults[i], config.adapter);
      if (available == 0) continue;

      uint256 toUse = available < remaining ? available : remaining;
      if (toUse == 0) continue;

      tempVaults[used] = orderedVaults[i];
      tempAmounts[used] = toUse;
      remaining -= toUse;
      used++;
    }

    if (remaining > 0) {
      uint256 totalSystemLiquidity = _totalSystemLiquidity(activeVaults);
      if (totalSystemLiquidity < totalAmount) revert NoLiquidityAvailable();
      // Don't revert here - let the execution handle the shortfall by trying more vaults
    }

    vaults = new address[](used);
    amounts = new uint256[](used);
    for (uint256 i = 0; i < used; i++) {
      vaults[i] = tempVaults[i];
      amounts[i] = tempAmounts[i];
    }
  }

  function _executeWithdrawalPlan(
    address[] memory vaults,
    uint256[] memory dStableAmounts,
    uint256 totalAmount,
    address receiver,
    address owner
  ) internal {
    uint256 totalReceived = 0;
    uint256 successfulVaults = 0;

    // First pass: try to withdraw from planned vaults
    for (uint256 i = 0; i < vaults.length; i++) {
      if (dStableAmounts[i] == 0) continue;

      (uint256 received, uint256 vaultAssetAmount, address adapter) = _withdrawFromVault(vaults[i], dStableAmounts[i]);

      if (received > 0) {
        totalReceived += received;
        successfulVaults++;
        emit Withdrawn(vaults[i], vaultAssetAmount, received, owner, receiver);
      }

      IERC20(vaults[i]).forceApprove(adapter, 0);
    }

    uint256 routerBalance = IERC20(dStable).balanceOf(address(this));

    // Handle case where no vaults provided liquidity
    if (successfulVaults == 0 || routerBalance == 0) {
      revert NoLiquidityAvailable();
    }

    // If we have sufficient balance, transfer the full amount
    // If we have some but not enough, transfer what we have (partial fulfillment)
    uint256 actualTransfer = routerBalance >= totalAmount ? totalAmount : routerBalance;

    if (totalReceived > actualTransfer) {
      emit SurplusHeld(totalReceived - actualTransfer);
    } else if (routerBalance < totalAmount) {
      emit ShortfallCovered(totalAmount - routerBalance);
    }

    IERC20(dStable).safeTransfer(receiver, actualTransfer);
  }

  function _withdrawFromVault(
    address vault,
    uint256 dStableAmount
  ) internal returns (uint256 receivedDStable, uint256 vaultAssetAmount, address adapter) {
    VaultConfig memory config = _getVaultConfig(vault);
    adapter = config.adapter;
    IDStableConversionAdapter conversionAdapter = IDStableConversionAdapter(adapter);

    vaultAssetAmount = IERC4626(vault).previewWithdraw(dStableAmount);
    if (vaultAssetAmount == 0) revert ZeroPreviewWithdrawAmount(vault);

    uint256 expectedDStable = conversionAdapter.previewConvertFromVaultAsset(vaultAssetAmount);
    if (expectedDStable < dStableAmount) {
      uint256 buffer = ((dStableAmount - expectedDStable) * 11000) / 10000;
      if (buffer > 0) {
        uint256 additionalAssets = IERC4626(vault).previewDeposit(buffer);
        vaultAssetAmount += additionalAssets;
      }
    }

    uint256 availableShares = IERC20(vault).balanceOf(address(collateralVault));
    if (vaultAssetAmount > availableShares) {
      vaultAssetAmount = availableShares;
    }

    if (vaultAssetAmount == 0) {
      return (0, 0, adapter);
    }

    collateralVault.sendAsset(vault, vaultAssetAmount, address(this));
    IERC20(vault).forceApprove(adapter, vaultAssetAmount);

    try conversionAdapter.convertFromVaultAsset(vaultAssetAmount) returns (uint256 converted) {
      receivedDStable = converted;
    } catch {
      // If conversion fails (e.g., due to slippage/fees), clean up and return 0
      // This allows the withdrawal plan to continue with other vaults
      IERC20(vault).forceApprove(adapter, 0);
      IERC20(vault).safeTransfer(address(collateralVault), vaultAssetAmount);
      return (0, 0, adapter);
    }
  }

  function _getActiveVaultsAndAllocations(
    OperationType operationType
  ) internal view returns (address[] memory activeVaults, uint256[] memory currentAllocations, uint256[] memory targetAllocations) {
    uint256 activeCount = 0;
    for (uint256 i = 0; i < vaultConfigs.length; i++) {
      if (vaultConfigs[i].isActive && _isVaultHealthyForOperation(vaultConfigs[i].vault, operationType)) {
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
      if (config.isActive && _isVaultHealthyForOperation(config.vault, operationType)) {
        activeVaults[activeIndex] = config.vault;
        balances[activeIndex] = _getVaultBalance(config.vault);
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
      vaults[i] = config.vault;
      balances[i] = _getVaultBalance(config.vault);
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
        adapter = _vaultAssetToAdapter[vault];
      }
      if (adapter == address(0)) return 0;

      try IDStableConversionAdapter(adapter).assetValueInDStable(vault, shares) returns (uint256 value) {
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
    if (config.vault == address(0) || config.adapter == address(0)) revert ZeroAddress();
    if (vaultExists[config.vault]) revert VaultAlreadyExists(config.vault);
    if (vaultConfigs.length >= maxVaultCount) revert InvalidVaultConfig();

    uint256 index = vaultConfigs.length;
    vaultConfigs.push(config);
    vaultToIndex[config.vault] = index;
    vaultExists[config.vault] = true;

    if (config.isActive) {
      this.addAdapter(config.vault, config.adapter);
    }

    emit VaultConfigAdded(config.vault, config.adapter, config.targetBps);
  }

  function _updateVaultConfig(VaultConfig memory config) internal {
    if (!vaultExists[config.vault]) revert AdapterNotFound(config.vault);

    uint256 index = vaultToIndex[config.vault];
    vaultConfigs[index] = config;

    if (config.isActive) {
      this.addAdapter(config.vault, config.adapter);
    } else {
      try this.removeAdapter(config.vault) {} catch {}
    }

    emit VaultConfigUpdated(config.vault, config.adapter, config.targetBps, config.isActive);
  }

  function _removeVault(address vault) internal {
    uint256 indexToRemove = vaultToIndex[vault];
    uint256 lastIndex = vaultConfigs.length - 1;

    if (indexToRemove != lastIndex) {
      VaultConfig memory lastConfig = vaultConfigs[lastIndex];
      vaultConfigs[indexToRemove] = lastConfig;
      vaultToIndex[lastConfig.vault] = indexToRemove;
    }

    vaultConfigs.pop();
    delete vaultToIndex[vault];
    delete vaultExists[vault];

    if (_vaultAssetToAdapter[vault] != address(0)) {
      try this.removeAdapter(vault) {} catch {}
    }

    emit VaultConfigRemoved(vault);
  }

  function _clearVaultConfigs() internal {
    for (uint256 i = 0; i < vaultConfigs.length; i++) {
      address vault = vaultConfigs[i].vault;
      delete vaultToIndex[vault];
      delete vaultExists[vault];
      try this.removeAdapter(vault) {} catch {}
    }
    delete vaultConfigs;
  }

  function _countActiveVaults() internal view returns (uint256 count) {
    for (uint256 i = 0; i < vaultConfigs.length; i++) {
      if (vaultConfigs[i].isActive) count++;
    }
  }
}
