// SPDX-License-Identifier: agpl-3.0
pragma solidity ^0.8.20;

/**
 * @title DataTypes
 * @dev Minimal data types library - created to replace missing dlend dependency
 */
library DataTypes {
    struct ReserveData {
        uint256 configuration;
        uint128 liquidityIndex;
        uint128 currentLiquidityRate;
        uint128 accruedToTreasury;
        uint40 lastUpdateTimestamp;
        address aTokenAddress;
        // Simplified version - only including fields that are actually used
        // Additional fields can be added if needed for compilation
    }
}
