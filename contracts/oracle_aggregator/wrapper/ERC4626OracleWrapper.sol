// SPDX-License-Identifier: MIT

/* ———————————————————————————————————————————————————————————————————————————————— *
 *    _____     ______   ______     __     __   __     __     ______   __  __       *
 *   /\  __-.  /\__  _\ /\  == \   /\ \   /\ "-.\ \   /\ \   /\__  _\ /\ \_\ \      *
 *   \ \ \/\ \ \/_/\ \/ \ \  __<   \ \ \  \ \ \-.  \  \ \ \  \/_/\ \/ \ \____ \     *
 *    \ \____-    \ \_\  \ \_\ \_\  \ \_\  \ \_\\"\_\  \ \_\    \ \_\  \/\_____\    *
 *     \/____/     \/_/   \/_/ /_/   \/_/   \/_/ \/_/   \/_/     \/_/   \/_____/    *
 *                                                                                  *
 * ————————————————————————————————— dtrinity.org ————————————————————————————————— *
 *                                                                                  *
 *                                         ▲                                        *
 *                                        ▲ ▲                                       *
 *                                                                                  *
 * ———————————————————————————————————————————————————————————————————————————————— *
 * dTRINITY Protocol: https://github.com/dtrinity                                   *
 * ———————————————————————————————————————————————————————————————————————————————— */

pragma solidity ^0.8.20;

import "../interface/IOracleWrapper.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/interfaces/IERC4626.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title ERC4626OracleWrapper
 * @notice Oracle wrapper that provides secure pricing for ERC-4626 vaults with manipulation resistance
 * @dev Uses bounds checking and minimum share supply requirements for protection without external dependencies
 */
contract ERC4626OracleWrapper is IOracleWrapper, AccessControl {
  using Math for uint256;

  /* IMMUTABLE STATE */

  /// @notice Base currency address
  address private immutable _baseCurrency;

  /// @notice Base currency unit (e.g., 1e8 for USD, 1e18 for ETH)
  uint256 private immutable _baseCurrencyUnit;

  /* MUTABLE STATE */

  /// @notice Configuration for each vault
  struct VaultConfig {
    bool isActive;
    uint256 minShareSupply; // Minimum shares to prevent donation attacks
    uint256 lastValidPrice; // For deviation checking
    address underlyingAsset; // The vault's underlying asset
    bool isPaused; // Emergency pause state
  }

  /// @notice Vault configurations mapping
  mapping(address => VaultConfig) public vaultConfigs;

  /// @notice Maximum allowed price deviation in basis points (5% default)
  uint256 public maxDeviation = 500;

  /* CONSTANTS */

  /// @notice Basis point denominator (100%)
  uint256 private constant DEVIATION_BASE = 10000;

  /* ROLES */

  /// @notice Role for managing vault configurations
  bytes32 public constant ORACLE_MANAGER_ROLE = keccak256("ORACLE_MANAGER_ROLE");

  /* EVENTS */

  event VaultAdded(address indexed vault, uint256 minShareSupply, address underlyingAsset);
  event VaultRemoved(address indexed vault);
  event VaultPaused(address indexed vault);
  event VaultUnpaused(address indexed vault);
  event MaxDeviationUpdated(uint256 oldDeviation, uint256 newDeviation);
  event LastValidPriceUpdated(address indexed vault, uint256 newPrice);

  /* ERRORS */

  error VaultNotActive(address vault);
  error VaultAlreadyExists(address vault);
  error InvalidVaultAddress();
  error InvalidUnderlyingAsset();
  error InvalidMinShareSupply();
  error InvalidDeviation();
  error PriceNotAvailable(address vault);
  error InsufficientLiquidity(address vault);

  /* CONSTRUCTOR */

  /**
   * @notice Initialize the ERC4626OracleWrapper
   * @param baseCurrency Address of the base currency (e.g., USDC address or zero address for USD)
   * @param baseCurrencyUnit Unit of the base currency (e.g., 1e6 for USDC, 1e8 for USD)
   */
  constructor(address baseCurrency, uint256 baseCurrencyUnit) {
    if (baseCurrencyUnit == 0) {
      revert InvalidDeviation();
    }

    _baseCurrency = baseCurrency;
    _baseCurrencyUnit = baseCurrencyUnit;

    _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    _grantRole(ORACLE_MANAGER_ROLE, msg.sender);
  }

  /* IOracleWrapper IMPLEMENTATION */

  /**
   * @notice Returns the base currency address
   * @return Base currency address
   */
  function BASE_CURRENCY() external view override returns (address) {
    return _baseCurrency;
  }

  /**
   * @notice Returns the base currency unit
   * @return Base currency unit
   */
  function BASE_CURRENCY_UNIT() external view override returns (uint256) {
    return _baseCurrencyUnit;
  }

  /**
   * @notice Get price and health status for a vault
   * @param vault The ERC-4626 vault address
   * @return price The exchange rate in base currency units
   * @return isAlive Whether the price is considered reliable
   */
  function getPriceInfo(address vault) public view override returns (uint256 price, bool isAlive) {
    VaultConfig storage config = vaultConfigs[vault];

    // Check if vault is configured and healthy
    if (!_validateVaultHealth(vault)) {
      return (0, false);
    }

    // Get current exchange rate: how many assets per _baseCurrencyUnit of shares
    uint256 currentPrice = IERC4626(vault).convertToAssets(_baseCurrencyUnit);

    // Apply bounds checking for manipulation resistance
    if (config.lastValidPrice > 0 && _priceDeviatesSignificantly(currentPrice, config.lastValidPrice)) {
      // Price shows suspicious deviation - use last known good price for safety
      return (config.lastValidPrice, true);
    }

    // Current price looks reasonable
    return (currentPrice, true);
  }

  /**
   * @notice Get asset price, reverts if not available
   * @param vault The ERC-4626 vault address
   * @return price The exchange rate in base currency units
   */
  function getAssetPrice(address vault) external view override returns (uint256) {
    (uint256 price, bool isAlive) = getPriceInfo(vault);
    if (!isAlive || price == 0) {
      revert PriceNotAvailable(vault);
    }
    return price;
  }

  /* VAULT MANAGEMENT */

  /**
   * @notice Add a new ERC-4626 vault for oracle pricing
   * @param vault The vault contract address
   * @param minShares Minimum share supply required for pricing (protection against donation attacks)
   * @param underlyingAsset The vault's underlying asset address
   */
  function addVault(address vault, uint256 minShares, address underlyingAsset) external onlyRole(ORACLE_MANAGER_ROLE) {
    if (vault == address(0)) revert InvalidVaultAddress();
    if (vaultConfigs[vault].isActive) revert VaultAlreadyExists(vault);
    if (minShares == 0) revert InvalidMinShareSupply();
    if (underlyingAsset == address(0)) revert InvalidUnderlyingAsset();

    // Verify vault compatibility
    if (IERC4626(vault).asset() != underlyingAsset) {
      revert InvalidUnderlyingAsset();
    }

    // Initialize vault configuration with current price as baseline
    uint256 initialPrice = IERC4626(vault).convertToAssets(_baseCurrencyUnit);

    vaultConfigs[vault] = VaultConfig({
      isActive: true,
      minShareSupply: minShares,
      lastValidPrice: initialPrice,
      underlyingAsset: underlyingAsset,
      isPaused: false
    });

    emit VaultAdded(vault, minShares, underlyingAsset);
    emit LastValidPriceUpdated(vault, initialPrice);
  }

  /**
   * @notice Remove a vault from the oracle
   * @param vault The vault address to remove
   */
  function removeVault(address vault) external onlyRole(ORACLE_MANAGER_ROLE) {
    if (!vaultConfigs[vault].isActive) revert VaultNotActive(vault);

    delete vaultConfigs[vault];
    emit VaultRemoved(vault);
  }

  /**
   * @notice Pause pricing for a vault (emergency function)
   * @param vault The vault address to pause
   */
  function pauseVault(address vault) external onlyRole(ORACLE_MANAGER_ROLE) {
    if (!vaultConfigs[vault].isActive) revert VaultNotActive(vault);

    vaultConfigs[vault].isPaused = true;
    emit VaultPaused(vault);
  }

  /**
   * @notice Unpause pricing for a vault
   * @param vault The vault address to unpause
   */
  function unPauseVault(address vault) external onlyRole(ORACLE_MANAGER_ROLE) {
    if (!vaultConfigs[vault].isActive) revert VaultNotActive(vault);

    vaultConfigs[vault].isPaused = false;
    emit VaultUnpaused(vault);
  }

  /**
   * @notice Update the last valid price for a vault (governance function)
   * @param vault The vault address
   * @param newPrice The new baseline price
   */
  function updateLastValidPrice(address vault, uint256 newPrice) external onlyRole(ORACLE_MANAGER_ROLE) {
    if (!vaultConfigs[vault].isActive) revert VaultNotActive(vault);
    if (newPrice == 0) revert InvalidDeviation();

    vaultConfigs[vault].lastValidPrice = newPrice;
    emit LastValidPriceUpdated(vault, newPrice);
  }

  /* PARAMETER MANAGEMENT */

  /**
   * @notice Update maximum allowed price deviation
   * @param newDeviation New deviation in basis points (e.g., 500 = 5%)
   */
  function setMaxDeviation(uint256 newDeviation) external onlyRole(DEFAULT_ADMIN_ROLE) {
    if (newDeviation == 0 || newDeviation > DEVIATION_BASE) {
      revert InvalidDeviation();
    }

    uint256 oldDeviation = maxDeviation;
    maxDeviation = newDeviation;
    emit MaxDeviationUpdated(oldDeviation, newDeviation);
  }

  /* VIEW FUNCTIONS */

  /**
   * @notice Get the last valid price for a vault
   * @param vault The vault address
   * @return The last valid price stored
   */
  function getLastValidPrice(address vault) external view returns (uint256) {
    return vaultConfigs[vault].lastValidPrice;
  }

  /**
   * @notice Check if a vault is configured and active
   * @param vault The vault address
   * @return Whether the vault is active
   */
  function isVaultActive(address vault) external view returns (bool) {
    return vaultConfigs[vault].isActive && !vaultConfigs[vault].isPaused;
  }

  /* INTERNAL FUNCTIONS */

  /**
   * @notice Validate vault health and safety conditions
   * @param vault The vault address to validate
   * @return Whether the vault is healthy for pricing
   */
  function _validateVaultHealth(address vault) internal view returns (bool) {
    VaultConfig storage config = vaultConfigs[vault];

    // Check basic configuration
    if (!config.isActive || config.isPaused) {
      return false;
    }

    // Check minimum liquidity requirements
    uint256 totalSupply = IERC4626(vault).totalSupply();
    if (totalSupply < config.minShareSupply) {
      return false;
    }

    // Check for zero assets (vault might be drained)
    uint256 totalAssets = IERC4626(vault).totalAssets();
    if (totalAssets == 0) {
      return false;
    }

    return true;
  }

  /**
   * @notice Check if price deviates significantly from baseline
   * @param newPrice Current price
   * @param baselinePrice Reference price to compare against
   * @return Whether the deviation is significant (exceeds threshold)
   */
  function _priceDeviatesSignificantly(uint256 newPrice, uint256 baselinePrice) internal view returns (bool) {
    if (baselinePrice == 0) return false;

    uint256 diff = newPrice > baselinePrice ? newPrice - baselinePrice : baselinePrice - newPrice;

    // Check if deviation exceeds threshold
    return diff * DEVIATION_BASE > baselinePrice * maxDeviation;
  }
}
