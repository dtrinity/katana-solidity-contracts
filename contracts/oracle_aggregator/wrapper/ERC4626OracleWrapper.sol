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
        uint256 lowerBound; // Dynamic lower bound for exchange rate (replaces lastValidPrice)
        uint256 lastBoundsUpdate; // Timestamp of last bounds update
        address underlyingAsset; // The vault's underlying asset
        bool isPaused; // Emergency pause state
    }

  /// @notice Vault configurations mapping
  mapping(address => VaultConfig) public vaultConfigs;

  /* CONSTANTS */

  /// @notice Window size in basis points (2% between lower and upper bound)
  uint256 private constant WINDOW_SIZE = 200;

  /// @notice Buffer size in basis points (1% buffer when updating bounds)
  uint256 private constant BUFFER_SIZE = 100;

  /// @notice Basis point denominator (100%)
  uint256 private constant PERCENTAGE_FACTOR = 10000;

  /// @notice Minimum interval between bounds updates
  uint256 private constant UPDATE_BOUNDS_COOLDOWN = 1 days;

  /* ROLES */

  /// @notice Role for managing vault configurations
  bytes32 public constant ORACLE_MANAGER_ROLE = keccak256("ORACLE_MANAGER_ROLE");

  /* EVENTS */

  event VaultAdded(address indexed vault, uint256 minShareSupply, address underlyingAsset, uint256 initialLowerBound);
  event VaultRemoved(address indexed vault);
  event VaultPaused(address indexed vault);
  event VaultUnpaused(address indexed vault);
  event BoundsUpdated(address indexed vault, uint256 newLowerBound, uint256 newUpperBound);
  event ExchangeRateBounced(address indexed vault, uint256 actualRate, uint256 cappedRate);

  /* ERRORS */

  error VaultNotActive(address vault);
  error VaultAlreadyExists(address vault);
  error InvalidVaultAddress();
  error InvalidUnderlyingAsset();
  error InvalidMinShareSupply();
  error InvalidBounds();
  error ExchangeRateOutOfBounds(address vault);
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
      revert InvalidBounds();
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
    uint256 exchangeRate = IERC4626(vault).convertToAssets(_baseCurrencyUnit);
    
    // Apply Gearbox-style bounds checking with bounce mechanism
    uint256 lb = config.lowerBound;
    if (exchangeRate < lb) {
      // Below lower bound - hard failure (panic mode)
      return (0, false);
    }

    uint256 ub = _calcUpperBound(lb);
    if (exchangeRate > ub) {
      // Above upper bound - soft cap (bounce down to upper bound)
      return (ub, true);
    }

    // Exchange rate is within bounds - use actual rate
    return (exchangeRate, true);
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

    // Initialize vault configuration with current exchange rate as lower bound
    uint256 initialExchangeRate = IERC4626(vault).convertToAssets(_baseCurrencyUnit);
    uint256 initialLowerBound = _calcLowerBound(initialExchangeRate); // Set lower bound with buffer
    
    vaultConfigs[vault] = VaultConfig({
      isActive: true,
      minShareSupply: minShares,
      lowerBound: initialLowerBound,
      lastBoundsUpdate: block.timestamp,
      underlyingAsset: underlyingAsset,
      isPaused: false
    });

    emit VaultAdded(vault, minShares, underlyingAsset, initialLowerBound);
    emit BoundsUpdated(vault, initialLowerBound, _calcUpperBound(initialLowerBound));
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
   * @notice Update the bounds for a vault (governance function)
   * @param vault The vault address
   * @param newLowerBound The new lower bound for the vault's exchange rate
   */
  function updateVaultBounds(address vault, uint256 newLowerBound) external onlyRole(ORACLE_MANAGER_ROLE) {
    if (!vaultConfigs[vault].isActive) revert VaultNotActive(vault);
    if (newLowerBound == 0) revert InvalidBounds();

    VaultConfig storage config = vaultConfigs[vault];
    
    // Ensure current exchange rate would be within new bounds
    uint256 currentRate = IERC4626(vault).convertToAssets(_baseCurrencyUnit);
    uint256 newUpperBound = _calcUpperBound(newLowerBound);
    
    if (currentRate < newLowerBound || currentRate > newUpperBound) {
      revert ExchangeRateOutOfBounds(vault);
    }

    config.lowerBound = newLowerBound;
    config.lastBoundsUpdate = block.timestamp;
    
    emit BoundsUpdated(vault, newLowerBound, newUpperBound);
  }

  /* BOUNDS CALCULATION */

  /**
   * @notice Calculate upper bound from lower bound
   * @param lowerBound The lower bound value
   * @return The upper bound (lowerBound * 1.02)
   */
  function _calcUpperBound(uint256 lowerBound) internal pure returns (uint256) {
    return lowerBound * (PERCENTAGE_FACTOR + WINDOW_SIZE) / PERCENTAGE_FACTOR;
  }

  /**
   * @notice Calculate lower bound from exchange rate with buffer
   * @param exchangeRate The current exchange rate
   * @return The lower bound (exchangeRate * 0.99)
   */
  function _calcLowerBound(uint256 exchangeRate) internal pure returns (uint256) {
    return exchangeRate * (PERCENTAGE_FACTOR - BUFFER_SIZE) / PERCENTAGE_FACTOR;
  }

  /* VIEW FUNCTIONS */

  /**
   * @notice Get the current bounds for a vault
   * @param vault The vault address
   * @return lowerBound The lower bound for exchange rate
   * @return upperBound The upper bound for exchange rate
   */
  function getVaultBounds(address vault) external view returns (uint256 lowerBound, uint256 upperBound) {
    uint256 lb = vaultConfigs[vault].lowerBound;
    return (lb, _calcUpperBound(lb));
  }

  /**
   * @notice Get the lower bound for a vault
   * @param vault The vault address
   * @return The lower bound for exchange rate
   */
  function getLowerBound(address vault) external view returns (uint256) {
    return vaultConfigs[vault].lowerBound;
  }

  /**
   * @notice Get the upper bound for a vault
   * @param vault The vault address
   * @return The upper bound for exchange rate
   */
  function getUpperBound(address vault) external view returns (uint256) {
    return _calcUpperBound(vaultConfigs[vault].lowerBound);
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

}
