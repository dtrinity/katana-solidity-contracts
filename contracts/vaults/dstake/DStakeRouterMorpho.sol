// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { DStakeRouter } from "./DStakeRouter.sol";
import { IDStableConversionAdapter } from "./interfaces/IDStableConversionAdapter.sol";
import { WeightedRandomSelector } from "./libraries/WeightedRandomSelector.sol";
import { AllocationCalculator } from "./libraries/AllocationCalculator.sol";
import { BasisPointConstants } from "../../common/BasisPointConstants.sol";

/**
 * @title DStakeRouterMorpho
 * @notice Advanced DStakeRouter that uses weighted random selection to distribute deposits
 *         and withdrawals across multiple MetaMorpho vaults, achieving target allocations
 *         through natural convergence without explicit rebalancing.
 * @dev Inherits from DStakeRouter and extends functionality with multi-vault weighted routing.
 *
 *      Core Algorithm:
 *      - Deposits: Always split across exactly 3 vaults (or fewer if not enough active)
 *      - Selection uses weighted randomness where weight = max(0, targetBps - currentBps)
 *      - Withdrawals: Select 3 overweight vaults where weight = max(0, currentBps - targetBps)
 *      - Natural convergence toward target allocations over time
 *      - Emergency collateral exchange for manual optimization
 */
contract DStakeRouterMorpho is DStakeRouter, ReentrancyGuard, Pausable {
  using SafeERC20 for IERC20;

  // --- Libraries ---
  using WeightedRandomSelector for address[];
  using AllocationCalculator for uint256[];

  // --- Constants ---
  uint256 public maxVaultsPerOperation = 3;

  // --- Roles ---
  bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

  // --- State Variables ---
  uint256 public maxVaultCount = 10; // Governable limit for gas optimization

  // --- Enums ---
  enum OperationType {
    DEPOSIT,
    WITHDRAWAL
  }

  // --- Errors ---
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

  // --- Structs ---

  /**
   * @notice Configuration for a MetaMorpho vault in the routing system
   * @param vault Address of the MetaMorpho vault (ERC4626)
   * @param adapter Address of the conversion adapter for this vault
   * @param targetBps Target allocation in basis points (e.g., 600000 = 60%)
   * @param isActive Whether this vault is currently active for routing
   */
  struct VaultConfig {
    address vault; // MetaMorpho vault address
    address adapter; // Conversion adapter address
    uint256 targetBps; // Target allocation in basis points
    bool isActive; // Whether vault is active for routing
  }

  // --- State Variables ---

  /// @notice Array of vault configurations
  VaultConfig[] public vaultConfigs;

  /// @notice Mapping from vault address to array index for O(1) lookups
  mapping(address => uint256) public vaultToIndex;

  /// @notice Mapping to track which vault addresses exist (for duplicate prevention)
  mapping(address => bool) public vaultExists;

  /// @notice Nonce for pseudo-random number generation
  uint256 private nonce;

  // --- Events ---

  event VaultConfigAdded(address indexed vault, address indexed adapter, uint256 targetBps);
  event VaultConfigUpdated(address indexed vault, address indexed adapter, uint256 targetBps, bool isActive);
  event VaultConfigRemoved(address indexed vault);
  event WeightedDeposit(address[] selectedVaults, uint256[] depositAmounts, uint256 totalDStableAmount, uint256 randomSeed);
  event WeightedWithdrawal(address[] selectedVaults, uint256[] withdrawalAmounts, uint256 totalDStableAmount, uint256 randomSeed);
  event CollateralExchanged(address indexed fromVault, address indexed toVault, uint256 amount, address indexed initiator);
  event AllocationSnapshot(address[] vaults, uint256[] currentAllocations, uint256[] targetAllocations, uint256 totalBalance);
  event MaxVaultCountUpdated(uint256 oldCount, uint256 newCount);
  event MaxVaultsPerOperationUpdated(uint256 oldCount, uint256 newCount);

  // --- Constructor ---

  /**
   * @notice Initializes the DStakeRouterMorpho contract
   * @param _dStakeToken Address of the DStakeToken this router serves
   * @param _collateralVault Address of the DStakeCollateralVault
   */
  constructor(address _dStakeToken, address _collateralVault) DStakeRouter(_dStakeToken, _collateralVault) {
    // Base constructor handles all setup and validation
    // Initialize nonce with some entropy
    nonce = uint256(keccak256(abi.encodePacked(block.timestamp, block.prevrandao, address(this))));
  }

  // --- Core Routing Functions (Override IDStakeRouter) ---

  /**
   * @notice Handles deposits with weighted random vault selection
   * @dev Overrides the base deposit function to implement multi-vault weighted routing
   * @param dStableAmount Amount of dStable to deposit
   */
  function deposit(uint256 dStableAmount) external override onlyRole(DSTAKE_TOKEN_ROLE) nonReentrant whenNotPaused {
    if (dStableAmount == 0) revert InvalidAmount();

    // Get active vaults and their current allocations (only vaults healthy for deposits)
    (
      address[] memory activeVaults,
      uint256[] memory currentAllocations,
      uint256[] memory targetAllocations
    ) = _getActiveVaultsAndAllocations(OperationType.DEPOSIT);

    if (activeVaults.length == 0) {
      revert InsufficientActiveVaults();
    }

    // Calculate deposit weights (weight = max(0, target - current))
    uint256[] memory depositWeights = WeightedRandomSelector.calculateDepositWeights(currentAllocations, targetAllocations);

    // Generate pseudo-random seed
    uint256 randomSeed = WeightedRandomSelector.generateRandomSeed(msg.sender, nonce++);

    // Select vaults for deposit (up to 3, or fewer if not enough active)
    uint256 selectCount = activeVaults.length < maxVaultsPerOperation ? activeVaults.length : maxVaultsPerOperation;

    (address[] memory selectedVaults, ) = WeightedRandomSelector.selectWeightedRandom(
      activeVaults,
      depositWeights,
      selectCount,
      randomSeed
    );

    // Split deposit amount evenly among selected vaults
    uint256[] memory depositAmounts = AllocationCalculator.splitAmountEvenly(dStableAmount, selectedVaults.length);

    // Execute deposits to selected vaults
    _executeMultiVaultDeposits(selectedVaults, depositAmounts, dStableAmount);

    emit WeightedDeposit(selectedVaults, depositAmounts, dStableAmount, randomSeed);
  }

  /**
   * @notice Handles withdrawals with weighted random vault selection from overweight vaults
   * @dev Overrides the base withdrawal function to implement multi-vault weighted routing
   * @param dStableAmount Amount of dStable to withdraw
   * @param receiver Address to receive the withdrawn dStable
   * @param owner Owner initiating the withdrawal
   */
  function withdraw(
    uint256 dStableAmount,
    address receiver,
    address owner
  ) external override onlyRole(DSTAKE_TOKEN_ROLE) nonReentrant whenNotPaused {
    if (dStableAmount == 0) revert InvalidAmount();

    // Get active vaults and their current allocations (only vaults healthy for withdrawals)
    (
      address[] memory activeVaults,
      uint256[] memory currentAllocations,
      uint256[] memory targetAllocations
    ) = _getActiveVaultsAndAllocations(OperationType.WITHDRAWAL);

    if (activeVaults.length == 0) {
      revert InsufficientActiveVaults();
    }

    // Calculate withdrawal weights (weight = max(0, current - target) for overweight vaults)
    uint256[] memory withdrawalWeights = WeightedRandomSelector.calculateWithdrawalWeights(currentAllocations, targetAllocations);

    // Generate pseudo-random seed
    uint256 randomSeed = WeightedRandomSelector.generateRandomSeed(msg.sender, nonce++);

    // Select vaults for withdrawal (up to 3, prioritizing overweight vaults)
    (address[] memory selectedVaults, uint256[] memory selectedIndices) = WeightedRandomSelector.selectWeightedRandom(
      activeVaults,
      withdrawalWeights,
      activeVaults.length < maxVaultsPerOperation ? activeVaults.length : maxVaultsPerOperation,
      randomSeed
    );

    // Calculate withdrawal amounts proportionally based on available liquidity
    uint256[] memory withdrawalAmounts = _calculateWithdrawalAmounts(selectedVaults, selectedIndices, dStableAmount);

    // Execute withdrawals from selected vaults
    _executeMultiVaultWithdrawals(selectedVaults, withdrawalAmounts, dStableAmount, receiver);

    emit WeightedWithdrawal(selectedVaults, withdrawalAmounts, dStableAmount, randomSeed);
    // Note: owner parameter not emitted to avoid stack too deep
  }

  // --- Collateral Exchange Function ---

  /**
   * @notice Exchanges collateral between vaults for manual rebalancing
   * @dev Allows authorized users to move assets between vaults to optimize allocations
   * @param fromVault Address of the vault to withdraw from
   * @param toVault Address of the vault to deposit to
   * @param amount Amount of dStable equivalent to exchange
   */
  function exchangeCollateral(address fromVault, address toVault, uint256 amount) external onlyRole(COLLATERAL_EXCHANGER_ROLE) {
    if (amount == 0) revert InvalidAmount();
    if (fromVault == toVault) revert InvalidVaultConfig();

    // Validate both vaults are configured and active
    VaultConfig memory fromConfig = _getVaultConfig(fromVault);
    VaultConfig memory toConfig = _getVaultConfig(toVault);

    if (!fromConfig.isActive || !toConfig.isActive) {
      revert VaultNotActive(fromConfig.isActive ? toVault : fromVault);
    }

    // Check if target vault is healthy for deposits and source vault is healthy for withdrawals
    if (!_isVaultHealthyForDeposits(toVault)) {
      revert VaultNotActive(toVault);
    }

    if (!_isVaultHealthyForWithdrawals(fromVault)) {
      revert VaultNotActive(fromVault);
    }

    // Use the existing exchangeAssetsUsingAdapters function
    // First, we need to determine how much vault asset to exchange
    IDStableConversionAdapter fromAdapter = IDStableConversionAdapter(fromConfig.adapter);

    // Preview how much vault asset we need to get the desired dStable amount
    (address expectedFromAsset, uint256 requiredVaultAssetAmount) = fromAdapter.previewConvertToVaultAsset(amount);

    if (expectedFromAsset != fromVault) {
      revert AdapterAssetMismatch(fromConfig.adapter, fromVault, expectedFromAsset);
    }

    // Execute the exchange using the parent contract's function
    this.exchangeAssetsUsingAdapters(
      fromVault,
      toVault,
      requiredVaultAssetAmount,
      0 // No minimum - we trust the calculation
    );

    emit CollateralExchanged(fromVault, toVault, amount, msg.sender);
  }

  // --- Admin Functions ---

  /**
   * @notice Adds or updates multiple vault configurations
   * @dev Only callable by admin role
   * @param configs Array of vault configurations to add/update
   */
  function setVaultConfigs(VaultConfig[] calldata configs) external onlyRole(DEFAULT_ADMIN_ROLE) {
    // Validate total allocations
    uint256 totalTargetBps = 0;
    for (uint256 i = 0; i < configs.length; i++) {
      totalTargetBps += configs[i].targetBps;
    }

    if (totalTargetBps != BasisPointConstants.ONE_HUNDRED_PERCENT_BPS) {
      revert TotalAllocationInvalid(totalTargetBps);
    }

    // Clear existing configurations
    _clearVaultConfigs();

    // Add new configurations
    for (uint256 i = 0; i < configs.length; i++) {
      _addVaultConfig(configs[i]);
    }
  }

  /**
   * @notice Adds a single vault configuration
   * @dev Only callable by admin role
   * @param config Vault configuration to add
   */
  function addVaultConfig(VaultConfig calldata config) external onlyRole(DEFAULT_ADMIN_ROLE) {
    _addVaultConfig(config);
  }

  /**
   * @notice Updates an existing vault configuration
   * @dev Only callable by admin role
   * @param vault Address of the vault to update
   * @param adapter New adapter address
   * @param targetBps New target allocation in basis points
   * @param isActive New active status
   */
  function updateVaultConfig(address vault, address adapter, uint256 targetBps, bool isActive) external onlyRole(DEFAULT_ADMIN_ROLE) {
    if (!vaultExists[vault]) {
      revert AdapterNotFound(vault);
    }

    uint256 index = vaultToIndex[vault];
    VaultConfig storage config = vaultConfigs[index];

    config.adapter = adapter;
    config.targetBps = targetBps;
    config.isActive = isActive;

    // Update adapter mapping in parent contract
    if (isActive) {
      this.addAdapter(vault, adapter);
    }

    emit VaultConfigUpdated(vault, adapter, targetBps, isActive);
  }

  /**
   * @notice Removes a vault configuration
   * @dev Only callable by admin role. Does not automatically migrate funds.
   *      Requires target allocation to be 0 to prevent asset stranding.
   * @param vault Address of the vault to remove
   */
  function removeVaultConfig(address vault) external onlyRole(DEFAULT_ADMIN_ROLE) {
    if (!vaultExists[vault]) {
      revert AdapterNotFound(vault);
    }

    // Check that target allocation is 0 before allowing removal
    VaultConfig memory config = vaultConfigs[vaultToIndex[vault]];
    if (config.targetBps != 0) {
      revert VaultMustHaveZeroAllocation(vault, config.targetBps);
    }

    uint256 indexToRemove = vaultToIndex[vault];
    uint256 lastIndex = vaultConfigs.length - 1;

    // Move last element to the position of element to remove
    if (indexToRemove != lastIndex) {
      VaultConfig storage lastConfig = vaultConfigs[lastIndex];
      vaultConfigs[indexToRemove] = lastConfig;
      vaultToIndex[lastConfig.vault] = indexToRemove;
    }

    // Remove the last element
    vaultConfigs.pop();
    delete vaultToIndex[vault];
    delete vaultExists[vault];

    // Remove adapter from parent contract
    this.removeAdapter(vault);

    emit VaultConfigRemoved(vault);
  }

  /**
   * @notice Emergency function to pause a specific vault
   * @dev Only callable by guardian role
   * @param vault Address of the vault to pause
   */
  function emergencyPauseVault(address vault) external onlyRole(DEFAULT_ADMIN_ROLE) {
    if (!vaultExists[vault]) {
      revert AdapterNotFound(vault);
    }

    uint256 index = vaultToIndex[vault];
    vaultConfigs[index].isActive = false;

    emit VaultConfigUpdated(vault, vaultConfigs[index].adapter, vaultConfigs[index].targetBps, false);
  }

  /**
   * @notice Sets the maximum number of vaults per deposit/withdrawal operation
   * @dev Only callable by admin role. Must be greater than 0 to ensure functionality
   * @param _maxVaultsPerOperation New maximum vaults per operation
   */
  function setMaxVaultsPerOperation(uint256 _maxVaultsPerOperation) external onlyRole(DEFAULT_ADMIN_ROLE) {
    if (_maxVaultsPerOperation == 0) {
      revert InvalidMaxVaultsPerOperation(_maxVaultsPerOperation);
    }

    uint256 oldMaxVaultsPerOperation = maxVaultsPerOperation;
    maxVaultsPerOperation = _maxVaultsPerOperation;

    emit MaxVaultsPerOperationUpdated(oldMaxVaultsPerOperation, _maxVaultsPerOperation);
  }

  /**
   * @notice Sets the maximum number of vaults allowed in the system
   * @dev Only callable by admin role. Must be greater than 0 and at least the current vault count
   * @param _maxVaultCount New maximum vault count
   */
  function setMaxVaultCount(uint256 _maxVaultCount) external onlyRole(DEFAULT_ADMIN_ROLE) {
    if (_maxVaultCount == 0) {
      revert InvalidMaxVaultCount(_maxVaultCount);
    }

    // Ensure we don't set it below the current number of vaults
    if (_maxVaultCount < vaultConfigs.length) {
      revert InvalidMaxVaultCount(_maxVaultCount);
    }

    uint256 oldMaxVaultCount = maxVaultCount;
    maxVaultCount = _maxVaultCount;

    emit MaxVaultCountUpdated(oldMaxVaultCount, _maxVaultCount);
  }

  /**
   * @notice Emergency pause function to halt deposits and withdrawals
   * @dev Only callable by accounts with PAUSER_ROLE (typically admin or guardian)
   */
  function pause() external onlyRole(PAUSER_ROLE) {
    _pause();
  }

  /**
   * @notice Unpause function to resume normal operations
   * @dev Only callable by accounts with PAUSER_ROLE (typically admin or guardian)
   */
  function unpause() external onlyRole(PAUSER_ROLE) {
    _unpause();
  }

  // --- View Functions ---

  /**
   * @notice Returns current allocations for all configured vaults
   * @return vaults Array of vault addresses
   * @return currentAllocations Array of current allocations in basis points
   * @return targetAllocations Array of target allocations in basis points
   * @return totalBalance Total balance across all vaults
   */
  function getCurrentAllocations()
    external
    view
    returns (address[] memory vaults, uint256[] memory currentAllocations, uint256[] memory targetAllocations, uint256 totalBalance)
  {
    return _getAllVaultsAndAllocations();
  }

  /**
   * @notice Returns only active vault addresses
   * @dev For backward compatibility, defaults to checking deposit health
   * @return activeVaults Array of active vault addresses
   */
  function getActiveVaults() external view returns (address[] memory activeVaults) {
    (activeVaults, , ) = _getActiveVaultsAndAllocations(OperationType.DEPOSIT);
  }

  /**
   * @notice Returns the number of configured vaults
   * @return count Number of vaults in configuration
   */
  function getVaultCount() external view returns (uint256 count) {
    return vaultConfigs.length;
  }

  /**
   * @notice Returns vault configuration at specific index
   * @param index Index of the vault configuration
   * @return config Vault configuration
   */
  function getVaultConfigByIndex(uint256 index) external view returns (VaultConfig memory config) {
    require(index < vaultConfigs.length, "Index out of bounds");
    return vaultConfigs[index];
  }

  /**
   * @notice Returns vault configuration by vault address
   * @param vault Address of the vault
   * @return config Vault configuration
   */
  function getVaultConfig(address vault) external view returns (VaultConfig memory config) {
    return _getVaultConfig(vault);
  }

  /**
   * @notice Checks if a vault is currently healthy and not paused
   * @dev For backward compatibility, defaults to checking deposit health
   * @param vault Address of the vault to check
   * @return healthy True if vault is healthy for deposits
   */
  function isVaultHealthy(address vault) external view returns (bool healthy) {
    return _isVaultHealthyForDeposits(vault);
  }

  /**
   * @notice Checks if a vault is healthy for deposit operations
   * @param vault Address of the vault to check
   * @return healthy True if vault can accept deposits
   */
  function isVaultHealthyForDeposits(address vault) external view returns (bool healthy) {
    return _isVaultHealthyForDeposits(vault);
  }

  /**
   * @notice Checks if a vault is healthy for withdrawal operations
   * @param vault Address of the vault to check
   * @return healthy True if vault can process withdrawals
   */
  function isVaultHealthyForWithdrawals(address vault) external view returns (bool healthy) {
    return _isVaultHealthyForWithdrawals(vault);
  }

  // --- Internal Helper Functions ---

  /**
   * @notice Internal function to get active vaults and their allocations
   * @param operationType Type of operation to filter vaults by health status
   * @return activeVaults Array of active vault addresses
   * @return currentAllocations Array of current allocations in basis points
   * @return targetAllocations Array of target allocations in basis points
   */
  function _getActiveVaultsAndAllocations(
    OperationType operationType
  ) internal view returns (address[] memory activeVaults, uint256[] memory currentAllocations, uint256[] memory targetAllocations) {
    // First, count active vaults
    uint256 activeCount = 0;
    for (uint256 i = 0; i < vaultConfigs.length; i++) {
      if (vaultConfigs[i].isActive && _isVaultHealthyForOperation(vaultConfigs[i].vault, operationType)) {
        activeCount++;
      }
    }

    if (activeCount == 0) {
      return (new address[](0), new uint256[](0), new uint256[](0));
    }

    // Allocate arrays for active vaults only
    activeVaults = new address[](activeCount);
    uint256[] memory balances = new uint256[](activeCount);
    targetAllocations = new uint256[](activeCount);

    // Populate arrays with active vault data
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

    // Calculate current allocations based on balances
    (currentAllocations, ) = AllocationCalculator.calculateCurrentAllocations(balances);

    return (activeVaults, currentAllocations, targetAllocations);
  }

  /**
   * @notice Helper function to check vault health based on operation type
   * @param vault Address of the vault to check
   * @param operationType Type of operation (deposit or withdrawal)
   * @return healthy True if vault is healthy for the specified operation
   */
  function _isVaultHealthyForOperation(address vault, OperationType operationType) internal view returns (bool healthy) {
    if (operationType == OperationType.DEPOSIT) {
      return _isVaultHealthyForDeposits(vault);
    } else {
      return _isVaultHealthyForWithdrawals(vault);
    }
  }

  /**
   * @notice Internal function to get all vaults and their allocations (including inactive)
   * @return vaults Array of all vault addresses
   * @return currentAllocations Array of current allocations in basis points
   * @return targetAllocations Array of target allocations in basis points
   * @return totalBalance Total balance across all vaults
   */
  function _getAllVaultsAndAllocations()
    internal
    view
    returns (address[] memory vaults, uint256[] memory currentAllocations, uint256[] memory targetAllocations, uint256 totalBalance)
  {
    uint256 vaultCount = vaultConfigs.length;
    vaults = new address[](vaultCount);
    uint256[] memory balances = new uint256[](vaultCount);
    targetAllocations = new uint256[](vaultCount);

    // Populate arrays with all vault data
    for (uint256 i = 0; i < vaultCount; i++) {
      VaultConfig memory config = vaultConfigs[i];
      vaults[i] = config.vault;
      balances[i] = _getVaultBalance(config.vault);
      targetAllocations[i] = config.targetBps;
    }

    // Calculate current allocations based on balances
    (currentAllocations, totalBalance) = AllocationCalculator.calculateCurrentAllocations(balances);

    return (vaults, currentAllocations, targetAllocations, totalBalance);
  }

  /**
   * @notice Gets the current balance of a vault in dStable terms
   * @param vault Address of the vault
   * @return balance Current balance in dStable equivalent
   */
  function _getVaultBalance(address vault) internal view returns (uint256 balance) {
    try IERC20(vault).balanceOf(address(collateralVault)) returns (uint256 shares) {
      if (shares == 0) return 0;

      address adapter = this.vaultAssetToAdapter(vault);
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

  /**
   * @notice Gets vault configuration by address
   * @param vault Address of the vault
   * @return config Vault configuration
   */
  function _getVaultConfig(address vault) internal view returns (VaultConfig memory config) {
    if (!vaultExists[vault]) {
      revert AdapterNotFound(vault);
    }
    return vaultConfigs[vaultToIndex[vault]];
  }

  /**
   * @notice Checks if a vault is healthy for deposits and not paused
   * @dev Checks if the vault can preview deposit operations
   * @param vault Address of the vault to check
   * @return healthy True if vault can accept deposits
   */
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

  /**
   * @notice Checks if a vault is healthy for withdrawals and not paused
   * @dev Checks if the vault can preview redeem operations
   * @param vault Address of the vault to check
   * @return healthy True if vault can process withdrawals
   */
  function _isVaultHealthyForWithdrawals(address vault) internal view returns (bool healthy) {
    try IERC4626(vault).totalAssets() returns (uint256) {
      // Check if we have any shares in this vault
      uint256 vaultShares = IERC20(vault).balanceOf(address(collateralVault));
      if (vaultShares == 0) {
        return false;
      }

      try IERC4626(vault).previewRedeem(vaultShares) returns (uint256 assets) {
        return assets > 0;
      } catch {
        return false;
      }
    } catch {
      return false;
    }
  }

  /**
   * @notice Executes deposits to multiple vaults
   * @param selectedVaults Array of vault addresses to deposit to
   * @param depositAmounts Array of dStable amounts to deposit to each vault
   * @param totalAmount Total amount being deposited (for validation)
   */
  function _executeMultiVaultDeposits(address[] memory selectedVaults, uint256[] memory depositAmounts, uint256 totalAmount) internal {
    uint256 totalMintedShares = 0;

    // Pull total dStable from caller once
    IERC20(dStable).safeTransferFrom(msg.sender, address(this), totalAmount);

    for (uint256 i = 0; i < selectedVaults.length; i++) {
      if (depositAmounts[i] == 0) continue;

      VaultConfig memory config = _getVaultConfig(selectedVaults[i]);

      // Execute deposit to this vault (inline logic since _executeDeposit is private in parent)
      IDStableConversionAdapter adapter = IDStableConversionAdapter(config.adapter);

      // Preview the conversion
      (address vaultAssetExpected, uint256 expectedShares) = adapter.previewConvertToVaultAsset(depositAmounts[i]);

      if (vaultAssetExpected != selectedVaults[i]) {
        revert AdapterAssetMismatch(config.adapter, selectedVaults[i], vaultAssetExpected);
      }

      uint256 beforeBal = IERC20(selectedVaults[i]).balanceOf(address(collateralVault));

      // Approve adapter to spend dStable
      IERC20(dStable).safeIncreaseAllowance(config.adapter, depositAmounts[i]);

      // Convert dStable to vault asset through adapter
      (, uint256 convertedAmount) = adapter.convertToVaultAsset(depositAmounts[i]);

      // Verify the shares were sent to collateralVault
      uint256 afterBal = IERC20(selectedVaults[i]).balanceOf(address(collateralVault));
      uint256 actualShares = afterBal - beforeBal;

      if (actualShares < expectedShares) {
        revert SlippageCheckFailed(selectedVaults[i], actualShares, expectedShares);
      }

      totalMintedShares += actualShares;

      emit RouterDeposit(config.adapter, selectedVaults[i], msg.sender, actualShares, depositAmounts[i]);
    }
  }

  /**
   * @notice Executes withdrawals from multiple vaults
   * @param selectedVaults Array of vault addresses to withdraw from
   * @param withdrawalAmounts Array of dStable amounts to withdraw from each vault
   * @param totalAmount Total amount being withdrawn
   * @param receiver Address to receive the withdrawn dStable
   */
  function _executeMultiVaultWithdrawals(
    address[] memory selectedVaults,
    uint256[] memory withdrawalAmounts,
    uint256 totalAmount,
    address receiver
  ) internal {
    uint256 totalReceived = 0;

    for (uint256 i = 0; i < selectedVaults.length; i++) {
      if (withdrawalAmounts[i] == 0) continue;

      VaultConfig memory config = _getVaultConfig(selectedVaults[i]);
      IDStableConversionAdapter adapter = IDStableConversionAdapter(config.adapter);

      // Calculate required vault asset amount
      uint256 vaultAssetAmount = IERC4626(selectedVaults[i]).previewWithdraw(withdrawalAmounts[i]);
      if (vaultAssetAmount == 0) continue;

      // Pull vault asset from collateral vault
      collateralVault.sendAsset(selectedVaults[i], vaultAssetAmount, address(this));

      // Approve adapter
      IERC20(selectedVaults[i]).forceApprove(config.adapter, vaultAssetAmount);

      // Convert to dStable
      uint256 receivedDStable = adapter.convertFromVaultAsset(vaultAssetAmount);
      totalReceived += receivedDStable;
    }

    // Handle any shortfall from router reserves
    if (totalReceived < totalAmount) {
      uint256 routerBalance = IERC20(dStable).balanceOf(address(this));
      uint256 shortfall = totalAmount - totalReceived;

      if (routerBalance < shortfall) {
        revert InsufficientDStableFromAdapter(address(0), totalAmount, totalReceived);
      }
    }

    // Transfer exact requested amount to receiver
    IERC20(dStable).safeTransfer(receiver, totalAmount);

    // Handle any surplus (rare)
    uint256 surplus = IERC20(dStable).balanceOf(address(this));
    if (surplus > 0) {
      emit SurplusHeld(surplus);
    }
  }

  /**
   * @notice Calculates withdrawal amounts from selected vaults based on available liquidity
   * @param selectedVaults Array of selected vault addresses
   * @param selectedIndices Array of indices in the original active vaults array
   * @param totalAmount Total amount to withdraw
   * @return withdrawalAmounts Array of amounts to withdraw from each vault
   */
  function _calculateWithdrawalAmounts(
    address[] memory selectedVaults,
    uint256[] memory selectedIndices,
    uint256 totalAmount
  ) internal view returns (uint256[] memory withdrawalAmounts) {
    // Get available liquidity from each selected vault
    uint256[] memory availableLiquidity = new uint256[](selectedVaults.length);
    uint256 totalLiquidity = 0;

    for (uint256 i = 0; i < selectedVaults.length; i++) {
      uint256 vaultShares = IERC20(selectedVaults[i]).balanceOf(address(collateralVault));
      if (vaultShares > 0) {
        try IERC4626(selectedVaults[i]).previewRedeem(vaultShares) returns (uint256 assets) {
          availableLiquidity[i] = assets;
          totalLiquidity += assets;
        } catch {
          availableLiquidity[i] = 0;
        }
      }
    }

    if (totalLiquidity == 0) {
      revert NoLiquidityAvailable();
    }

    // If total requested is more than available, scale down proportionally
    if (totalAmount > totalLiquidity) {
      totalAmount = totalLiquidity;
    }

    // Distribute withdrawal amounts proportionally based on available liquidity
    (withdrawalAmounts, ) = AllocationCalculator.splitAmountProportionally(totalAmount, availableLiquidity);

    return withdrawalAmounts;
  }

  /**
   * @notice Adds a vault configuration to the system
   * @param config Vault configuration to add
   */
  function _addVaultConfig(VaultConfig memory config) internal {
    if (config.vault == address(0) || config.adapter == address(0)) {
      revert ZeroAddress();
    }

    if (vaultExists[config.vault]) {
      revert VaultAlreadyExists(config.vault);
    }

    if (vaultConfigs.length >= maxVaultCount) {
      revert InvalidVaultConfig();
    }

    // Add to storage
    uint256 index = vaultConfigs.length;
    vaultConfigs.push(config);
    vaultToIndex[config.vault] = index;
    vaultExists[config.vault] = true;

    // Add adapter to parent contract
    if (config.isActive) {
      this.addAdapter(config.vault, config.adapter);
    }

    emit VaultConfigAdded(config.vault, config.adapter, config.targetBps);
  }

  /**
   * @notice Clears all vault configurations
   */
  function _clearVaultConfigs() internal {
    for (uint256 i = 0; i < vaultConfigs.length; i++) {
      address vault = vaultConfigs[i].vault;
      delete vaultToIndex[vault];
      delete vaultExists[vault];

      // Remove adapter from parent contract
      try this.removeAdapter(vault) {} catch {}
    }

    // Clear the array
    delete vaultConfigs;
  }
}
