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
  error EmptyArrays();
  error ArrayLengthMismatch();

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

    // Simple deterministic ordering: pick the most underallocated vault
    (address[] memory selectedVaults, ) = DeterministicVaultSelector.selectTopUnderallocated(
      activeVaults,
      currentAllocations,
      targetAllocations,
      1 // Only select one vault for auto routing
    );

    IERC20(dStable).safeTransferFrom(msg.sender, address(this), dStableAmount);

    // Try vaults in order until one succeeds or we run out
    address targetVault = selectedVaults[0];
    for (uint256 attempts = 0; attempts < activeVaults.length; attempts++) {
      try this._depositToVaultWithRetry(targetVault, dStableAmount) {
        // Success - emit event and return
        address[] memory vaultArray = new address[](1);
        uint256[] memory amountArray = new uint256[](1);
        vaultArray[0] = targetVault;
        amountArray[0] = dStableAmount;
        emit WeightedDeposit(vaultArray, amountArray, dStableAmount, 0);
        return;
      } catch (bytes memory reason) {
        if (_isTransientError(reason) && attempts < activeVaults.length - 1) {
          // Try next vault in deterministic order
          targetVault = activeVaults[(attempts + 1) % activeVaults.length];
        } else {
          // Non-transient error or last attempt, propagate
          assembly {
            revert(add(reason, 0x20), mload(reason))
          }
        }
      }
    }

    revert NoLiquidityAvailable();
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

    // Simple deterministic ordering: pick the most overallocated vault
    (address[] memory selectedVaults, ) = DeterministicVaultSelector.selectTopOverallocated(
      activeVaults,
      currentAllocations,
      targetAllocations,
      1 // Only select one vault for auto routing
    );

    // Try vaults in order until one succeeds or we run out
    address targetVault = selectedVaults[0];
    for (uint256 attempts = 0; attempts < activeVaults.length; attempts++) {
      try this._withdrawFromVaultWithRetry(targetVault, dStableAmount, receiver, owner) {
        // Success - emit event and return
        address[] memory vaultArray = new address[](1);
        uint256[] memory amountArray = new uint256[](1);
        vaultArray[0] = targetVault;
        amountArray[0] = dStableAmount;
        emit WeightedWithdrawal(vaultArray, amountArray, dStableAmount, 0);
        return;
      } catch (bytes memory reason) {
        if (_isTransientError(reason) && attempts < activeVaults.length - 1) {
          // Try next vault in deterministic order
          targetVault = activeVaults[(attempts + 1) % activeVaults.length];
        } else {
          // Non-transient error or last attempt, propagate
          assembly {
            revert(add(reason, 0x20), mload(reason))
          }
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

    emit WeightedDeposit(vaults, assets, totalAssets, 0);
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

    emit WeightedDeposit(vaults, assetAmounts, totalAssets, 0);
  }

  function solverWithdrawAssets(
    address[] calldata vaults,
    uint256[] calldata assets,
    address /* receiver */,
    address /* owner */
  ) external onlyRole(DSTAKE_TOKEN_ROLE) nonReentrant whenNotPaused returns (uint256 totalWithdrawn) {
    if (vaults.length == 0) revert EmptyArrays();
    if (vaults.length != assets.length) revert ArrayLengthMismatch();

    uint256 totalAssets = 0;
    for (uint256 i = 0; i < assets.length; i++) {
      totalAssets += assets[i];
    }

    if (totalAssets == 0) revert InvalidAmount();

    // Execute withdrawals atomically
    for (uint256 i = 0; i < vaults.length; i++) {
      if (assets[i] > 0) {
        _withdrawFromVaultAtomically(vaults[i], assets[i]);
      }
    }

    // Transfer all accumulated dStable back to DStakeToken for fee handling
    totalWithdrawn = IERC20(dStable).balanceOf(address(this));
    IERC20(dStable).safeTransfer(msg.sender, totalWithdrawn);

    emit WeightedWithdrawal(vaults, assets, totalAssets, 0);
    return totalWithdrawn;
  }

  function solverWithdrawShares(
    address[] calldata vaults,
    uint256[] calldata shares,
    address /* receiver */,
    address /* owner */
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

    // Execute withdrawals atomically
    for (uint256 i = 0; i < vaults.length; i++) {
      if (shares[i] > 0) {
        _withdrawSharesFromVaultAtomically(vaults[i], shares[i]);
      }
    }

    // Transfer all accumulated dStable back to DStakeToken for fee handling
    totalWithdrawn = IERC20(dStable).balanceOf(address(this));
    IERC20(dStable).safeTransfer(msg.sender, totalWithdrawn);

    emit WeightedWithdrawal(vaults, assetAmounts, totalAssets, 0);
    return totalWithdrawn;
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
    _addAdapter(vaultAsset, adapterAddress);
  }

  function _addAdapter(address vaultAsset, address adapterAddress) internal {
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

  function _isTransientError(bytes memory reason) internal pure returns (bool) {
    // Check for common transient error signatures
    if (reason.length >= 4) {
      bytes4 selector;
      assembly {
        selector := mload(add(reason, 0x20))
      }

      // These errors should trigger retries (transient errors)
      // - NoLiquidityAvailable: vault may be temporarily drained
      // - VaultNotActive: vault may be temporarily paused
      // - SlippageCheckFailed: temporary price movement
      // - Also check for common ERC20 errors (insufficient balance/allowance)
      if (
        selector == NoLiquidityAvailable.selector ||
        selector == VaultNotActive.selector ||
        selector == SlippageCheckFailed.selector ||
        selector == bytes4(keccak256("ERC20InsufficientBalance(address,uint256,uint256)")) ||
        selector == bytes4(keccak256("ERC20InsufficientAllowance(address,uint256,uint256)"))
      ) {
        return true;
      }

      // Handle standard Error(string) reverts (selector: 0x08c379a0)
      if (selector == 0x08c379a0 && reason.length >= 100) {
        // Decode the string message and check for transient conditions
        bytes memory strData;
        assembly {
          // Skip selector (4) + offset (32) + string length (32) = 68 bytes
          let strLen := mload(add(reason, 0x44))
          // Cap string length to prevent excessive memory usage
          if gt(strLen, 256) {
            strLen := 256
          }
          strData := mload(0x40)
          mstore(strData, strLen)
          // Copy string data
          let dataPtr := add(strData, 0x20)
          let reasonPtr := add(reason, 0x64)
          for {
            let i := 0
          } lt(i, strLen) {
            i := add(i, 32)
          } {
            mstore(add(dataPtr, i), mload(add(reasonPtr, i)))
          }
          mstore(0x40, add(dataPtr, strLen))
        }

        // Check if the error message indicates a transient condition
        // Common patterns: "paused", "Pausable", "insufficient", "not enough"
        if (_containsTransientKeyword(strData)) {
          return true;
        }
      }
    }
    return false;
  }

  function _containsTransientKeyword(bytes memory str) internal pure returns (bool) {
    // Check for common transient error keywords
    bytes32[4] memory keywords = [bytes32("paused"), bytes32("Pausable"), bytes32("insufficient"), bytes32("not enough")];

    for (uint256 i = 0; i < keywords.length; i++) {
      if (_contains(str, keywords[i])) {
        return true;
      }
    }
    return false;
  }

  function _contains(bytes memory haystack, bytes32 needle) internal pure returns (bool) {
    uint256 needleLen = 0;
    for (uint256 i = 0; i < 32; i++) {
      if (needle[i] == 0) break;
      needleLen++;
    }

    if (haystack.length < needleLen) return false;

    for (uint256 i = 0; i <= haystack.length - needleLen; i++) {
      bool found = true;
      for (uint256 j = 0; j < needleLen; j++) {
        if (haystack[i + j] != needle[j]) {
          found = false;
          break;
        }
      }
      if (found) return true;
    }
    return false;
  }

  function _depositToVaultWithRetry(address vault, uint256 dStableAmount) external {
    require(msg.sender == address(this), "Only self-callable");
    // This is called by this contract only, for auto-routing retries
    _depositToVaultAtomically(vault, dStableAmount);
  }

  function _withdrawFromVaultWithRetry(address vault, uint256 dStableAmount, address receiver, address /* owner */) external {
    require(msg.sender == address(this), "Only self-callable");
    // This is called by this contract only, for auto-routing retries
    _withdrawFromVaultAtomically(vault, dStableAmount);
    // Transfer the withdrawn dStable to receiver
    uint256 balance = IERC20(dStable).balanceOf(address(this));
    IERC20(dStable).safeTransfer(receiver, balance);
  }

  function _depositToVaultAtomically(address vault, uint256 dStableAmount) internal {
    VaultConfig memory config = _getVaultConfig(vault);
    if (!config.isActive) revert VaultNotActive(vault);

    IDStableConversionAdapter adapter = IDStableConversionAdapter(config.adapter);

    (address vaultAssetExpected, uint256 expectedShares) = adapter.previewConvertToVaultAsset(dStableAmount);
    if (vaultAssetExpected != vault) revert AdapterAssetMismatch(config.adapter, vault, vaultAssetExpected);

    uint256 beforeBal = IERC20(vault).balanceOf(address(collateralVault));

    IERC20(dStable).forceApprove(config.adapter, dStableAmount);
    try adapter.convertToVaultAsset(dStableAmount) returns (address actualVault, uint256 reportedShares) {
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
    } catch (bytes memory reason) {
      IERC20(dStable).forceApprove(config.adapter, 0);
      // Re-throw the original error so _isTransientError can check it
      assembly {
        revert(add(32, reason), mload(reason))
      }
    }

    IERC20(dStable).forceApprove(config.adapter, 0);
  }

  function _withdrawFromVaultAtomically(address vault, uint256 dStableAmount) internal {
    (uint256 receivedDStable, uint256 vaultAssetAmount, address adapter) = _withdrawFromVault(vault, dStableAmount);
    if (receivedDStable == 0) revert NoLiquidityAvailable();

    IERC20(vault).forceApprove(adapter, 0);
    emit Withdrawn(vault, vaultAssetAmount, receivedDStable, msg.sender, msg.sender);
  }

  function _withdrawSharesFromVaultAtomically(address vault, uint256 shares) internal {
    VaultConfig memory config = _getVaultConfig(vault);
    if (!config.isActive) revert VaultNotActive(vault);

    address adapter = config.adapter;
    IDStableConversionAdapter conversionAdapter = IDStableConversionAdapter(adapter);

    uint256 availableShares = IERC20(vault).balanceOf(address(collateralVault));
    if (shares > availableShares) revert NoLiquidityAvailable();

    collateralVault.sendAsset(vault, shares, address(this));
    IERC20(vault).forceApprove(adapter, shares);

    try conversionAdapter.convertFromVaultAsset(shares) returns (uint256 receivedDStable) {
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
    uint256 dStableAmount
  ) internal returns (uint256 receivedDStable, uint256 vaultAssetAmount, address adapter) {
    VaultConfig memory config = _getVaultConfig(vault);
    adapter = config.adapter;
    IDStableConversionAdapter conversionAdapter = IDStableConversionAdapter(adapter);

    // Use the vault's direct preview without slippage discount for planning
    // The adapter's preview includes slippage which is for conservative estimation only
    vaultAssetAmount = IERC4626(vault).previewWithdraw(dStableAmount);
    if (vaultAssetAmount == 0) revert ZeroPreviewWithdrawAmount(vault);

    uint256 availableShares = IERC20(vault).balanceOf(address(collateralVault));
    if (vaultAssetAmount > availableShares) {
      // Don't silently truncate - revert if insufficient shares
      revert NoLiquidityAvailable();
    }

    if (vaultAssetAmount == 0) {
      return (0, 0, adapter);
    }

    collateralVault.sendAsset(vault, vaultAssetAmount, address(this));
    IERC20(vault).forceApprove(adapter, vaultAssetAmount);

    try conversionAdapter.convertFromVaultAsset(vaultAssetAmount) returns (uint256 converted) {
      receivedDStable = converted;
      // Verify we received at least what was requested
      // If not, this vault cannot fulfill the request (slippage/fees too high)
      if (receivedDStable < dStableAmount) {
        // Clean up and revert - let auto-routing try another vault
        IERC20(vault).forceApprove(adapter, 0);
        IERC20(vault).safeTransfer(address(collateralVault), vaultAssetAmount);
        revert SlippageCheckFailed(vault, receivedDStable, dStableAmount);
      }
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
      _addAdapter(config.vault, config.adapter);
    }

    emit VaultConfigAdded(config.vault, config.adapter, config.targetBps);
  }

  function _updateVaultConfig(VaultConfig memory config) internal {
    if (!vaultExists[config.vault]) revert AdapterNotFound(config.vault);

    uint256 index = vaultToIndex[config.vault];
    vaultConfigs[index] = config;

    if (config.isActive) {
      _addAdapter(config.vault, config.adapter);
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
