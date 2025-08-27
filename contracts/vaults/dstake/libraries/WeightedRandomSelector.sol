// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title WeightedRandomSelector
 * @notice Library for weighted random selection of items from arrays
 * @dev Provides stateless functions for implementing weighted random selection algorithms
 *      used in the DStake Morpho Router V2 for vault selection during deposits and withdrawals
 *
 * IMPORTANT: PREDICTABLE RANDOMNESS IS INTENTIONAL AND NOT A SECURITY ISSUE
 *
 * The "randomness" in this library serves UX optimization and automatic rebalancing purposes,
 * NOT security or access control. Here's why predictable randomness is acceptable:
 *
 * 1. UX ENHANCEMENT, NOT SECURITY:
 *    - Users can already interact directly with Morpho vaults if they want specific routing
 *    - The router provides convenience and automatic rebalancing as an optional service layer
 *    - "Randomness" distributes load and provides variation in user experience
 *
 * 2. GAMING SELECTION IS EQUIVALENT TO DIRECT VAULT CHOICE:
 *    - If a user can predict which vault will be selected, they achieve the same outcome
 *      as if they had directly interacted with that vault through Morpho
 *    - There is no additional benefit or attack vector created by this predictability
 *    - All vaults in the selection pool are pre-approved and considered equivalent for user needs
 *
 * 3. TRANSPARENT REBALANCING:
 *    - Predictable selection allows for deterministic rebalancing toward target allocations
 *    - This is actually beneficial for protocol health and user expectations
 *    - Users and integrators can model expected behavior for better UX
 *
 * 4. NO FINANCIAL ADVANTAGE:
 *    - All vaults offer similar risk/reward profiles (they're in the same selection pool)
 *    - No vault provides systematically better returns that would incentivize gaming
 *    - MEV opportunities are limited since vault selection doesn't affect pricing
 *
 * This design choice prioritizes gas efficiency, simplicity, and predictable rebalancing
 * over cryptographic randomness that would provide no meaningful security benefit.
 */
library WeightedRandomSelector {
  /// @dev Error thrown when arrays have mismatched lengths
  error ArrayLengthMismatch();

  /// @dev Error thrown when no items are available for selection
  error NoItemsAvailable();

  /// @dev Error thrown when requesting more items than available
  error InsufficientItems();

  /// @dev Error thrown when all weights are zero
  error AllWeightsZero();

  /**
   * @notice Calculates weights for deposit allocation based on target vs current allocations
   * @dev Weight = max(0, targetBps - currentBps) for underweight vaults
   * @param currentAllocations Array of current allocations in basis points
   * @param targetAllocations Array of target allocations in basis points
   * @return weights Array of calculated weights for selection
   */
  function calculateDepositWeights(
    uint256[] memory currentAllocations,
    uint256[] memory targetAllocations
  ) internal pure returns (uint256[] memory weights) {
    if (currentAllocations.length != targetAllocations.length) {
      revert ArrayLengthMismatch();
    }

    weights = new uint256[](currentAllocations.length);

    for (uint256 i = 0; i < currentAllocations.length; i++) {
      // Weight = max(0, target - current) for underweight vaults
      if (targetAllocations[i] > currentAllocations[i]) {
        weights[i] = targetAllocations[i] - currentAllocations[i];
      } else {
        weights[i] = 0;
      }
    }
  }

  /**
   * @notice Calculates weights for withdrawal allocation based on current vs target allocations
   * @dev Weight = max(0, currentBps - targetBps) for overweight vaults
   * @param currentAllocations Array of current allocations in basis points
   * @param targetAllocations Array of target allocations in basis points
   * @return weights Array of calculated weights for selection
   */
  function calculateWithdrawalWeights(
    uint256[] memory currentAllocations,
    uint256[] memory targetAllocations
  ) internal pure returns (uint256[] memory weights) {
    if (currentAllocations.length != targetAllocations.length) {
      revert ArrayLengthMismatch();
    }

    weights = new uint256[](currentAllocations.length);

    for (uint256 i = 0; i < currentAllocations.length; i++) {
      // Weight = max(0, current - target) for overweight vaults
      if (currentAllocations[i] > targetAllocations[i]) {
        weights[i] = currentAllocations[i] - targetAllocations[i];
      } else {
        weights[i] = 0;
      }
    }
  }

  /**
   * @notice Selects N items from an array using weighted random selection without replacement
   * @dev Uses cumulative weight distribution for selection
   * @param items Array of items to select from
   * @param weights Array of weights corresponding to each item
   * @param count Number of items to select (must be <= items.length)
   * @param randomSeed Random seed for selection
   * @return selected Array of selected items
   * @return selectedIndices Array of indices of selected items
   */
  function selectWeightedRandom(
    address[] memory items,
    uint256[] memory weights,
    uint256 count,
    uint256 randomSeed
  ) internal pure returns (address[] memory selected, uint256[] memory selectedIndices) {
    if (items.length != weights.length) {
      revert ArrayLengthMismatch();
    }

    if (items.length == 0) {
      revert NoItemsAvailable();
    }

    if (count > items.length) {
      revert InsufficientItems();
    }

    if (count == 0) {
      return (new address[](0), new uint256[](0));
    }

    // Handle edge case where only one item requested or available
    if (count == 1 || items.length == 1) {
      uint256 selectedIndex = _selectSingleWeightedRandom(weights, randomSeed);
      selected = new address[](1);
      selectedIndices = new uint256[](1);
      selected[0] = items[selectedIndex];
      selectedIndices[0] = selectedIndex;
      return (selected, selectedIndices);
    }

    // Create working arrays to avoid modifying input
    address[] memory workingItems = new address[](items.length);
    uint256[] memory workingWeights = new uint256[](weights.length);
    bool[] memory isSelected = new bool[](items.length);

    for (uint256 i = 0; i < items.length; i++) {
      workingItems[i] = items[i];
      workingWeights[i] = weights[i];
    }

    selected = new address[](count);
    selectedIndices = new uint256[](count);

    for (uint256 selectionRound = 0; selectionRound < count; selectionRound++) {
      // Calculate total weight of unselected items
      uint256 totalWeight = 0;
      for (uint256 i = 0; i < workingWeights.length; i++) {
        if (!isSelected[i]) {
          totalWeight += workingWeights[i];
        }
      }

      // If all remaining weights are zero, select randomly from remaining items
      if (totalWeight == 0) {
        uint256 remainingCount = 0;
        for (uint256 i = 0; i < isSelected.length; i++) {
          if (!isSelected[i]) remainingCount++;
        }

        if (remainingCount == 0) {
          revert NoItemsAvailable();
        }

        // Select randomly from unselected items
        uint256 targetIndex = uint256(keccak256(abi.encode(randomSeed, selectionRound))) % remainingCount;
        uint256 currentIndex = 0;

        for (uint256 i = 0; i < isSelected.length; i++) {
          if (!isSelected[i]) {
            if (currentIndex == targetIndex) {
              selected[selectionRound] = workingItems[i];
              selectedIndices[selectionRound] = i;
              isSelected[i] = true;
              break;
            }
            currentIndex++;
          }
        }
      } else {
        // Generate random number for weighted selection
        uint256 randomValue = uint256(keccak256(abi.encode(randomSeed, selectionRound))) % totalWeight;
        uint256 cumulativeWeight = 0;

        // Find the selected item using cumulative weights
        for (uint256 i = 0; i < workingWeights.length; i++) {
          if (!isSelected[i]) {
            cumulativeWeight += workingWeights[i];
            if (randomValue < cumulativeWeight) {
              selected[selectionRound] = workingItems[i];
              selectedIndices[selectionRound] = i;
              isSelected[i] = true;
              break;
            }
          }
        }
      }
    }

    return (selected, selectedIndices);
  }

  /**
   * @notice Selects a single item using weighted random selection
   * @dev Internal helper function for single item selection
   * @param weights Array of weights for selection
   * @param randomSeed Random seed for selection
   * @return selectedIndex Index of the selected item
   */
  function _selectSingleWeightedRandom(uint256[] memory weights, uint256 randomSeed) private pure returns (uint256 selectedIndex) {
    uint256 totalWeight = 0;
    for (uint256 i = 0; i < weights.length; i++) {
      totalWeight += weights[i];
    }

    if (totalWeight == 0) {
      // If all weights are zero, select randomly
      return randomSeed % weights.length;
    }

    uint256 randomValue = randomSeed % totalWeight;
    uint256 cumulativeWeight = 0;

    for (uint256 i = 0; i < weights.length; i++) {
      cumulativeWeight += weights[i];
      if (randomValue < cumulativeWeight) {
        return i;
      }
    }

    // Fallback (should never reach here)
    return weights.length - 1;
  }

  /**
   * @notice Calculates the total weight from an array of weights
   * @param weights Array of weights
   * @return totalWeight Sum of all weights
   */
  function calculateTotalWeight(uint256[] memory weights) internal pure returns (uint256 totalWeight) {
    for (uint256 i = 0; i < weights.length; i++) {
      totalWeight += weights[i];
    }
  }

  /**
   * @notice Checks if any weights are non-zero
   * @param weights Array of weights to check
   * @return hasNonZeroWeight True if at least one weight is greater than zero
   */
  function hasNonZeroWeights(uint256[] memory weights) internal pure returns (bool hasNonZeroWeight) {
    for (uint256 i = 0; i < weights.length; i++) {
      if (weights[i] > 0) {
        return true;
      }
    }
    return false;
  }

  /**
   * @notice Generates a pseudo-random seed from multiple entropy sources
   * @dev Combines block properties, sender, and nonce for pseudo-randomness
   *
   * SECURITY NOTE: Predictable randomness is intentional and acceptable here.
   *
   * This function uses deterministic blockchain data (block.timestamp, block.prevrandao)
   * which can be influenced or predicted by miners/validators. However, this is NOT
   * a security vulnerability because:
   *
   * 1. EQUIVALENT OUTCOMES: Gaming this selection to choose a specific vault is
   *    equivalent to the user directly interacting with that vault via Morpho.
   *    There's no additional advantage gained.
   *
   * 2. PRE-APPROVED VAULTS: All vaults in the selection pool are pre-approved
   *    and considered safe/equivalent. There are no "bad" vaults to avoid.
   *
   * 3. NO MEV OPPORTUNITY: Vault selection doesn't affect pricing or create
   *    meaningful arbitrage opportunities that would incentivize manipulation.
   *
   * 4. UX BENEFIT: Predictable behavior allows users and integrators to model
   *    expected routing for better user experience and integration planning.
   *
   * The pseudo-randomness provides sufficient entropy for load distribution and
   * user experience variation while maintaining gas efficiency and simplicity.
   *
   * @param sender Address of the transaction sender
   * @param nonce Nonce value for additional entropy
   * @return randomSeed Generated pseudo-random seed
   */
  function generateRandomSeed(address sender, uint256 nonce) internal view returns (uint256 randomSeed) {
    return
      uint256(
        keccak256(
          abi.encodePacked(
            block.timestamp,
            block.prevrandao, // Replaces block.difficulty post-merge
            sender,
            nonce
          )
        )
      );
  }
}
