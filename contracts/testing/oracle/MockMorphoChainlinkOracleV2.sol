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

import { IMorphoOracle } from "../../oracle_aggregator/interface/morpho/IMorphoOracle.sol";

/**
 * @title MockMorphoChainlinkOracleV2
 * @notice Mock implementation of MorphoChainlinkOracleV2 for testing purposes
 * @dev This mock allows setting prices and simulating failures for comprehensive testing
 */
contract MockMorphoChainlinkOracleV2 is IMorphoOracle {
  /// @notice The mocked price scaled by 1e36 (Morpho Blue standard)
  uint256 private _mockPrice;

  /// @notice Flag to simulate oracle failure
  bool private _shouldRevert;

  /// @notice Custom error message for simulated failures
  string private _revertMessage;

  /// @notice Events for testing
  event PriceSet(uint256 newPrice);
  event RevertBehaviorSet(bool shouldRevert, string revertMessage);

  /**
   * @notice Constructor to initialize the mock oracle
   * @param initialPrice The initial price to set (scaled by 1e36)
   */
  constructor(uint256 initialPrice) {
    _mockPrice = initialPrice;
    _shouldRevert = false;
    _revertMessage = "MockMorphoOracle: Simulated failure";
  }

  /**
   * @notice Set the mock price that the oracle should return
   * @param newPrice The new price to set (scaled by 1e36)
   */
  function setMockPrice(uint256 newPrice) external {
    _mockPrice = newPrice;
    emit PriceSet(newPrice);
  }

  /**
   * @notice Configure whether the oracle should revert when price() is called
   * @param shouldRevert Whether to revert on price() calls
   * @param revertMessage Custom error message for reverts
   */
  function setRevertBehavior(bool shouldRevert, string memory revertMessage) external {
    _shouldRevert = shouldRevert;
    _revertMessage = revertMessage;
    emit RevertBehaviorSet(shouldRevert, revertMessage);
  }

  /**
   * @notice Configure the oracle to revert with default message
   * @param shouldRevert Whether to revert on price() calls
   */
  function setRevertBehavior(bool shouldRevert) external {
    _shouldRevert = shouldRevert;
    emit RevertBehaviorSet(shouldRevert, _revertMessage);
  }

  /**
   * @notice Returns the current mock price or reverts if configured to do so
   * @return The current price scaled by 1e36
   * @dev This mimics the behavior of the real MorphoChainlinkOracleV2.price() function
   */
  function price() external view override returns (uint256) {
    if (_shouldRevert) {
      revert(_revertMessage);
    }
    return _mockPrice;
  }

  /**
   * @notice Get the current mock price without reverting (for testing purposes)
   * @return The current mock price
   */
  function getMockPrice() external view returns (uint256) {
    return _mockPrice;
  }

  /**
   * @notice Check if the oracle is configured to revert
   * @return Whether the oracle will revert on price() calls
   */
  function willRevert() external view returns (bool) {
    return _shouldRevert;
  }

  /**
   * @notice Get the current revert message
   * @return The message used when reverting
   */
  function getRevertMessage() external view returns (string memory) {
    return _revertMessage;
  }
}
