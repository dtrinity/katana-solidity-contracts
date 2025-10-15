// SPDX-License-Identifier: agpl-3.0
pragma solidity ^0.8.20;

/**
 * @title IPoolAddressesProvider
 * @dev Minimal interface for pool addresses provider - created to replace missing dlend dependency
 */
interface IPoolAddressesProvider {
    /**
     * @notice Returns the address of the Pool
     * @return The address of the Pool
     */
    function getPool() external view returns (address);

    /**
     * @notice Returns the address of the price oracle
     * @return The address of the price oracle
     */
    function getPriceOracle() external view returns (address);
}
