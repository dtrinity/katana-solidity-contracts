// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IDStakeRouter Interface
 * @notice Defines the external functions of the DStakeRouter required by the DStakeToken
 *         for handling deposits and withdrawals.
 */
interface IDStakeRouter {
  /**
   * @notice Handles the conversion of deposited dStable asset into a chosen `vaultAsset`
   *         and informs the collateral vault.
   * @dev Called by `DStakeToken._deposit()` after the token has received the dStable asset.
   * @dev The router MUST pull `dStableAmount` from the caller (`DStakeToken`).
   * @param dStableAmount The amount of dStable asset deposited by the user into the DStakeToken.
   */
  function deposit(uint256 dStableAmount) external;

  /**
   * @notice Handles the conversion of a `vaultAsset` back into the dStable asset for withdrawal.
   * @dev Called by `DStakeToken._withdraw()`.
   * @dev The router coordinates pulling the required `vaultAsset` from the collateral vault
   *      and ensuring the converted dStable asset is sent to the `receiver`.
   * @param dStableAmount The amount of dStable asset to be withdrawn to the `receiver` (after vault fees).
   * @param receiver The address that will receive the withdrawn dStable asset.
   * @param owner The original owner initiating the withdrawal (typically the user burning shares).
   */
  function withdraw(uint256 dStableAmount, address receiver, address owner) external;

  /**
   * @notice Exchanges collateral from one vault asset to another.
   * @dev Only callable by authorized collateral exchangers.
   * @param fromVault The vault to exchange from.
   * @param toVault The vault to exchange to.
   * @param amount The amount of dStable equivalent to exchange.
   * @param minToVaultAssetAmount The minimum amount of toVault assets expected.
   */
  function exchangeCollateral(address fromVault, address toVault, uint256 amount, uint256 minToVaultAssetAmount) external;

  /**
   * @notice Solver-facing deposit method using asset amounts
   * @dev Called by DStakeToken solver methods to deposit into multiple vaults using asset amounts
   * @param vaults Array of vault addresses to deposit into
   * @param assets Array of asset amounts to deposit into each vault
   */
  function solverDepositAssets(address[] calldata vaults, uint256[] calldata assets) external;

  /**
   * @notice Solver-facing deposit method using share amounts
   * @dev Called by DStakeToken solver methods to deposit into multiple vaults using share amounts
   * @param vaults Array of vault addresses to deposit into
   * @param shares Array of share amounts to deposit into each vault
   */
  function solverDepositShares(address[] calldata vaults, uint256[] calldata shares) external;

  /**
   * @notice Solver-facing withdrawal method using asset amounts
   * @dev Called by DStakeToken solver methods to withdraw from multiple vaults using asset amounts
   * @param vaults Array of vault addresses to withdraw from
   * @param assets Array of asset amounts to withdraw from each vault
   * @param receiver The address that will receive the withdrawn dStable asset
   * @param owner The original owner initiating the withdrawal
   */
  function solverWithdrawAssets(
    address[] calldata vaults,
    uint256[] calldata assets,
    address receiver,
    address owner
  ) external returns (uint256 totalWithdrawn);

  /**
   * @notice Solver-facing withdrawal method using share amounts
   * @dev Called by DStakeToken solver methods to withdraw from multiple vaults using share amounts
   * @param vaults Array of vault addresses to withdraw from
   * @param shares Array of share amounts to withdraw from each vault
   * @param receiver The address that will receive the withdrawn dStable asset
   * @param owner The original owner initiating the withdrawal
   */
  function solverWithdrawShares(
    address[] calldata vaults,
    uint256[] calldata shares,
    address receiver,
    address owner
  ) external returns (uint256 totalWithdrawn);
}
