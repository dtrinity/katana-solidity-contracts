// SPDX-License-Identifier: agpl-3.0
pragma solidity ^0.8.20;

/**
 * @title IRewardsController
 * @dev Minimal interface for rewards controller - created to replace missing dlend dependency
 */
interface IRewardsController {
    /**
     * @dev Returns the list of available reward token addresses of an incentivized asset
     * @param asset The incentivized asset
     * @return List of rewards token addresses
     */
    function getRewardsByAsset(address asset) external view returns (address[] memory);

    /**
     * @dev Claims reward for an user, on the assets of the message sender
     * @param assets The list of assets to check eligible distributions before claiming rewards
     * @param amount The amount of rewards to claim
     * @param to The address that will receive the rewards
     * @param reward The address of the reward token
     * @return The amount of rewards claimed
     */
    function claimRewards(
        address[] calldata assets,
        uint256 amount,
        address to,
        address reward
    ) external returns (uint256);

    /**
     * @dev Returns the claimer for a specific user
     * @param user The user address
     * @return The claimer address
     */
    function getClaimer(address user) external view returns (address);

    /**
     * @dev Returns the index of an asset and asset rewards accrued by a specific user
     * @param asset The asset to incentivize
     * @param reward The reward token that incentives the asset
     * @return The assets index, rewards accrued
     */
    function getAssetIndex(address asset, address reward) external view returns (uint256, uint256);

    /**
     * @dev Returns the user rewards accrued by a specific user
     * @param assets The list of assets to check eligible distributions
     * @param user The user address
     * @param reward The reward token address
     * @return The amount of unclaimed rewards
     */
    function getUserRewards(address[] calldata assets, address user, address reward) external view returns (uint256);
}
