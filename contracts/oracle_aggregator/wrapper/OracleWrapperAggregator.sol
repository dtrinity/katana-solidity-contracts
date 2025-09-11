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
import "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title OracleWrapperAggregator
 * @notice Aggregates prices from two oracle wrappers to create composite pricing
 * @dev Returns price representing how many quote assets you get for 1 base asset, scaled by scale factor
 *      Similar to MorphoChainlinkOracleV2 but uses IOracleWrapper interfaces instead of Chainlink feeds
 */
contract OracleWrapperAggregator is IOracleWrapper, AccessControl {
  using Math for uint256;

  /* IMMUTABLES */

  /// @notice Base oracle wrapper (asset being priced)
  IOracleWrapper public immutable BASE_WRAPPER;

  /// @notice Quote oracle wrapper (asset used as pricing denomination)
  IOracleWrapper public immutable QUOTE_WRAPPER;

  /// @notice Base currency address
  address private immutable _baseCurrency;

  /// @notice Base currency unit (e.g., 1e8 for USD)
  uint256 public immutable baseCurrencyUnit;

  /* ROLES */

  /// @notice Role for managing oracle configurations (inherited from IOracleWrapper pattern)
  bytes32 public constant ORACLE_MANAGER_ROLE = keccak256("ORACLE_MANAGER_ROLE");

  /* ERRORS */

  /// @notice Thrown when oracle wrapper call fails
  error OracleWrapperCallFailed();

  /// @notice Thrown when quote price is zero
  error ZeroQuotePrice();

  /// @notice Thrown when base price is zero
  error ZeroBasePrice();

  /// @notice Thrown when base wrapper address is zero
  error ZeroBaseWrapperAddress();

  /// @notice Thrown when quote wrapper address is zero
  error ZeroQuoteWrapperAddress();

  /// @notice Thrown when base currency unit is zero
  error ZeroBaseCurrencyUnit();

  /**
   * @notice Constructor to initialize the oracle wrapper aggregator
   * @param baseWrapper Address of the base oracle wrapper (asset being priced)
   * @param quoteWrapper Address of the quote oracle wrapper (asset used for pricing)
   * @param baseCurrency Address of the base currency for this aggregator's output
   * @param _baseCurrencyUnit Base currency unit for this aggregator's output (e.g., 1e8 for USD, 1e18 for ETH)
   * @dev The aggregator normalizes input prices from different wrappers to its own baseCurrencyUnit format
   */
  constructor(address baseWrapper, address quoteWrapper, address baseCurrency, uint256 _baseCurrencyUnit) {
    if (baseWrapper == address(0)) {
      revert ZeroBaseWrapperAddress();
    }
    if (quoteWrapper == address(0)) {
      revert ZeroQuoteWrapperAddress();
    }
    if (_baseCurrencyUnit == 0) {
      revert ZeroBaseCurrencyUnit();
    }

    BASE_WRAPPER = IOracleWrapper(baseWrapper);
    QUOTE_WRAPPER = IOracleWrapper(quoteWrapper);
    _baseCurrency = baseCurrency;
    baseCurrencyUnit = _baseCurrencyUnit;

    _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    _grantRole(ORACLE_MANAGER_ROLE, msg.sender);
  }

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
    return baseCurrencyUnit;
  }

  /**
   * @notice Gets the composite price information
   * @param asset The asset address (used for compatibility, but aggregator computes fixed pair)
   * @return price Composite price representing how many quote assets per base asset
   * @return isAlive Whether both underlying oracle feeds are alive
   * @dev Price calculation: (normalizedBasePrice / normalizedQuotePrice) in baseCurrencyUnit format
   */
  function getPriceInfo(address asset) public view override returns (uint256 price, bool isAlive) {
    // Get price info from both wrappers
    (uint256 basePrice, bool baseAlive) = BASE_WRAPPER.getPriceInfo(asset);
    (uint256 quotePrice, bool quoteAlive) = QUOTE_WRAPPER.getPriceInfo(asset);

    // Check if both feeds are alive
    isAlive = baseAlive && quoteAlive;

    if (!isAlive) {
      return (0, false);
    }

    // Validate prices are non-zero
    if (basePrice == 0 || quotePrice == 0) {
      return (0, false);
    }

    // Normalize both prices to this aggregator's baseCurrencyUnit
    uint256 baseWrapperUnit = BASE_WRAPPER.BASE_CURRENCY_UNIT();
    uint256 quoteWrapperUnit = QUOTE_WRAPPER.BASE_CURRENCY_UNIT();

    uint256 normalizedBasePrice = basePrice.mulDiv(baseCurrencyUnit, baseWrapperUnit);
    uint256 normalizedQuotePrice = quotePrice.mulDiv(baseCurrencyUnit, quoteWrapperUnit);

    // Calculate ratio: how many quote assets per 1 base asset (result is in baseCurrencyUnit format)
    price = normalizedBasePrice.mulDiv(baseCurrencyUnit, normalizedQuotePrice);
  }

  /**
   * @notice Gets the composite price
   * @param asset The asset address (for interface compatibility)
   * @return Composite price representing quote assets per base asset
   * @dev Reverts if either underlying oracle is not alive
   */
  function getAssetPrice(address asset) external view override returns (uint256) {
    (uint256 price, bool isAlive) = getPriceInfo(asset);

    if (!isAlive) {
      revert OracleWrapperCallFailed();
    }

    return price;
  }

  /**
   * @notice Get information about the underlying oracle wrappers
   * @return baseWrapper Address of the base wrapper
   * @return quoteWrapper Address of the quote wrapper
   * @return aggregatorBaseCurrencyUnit The base currency unit used by this aggregator
   */
  function getOracleInfo() external view returns (address baseWrapper, address quoteWrapper, uint256 aggregatorBaseCurrencyUnit) {
    return (address(BASE_WRAPPER), address(QUOTE_WRAPPER), baseCurrencyUnit);
  }
}
