// SPDX-License-Identifier: agpl-3.0
pragma solidity ^0.8.20;

import { DataTypes } from "../protocol/libraries/types/DataTypes.sol";

/**
 * @title IPool
 * @dev Minimal interface for Pool - created to replace missing dlend dependency
 */
interface IPool {
  /**
   * @notice Returns the normalized income of the reserve
   * @param asset The address of the underlying asset of the reserve
   * @return The reserve's normalized income
   */
  function getReserveNormalizedIncome(address asset) external view returns (uint256);

  /**
   * @notice Returns the reserve data
   * @param asset The address of the underlying asset of the reserve
   * @return The reserve data
   */
  function getReserveData(address asset) external view returns (DataTypes.ReserveData memory);

  /**
   * @notice Deposits an `amount` of underlying asset into the reserve, receiving in return overlying aTokens.
   * @param asset The address of the underlying asset to deposit
   * @param amount The amount to be deposited
   * @param onBehalfOf The address that will receive the aTokens, same as msg.sender if the user
   * @param referralCode Code used to register the integrator originating the operation, for potential rewards.
   */
  function deposit(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;

  /**
   * @notice Withdraws an `amount` of underlying asset from the reserve, burning the equivalent aTokens owned
   * @param asset The address of the underlying asset to withdraw
   * @param amount The underlying amount to be withdrawn
   * @param to The address that will receive the underlying, same as msg.sender if the user
   * @return The final amount withdrawn
   */
  function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}
