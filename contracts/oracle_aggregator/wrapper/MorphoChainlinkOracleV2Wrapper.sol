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

import { IMorphoOracle } from "../interface/morpho/IMorphoOracle.sol";
import "../interface/morpho/BaseMorphoWrapper.sol";

/**
 * @title MorphoChainlinkOracleV2Wrapper
 * @dev Implementation of BaseMorphoWrapper for MorphoChainlinkOracleV2 oracles
 * @notice This wrapper allows integration of MorphoChainlinkOracleV2 oracles with the OracleAggregator
 */
contract MorphoChainlinkOracleV2Wrapper is BaseMorphoWrapper {
  /* Core state */

  /// @notice Mapping from asset address to corresponding MorphoChainlinkOracleV2 contract
  mapping(address => IMorphoOracle) public assetToOracle;

  /* Events */

  /// @notice Emitted when a new oracle is set for an asset
  event OracleSet(address indexed asset, address indexed oracle);

  /// @notice Emitted when an oracle is removed for an asset
  event OracleRemoved(address indexed asset);

  /* Errors */

  /// @notice Thrown when no oracle is configured for the requested asset
  error OracleNotSet(address asset);

  /**
   * @notice Constructor to initialize the MorphoChainlinkOracleV2Wrapper
   * @param baseCurrency The address of the base currency (zero address for USD)
   * @param _baseCurrencyUnit The decimal precision of the base currency (e.g., 1e8 for USD)
   */
  constructor(address baseCurrency, uint256 _baseCurrencyUnit) BaseMorphoWrapper(baseCurrency, _baseCurrencyUnit) {}

  /**
   * @notice Sets the MorphoChainlinkOracleV2 contract for a specific asset
   * @param asset The address of the asset
   * @param oracle The address of the MorphoChainlinkOracleV2 contract for this asset
   */
  function setOracle(address asset, address oracle) external onlyRole(ORACLE_MANAGER_ROLE) {
    assetToOracle[asset] = IMorphoOracle(oracle);
    emit OracleSet(asset, oracle);
  }

  /**
   * @notice Removes the oracle configuration for a specific asset
   * @param asset The address of the asset
   */
  function removeOracle(address asset) external onlyRole(ORACLE_MANAGER_ROLE) {
    delete assetToOracle[asset];
    emit OracleRemoved(asset);
  }

  /**
   * @notice Gets the price information for an asset
   * @param asset The address of the asset to get the price for
   * @return price The price of the asset in base currency units
   * @return isAlive Whether the price feed is considered active (always true for Morpho oracles)
   * @dev Morpho oracles compute prices on-demand, so they are always considered "alive"
   *      unless the price() call reverts
   */
  function getPriceInfo(address asset) public view virtual override returns (uint256 price, bool isAlive) {
    IMorphoOracle oracle = assetToOracle[asset];
    if (address(oracle) == address(0)) {
      revert OracleNotSet(asset);
    }

    try oracle.price() returns (uint256 morphoPrice) {
      // Convert from Morpho scale (1e36) to base currency units
      price = _convertFromMorphoScale(morphoPrice);
      isAlive = price > 0;
    } catch {
      // If price() call fails, return price as 0 and not alive
      price = 0;
      isAlive = false;
    }
  }

  /**
   * @notice Gets the current price of an asset
   * @param asset The address of the asset to get the price for
   * @return The current price of the asset in base currency units
   * @dev This function reverts if the oracle is not set or if the price call fails
   */
  function getAssetPrice(address asset) external view override returns (uint256) {
    (uint256 price, bool isAlive) = getPriceInfo(asset);
    if (!isAlive) {
      revert OraclePriceError();
    }
    return price;
  }
}
