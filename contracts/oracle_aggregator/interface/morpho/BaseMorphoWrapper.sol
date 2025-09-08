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

import "../IOracleWrapper.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title BaseMorphoWrapper
 * @dev Abstract contract that implements the IOracleWrapper interface for Morpho oracles
 * Provides common functionality for all Morpho oracle wrappers
 */
abstract contract BaseMorphoWrapper is IOracleWrapper, AccessControl {
  /* Core state */

  /// @notice Morpho Blue oracle price scaling factor (1e36)
  uint256 public constant MORPHO_PRICE_SCALE = 10 ** 36;

  /// @notice Base currency address (zero address for USD)
  address private immutable _baseCurrency;

  /// @notice Base currency unit (e.g., 1e8 for USD)
  uint256 public immutable BASE_CURRENCY_UNIT;

  /* Roles */

  /// @notice Role for managing oracle configurations
  bytes32 public constant ORACLE_MANAGER_ROLE = keccak256("ORACLE_MANAGER_ROLE");

  /* Errors */

  /// @notice Thrown when oracle price calculation fails
  error OraclePriceError();

  /**
   * @dev Constructor that sets the base currency and base currency unit
   * @param baseCurrency The address of the base currency (zero address for USD)
   * @param _baseCurrencyUnit The decimal precision of the base currency (e.g., 1e8 for USD)
   */
  constructor(address baseCurrency, uint256 _baseCurrencyUnit) {
    _baseCurrency = baseCurrency;
    BASE_CURRENCY_UNIT = _baseCurrencyUnit;
    _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    _grantRole(ORACLE_MANAGER_ROLE, msg.sender);
  }

  /**
   * @notice Returns the base currency address
   * @return Returns the base currency address
   */
  function BASE_CURRENCY() external view override returns (address) {
    return _baseCurrency;
  }

  /**
   * @notice Gets the price information for an asset
   * @param asset The address of the asset to get the price for
   * @return price The price of the asset in base currency units
   * @return isAlive Whether the price feed is considered active/valid
   */
  function getPriceInfo(address asset) public view virtual override returns (uint256 price, bool isAlive);

  /**
   * @notice Gets the current price of an asset
   * @param asset The address of the asset to get the price for
   * @return The current price of the asset
   */
  function getAssetPrice(address asset) external view virtual override returns (uint256) {
    (uint256 price, bool isAlive) = getPriceInfo(asset);
    if (!isAlive) {
      revert OraclePriceError();
    }
    return price;
  }

  /**
   * @dev Converts a price from Morpho scale (1e36) to base currency decimals
   * @param morphoPrice The price from Morpho oracle (scaled by 1e36)
   * @return The price in base currency decimals
   */
  function _convertFromMorphoScale(uint256 morphoPrice) internal view returns (uint256) {
    return (morphoPrice * BASE_CURRENCY_UNIT) / MORPHO_PRICE_SCALE;
  }
}
