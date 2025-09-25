// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IDStakeCollateralVaultV2 } from "./IDStakeCollateralVaultV2.sol";

/**
 * @title IDStakeRouterV2 Interface
 * @notice Defines the external functions of the DStakeRouter required by the DStakeTokenV2
 *         for handling deposits and withdrawals.
 */
interface IDStakeRouterV2 {
  function paused() external view returns (bool);

  function collateralVault() external view returns (IDStakeCollateralVaultV2);

  function dStakeToken() external view returns (address);

  /**
   * @notice Handles the conversion of deposited dStable asset into a chosen `strategyShare`
   *         and informs the collateral vault.
   * @dev Called by `DStakeTokenV2._deposit()` after the token has received the dStable asset.
   * @dev The router MUST pull `dStableAmount` from the caller (`DStakeTokenV2`).
   * @param dStableAmount The amount of dStable asset deposited by the user into the DStakeTokenV2.
   */
  function deposit(uint256 dStableAmount) external;

  /**
   * @notice Converts strategy shares back into dStable for a withdrawal.
   * @dev Called by `DStakeTokenV2._withdraw()` after the token has burned shares.
   *      The router returns the gross amount withdrawn so the token can apply fees centrally.
   * @param dStableAmount The gross amount of dStable the token expects to receive from the router.
   * @return totalWithdrawn The gross amount actually returned to the caller (must be ≥ `dStableAmount`).
   */
  function withdraw(uint256 dStableAmount) external returns (uint256 totalWithdrawn);

  /**
   * @notice Exchanges collateral from one strategy vault to another.
   * @dev Only callable by authorized strategy rebalancers.
   * @param fromVault The strategy vault to exchange from.
   * @param toVault The strategy vault to exchange to.
   * @param amount The amount of dStable equivalent to exchange.
   * @param minToStrategyShareAmount The minimum amount of toVault strategy shares expected.
   */
  function rebalanceStrategiesByValue(address fromVault, address toVault, uint256 amount, uint256 minToStrategyShareAmount) external;

  /**
   * @notice Solver-facing deposit method using asset amounts
   * @dev Called by DStakeTokenV2 solver methods to deposit into multiple strategy vaults using asset amounts
   * @param strategyVaults Array of strategy vault addresses to deposit into
   * @param assets Array of asset amounts to deposit into each strategy vault
   */
  function solverDepositAssets(address[] calldata strategyVaults, uint256[] calldata assets) external;

  /**
   * @notice Solver-facing deposit method using share amounts
   * @dev Called by DStakeTokenV2 solver methods to deposit into multiple strategy vaults using share amounts
   * @param strategyVaults Array of strategy vault addresses to deposit into
   * @param strategyShares Array of strategy share amounts to deposit into each strategy vault
   */
  function solverDepositShares(address[] calldata strategyVaults, uint256[] calldata strategyShares) external;

  /**
   * @notice Solver-facing withdrawal method using asset amounts.
   * @dev Called by DStakeTokenV2 solver methods after shares are burned. The router collects the
   *      requested vault assets, converts them to dStable, and returns the gross proceeds to the caller.
   * @param strategyVaults Array of strategy vault addresses to withdraw from.
   * @param assets Array of gross dStable amounts to withdraw from each strategy vault.
   * @return totalWithdrawn The total gross dStable returned to the caller.
   */
  function solverWithdrawAssets(address[] calldata strategyVaults, uint256[] calldata assets) external returns (uint256 totalWithdrawn);

  /**
   * @notice Solver-facing withdrawal method using strategy share amounts.
   * @dev Called by DStakeTokenV2 solver methods after shares are burned. The router converts the
   *      provided strategy shares into dStable and returns the gross proceeds to the caller.
   * @param strategyVaults Array of strategy vault addresses to withdraw from.
   * @param strategyShares Array of strategy share amounts to withdraw from each strategy vault.
   * @return totalWithdrawn The total gross dStable returned to the caller.
   */
  function solverWithdrawShares(
    address[] calldata strategyVaults,
    uint256[] calldata strategyShares
  ) external returns (uint256 totalWithdrawn);

  function getActiveVaultsForDeposits() external view returns (address[] memory activeVaults);

  function getMaxSingleVaultWithdraw() external view returns (uint256 maxAssets);
}
