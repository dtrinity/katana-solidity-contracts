// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../../vaults/dstake/libraries/WeightedRandomSelector.sol";

/**
 * @title WeightedRandomSelectorHarness
 * @notice Test harness to expose library functions for unit testing
 */
contract WeightedRandomSelectorHarness {
  using WeightedRandomSelector for *;

  function calculateDepositWeights(
    uint256[] memory currentAllocations,
    uint256[] memory targetAllocations
  ) external pure returns (uint256[] memory) {
    return WeightedRandomSelector.calculateDepositWeights(currentAllocations, targetAllocations);
  }

  function calculateWithdrawalWeights(
    uint256[] memory currentAllocations,
    uint256[] memory targetAllocations
  ) external pure returns (uint256[] memory) {
    return WeightedRandomSelector.calculateWithdrawalWeights(currentAllocations, targetAllocations);
  }

  function selectWeightedRandom(
    address[] memory items,
    uint256[] memory weights,
    uint256 count,
    uint256 randomSeed
  ) external pure returns (address[] memory selected, uint256[] memory selectedIndices) {
    return WeightedRandomSelector.selectWeightedRandom(items, weights, count, randomSeed);
  }

  // Test helper to simulate single weighted random selection
  function testSelectSingleWeightedRandom(
    address[] memory items,
    uint256[] memory weights,
    uint256 randomSeed
  ) external pure returns (address selected, uint256 selectedIndex) {
    // Use the public selectWeightedRandom with count=1
    (address[] memory selectedArray, uint256[] memory selectedIndices) = WeightedRandomSelector.selectWeightedRandom(
      items,
      weights,
      1,
      randomSeed
    );
    return (selectedArray[0], selectedIndices[0]);
  }

  function calculateTotalWeight(uint256[] memory weights) external pure returns (uint256) {
    return WeightedRandomSelector.calculateTotalWeight(weights);
  }

  function hasNonZeroWeights(uint256[] memory weights) external pure returns (bool) {
    return WeightedRandomSelector.hasNonZeroWeights(weights);
  }

  function generateRandomSeed(address sender, uint256 nonce) external view returns (uint256) {
    return WeightedRandomSelector.generateRandomSeed(sender, nonce);
  }
}
