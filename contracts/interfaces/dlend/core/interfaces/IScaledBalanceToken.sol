// SPDX-License-Identifier: agpl-3.0
pragma solidity ^0.8.20;

/**
 * @title IScaledBalanceToken
 * @dev Minimal interface for scaled balance tokens - created to replace missing dlend dependency
 */
interface IScaledBalanceToken {
  /**
   * @notice Returns the scaled balance of the user.
   * @param user The address of the user
   * @return The scaled balance of the user
   */
  function scaledBalanceOf(address user) external view returns (uint256);

  /**
   * @notice Returns the scaled total supply of the scaled balance token. Represents sum(debt/index)
   * @return The scaled total supply
   */
  function scaledTotalSupply() external view returns (uint256);

  /**
   * @notice Returns last index interest was accrued to the user's balance
   * @param user The address of the user
   * @return The last index interest was accrued to the user's balance, expressed in ray
   */
  function getPreviousIndex(address user) external view returns (uint256);
}
