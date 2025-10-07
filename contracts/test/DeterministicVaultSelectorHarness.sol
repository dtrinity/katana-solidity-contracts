// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../vaults/dstake/libraries/DeterministicVaultSelector.sol";

/**
 * @title DeterministicVaultSelectorHarness
 * @notice Test harness to expose internal library functions for testing
 * @dev This contract is only used for testing purposes
 */
contract DeterministicVaultSelectorHarness {
  using DeterministicVaultSelector for *;

  /**
   * @notice Test wrapper for calculateUnderallocations
   */
  function calculateUnderallocations(
    uint256[] memory currentAllocations,
    uint256[] memory targetAllocations
  ) external pure returns (uint256[] memory) {
    return DeterministicVaultSelector.calculateUnderallocations(currentAllocations, targetAllocations);
  }

  /**
   * @notice Test wrapper for calculateOverallocations
   */
  function calculateOverallocations(
    uint256[] memory currentAllocations,
    uint256[] memory targetAllocations
  ) external pure returns (uint256[] memory) {
    return DeterministicVaultSelector.calculateOverallocations(currentAllocations, targetAllocations);
  }

  /**
   * @notice Test wrapper for selectTopUnderallocated
   */
  function selectTopUnderallocated(
    address[] memory vaults,
    uint256[] memory currentBps,
    uint256[] memory targetBps,
    uint256 count
  ) external pure returns (address[] memory selectedVaults, uint256[] memory selectedIndices) {
    return DeterministicVaultSelector.selectTopUnderallocated(vaults, currentBps, targetBps, count);
  }

  /**
   * @notice Test wrapper for selectTopOverallocated
   */
  function selectTopOverallocated(
    address[] memory vaults,
    uint256[] memory currentBps,
    uint256[] memory targetBps,
    uint256 count
  ) external pure returns (address[] memory selectedVaults, uint256[] memory selectedIndices) {
    return DeterministicVaultSelector.selectTopOverallocated(vaults, currentBps, targetBps, count);
  }
}
