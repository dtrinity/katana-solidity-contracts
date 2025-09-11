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

import "./MorphoChainlinkOracleV2Wrapper.sol";
import "./ThresholdingUtils.sol";

/**
 * @title MorphoChainlinkOracleV2WrapperWithThresholding
 * @dev Extension of MorphoChainlinkOracleV2Wrapper that adds price thresholding functionality
 * @notice This wrapper applies thresholding logic to prices returned by MorphoChainlinkOracleV2 oracles
 */
contract MorphoChainlinkOracleV2WrapperWithThresholding is MorphoChainlinkOracleV2Wrapper, ThresholdingUtils {
  /* State */

  /// @notice Mapping from asset address to threshold configuration
  mapping(address => ThresholdConfig) public assetThresholds;

  /* Events */

  /// @notice Emitted when threshold configuration is set for an asset
  event ThresholdConfigSet(address indexed asset, uint256 lowerThresholdInBase, uint256 fixedPriceInBase);

  /// @notice Emitted when threshold configuration is removed for an asset
  event ThresholdConfigRemoved(address indexed asset);

  /**
   * @notice Constructor to initialize the wrapper with thresholding
   * @param baseCurrency The address of the base currency (zero address for USD)
   * @param _baseCurrencyUnit The decimal precision of the base currency (e.g., 1e8 for USD)
   */
  constructor(address baseCurrency, uint256 _baseCurrencyUnit) MorphoChainlinkOracleV2Wrapper(baseCurrency, _baseCurrencyUnit) {}

  /**
   * @notice Gets the price information for an asset with thresholding applied
   * @param asset The address of the asset to get the price for
   * @return price The price of the asset in base currency units with thresholding applied
   * @return isAlive Whether the price feed is considered active
   */
  function getPriceInfo(address asset) public view override returns (uint256 price, bool isAlive) {
    // Get the original price from the parent contract
    (price, isAlive) = super.getPriceInfo(asset);

    // Apply thresholding if the price is alive and threshold is configured
    if (isAlive) {
      ThresholdConfig memory config = assetThresholds[asset];
      if (config.lowerThresholdInBase > 0) {
        price = _applyThreshold(price, config);
      }
    }
  }

  /**
   * @notice Sets the threshold configuration for a specific asset
   * @param asset The address of the asset
   * @param lowerThresholdInBase The minimum price threshold in base currency units
   * @param fixedPriceInBase The fixed price to return when threshold is triggered
   * @dev Only callable by accounts with ORACLE_MANAGER_ROLE
   */
  function setThresholdConfig(
    address asset,
    uint256 lowerThresholdInBase,
    uint256 fixedPriceInBase
  ) external onlyRole(ORACLE_MANAGER_ROLE) {
    assetThresholds[asset] = ThresholdConfig({ lowerThresholdInBase: lowerThresholdInBase, fixedPriceInBase: fixedPriceInBase });
    emit ThresholdConfigSet(asset, lowerThresholdInBase, fixedPriceInBase);
  }

  /**
   * @notice Removes the threshold configuration for a specific asset
   * @param asset The address of the asset
   * @dev Only callable by accounts with ORACLE_MANAGER_ROLE
   */
  function removeThresholdConfig(address asset) external onlyRole(ORACLE_MANAGER_ROLE) {
    delete assetThresholds[asset];
    emit ThresholdConfigRemoved(asset);
  }
}
