// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { BasisPointConstants } from "../../../common/BasisPointConstants.sol";

/**
 * @title AllocationCalculator
 * @notice Library for calculating allocations, deficits, and amount distributions
 * @dev Provides stateless functions for allocation calculations used in the DStake Morpho Router V2
 */
library AllocationCalculator {
    
    /// @dev Error thrown when arrays have mismatched lengths
    error ArrayLengthMismatch();
    
    /// @dev Error thrown when division by zero would occur
    error DivisionByZero();
    
    /// @dev Error thrown when basis points exceed maximum (10,000)
    error InvalidBasisPoints();
    
    /// @dev Error thrown when vault balances sum to zero
    error ZeroTotalBalance();

    /**
     * @notice Calculates current allocations in basis points from vault balances
     * @dev Allocation for vault i = (balance[i] * BasisPointConstants.ONE_HUNDRED_PERCENT_BPS) / totalBalance
     * @param vaultBalances Array of vault balances
     * @return allocations Array of current allocations in basis points
     * @return totalBalance Sum of all vault balances
     */
    function calculateCurrentAllocations(
        uint256[] memory vaultBalances
    ) internal pure returns (uint256[] memory allocations, uint256 totalBalance) {
        if (vaultBalances.length == 0) {
            return (new uint256[](0), 0);
        }

        // Calculate total balance
        totalBalance = 0;
        for (uint256 i = 0; i < vaultBalances.length; i++) {
            totalBalance += vaultBalances[i];
        }

        allocations = new uint256[](vaultBalances.length);
        
        // Handle edge case where all balances are zero
        if (totalBalance == 0) {
            // All allocations remain 0
            return (allocations, totalBalance);
        }

        // Calculate allocations in basis points
        for (uint256 i = 0; i < vaultBalances.length; i++) {
            allocations[i] = (vaultBalances[i] * BasisPointConstants.ONE_HUNDRED_PERCENT_BPS) / totalBalance;
        }

        return (allocations, totalBalance);
    }

    /**
     * @notice Calculates deficits and surpluses compared to target allocations
     * @dev Deficit = max(0, target - current), Surplus = max(0, current - target)
     * @param currentAllocations Current allocations in basis points
     * @param targetAllocations Target allocations in basis points
     * @return deficits Array of deficits in basis points (underweight amounts)
     * @return surpluses Array of surpluses in basis points (overweight amounts)
     * @return totalDeficit Sum of all deficits
     * @return totalSurplus Sum of all surpluses
     */
    function calculateDeficitsAndSurpluses(
        uint256[] memory currentAllocations,
        uint256[] memory targetAllocations
    ) internal pure returns (
        uint256[] memory deficits,
        uint256[] memory surpluses,
        uint256 totalDeficit,
        uint256 totalSurplus
    ) {
        if (currentAllocations.length != targetAllocations.length) {
            revert ArrayLengthMismatch();
        }

        uint256 length = currentAllocations.length;
        deficits = new uint256[](length);
        surpluses = new uint256[](length);
        
        for (uint256 i = 0; i < length; i++) {
            if (currentAllocations[i] < targetAllocations[i]) {
                deficits[i] = targetAllocations[i] - currentAllocations[i];
                totalDeficit += deficits[i];
            } else if (currentAllocations[i] > targetAllocations[i]) {
                surpluses[i] = currentAllocations[i] - targetAllocations[i];
                totalSurplus += surpluses[i];
            }
        }

        return (deficits, surpluses, totalDeficit, totalSurplus);
    }

    /**
     * @notice Splits an amount equally among N vaults with proper rounding
     * @dev Distributes any remainder to the first vaults to ensure exact total
     * @param totalAmount Total amount to split
     * @param vaultCount Number of vaults to split among
     * @return amounts Array of amounts for each vault
     */
    function splitAmountEvenly(
        uint256 totalAmount,
        uint256 vaultCount
    ) internal pure returns (uint256[] memory amounts) {
        if (vaultCount == 0) {
            revert DivisionByZero();
        }

        amounts = new uint256[](vaultCount);
        
        if (totalAmount == 0) {
            return amounts; // All amounts remain 0
        }

        uint256 baseAmount = totalAmount / vaultCount;
        uint256 remainder = totalAmount % vaultCount;

        for (uint256 i = 0; i < vaultCount; i++) {
            amounts[i] = baseAmount;
            // Distribute remainder to first vaults
            if (i < remainder) {
                amounts[i] += 1;
            }
        }

        return amounts;
    }

    /**
     * @notice Splits an amount proportionally based on weights
     * @dev Amount for vault i = (weight[i] * totalAmount) / totalWeight
     * @param totalAmount Total amount to split
     * @param weights Array of weights for proportional distribution
     * @return amounts Array of amounts for each vault
     * @return remainder Amount remaining due to rounding (should be minimal)
     */
    function splitAmountProportionally(
        uint256 totalAmount,
        uint256[] memory weights
    ) internal pure returns (uint256[] memory amounts, uint256 remainder) {
        amounts = new uint256[](weights.length);
        
        if (totalAmount == 0 || weights.length == 0) {
            return (amounts, 0);
        }

        // Calculate total weight
        uint256 totalWeight = 0;
        for (uint256 i = 0; i < weights.length; i++) {
            totalWeight += weights[i];
        }

        if (totalWeight == 0) {
            return (amounts, totalAmount); // Return full amount as remainder
        }

        uint256 distributedAmount = 0;

        for (uint256 i = 0; i < weights.length; i++) {
            amounts[i] = (weights[i] * totalAmount) / totalWeight;
            distributedAmount += amounts[i];
        }

        remainder = totalAmount - distributedAmount;
        return (amounts, remainder);
    }

    /**
     * @notice Distributes remainder amount to vaults with highest fractional parts
     * @dev Used to minimize rounding errors in proportional distribution
     * @param amounts Current amounts array
     * @param totalAmount Original total amount
     * @param weights Weights used for distribution
     * @param remainder Remaining amount to distribute
     * @return adjustedAmounts Array with remainder distributed
     */
    function distributeRemainder(
        uint256[] memory amounts,
        uint256 totalAmount,
        uint256[] memory weights,
        uint256 remainder
    ) internal pure returns (uint256[] memory adjustedAmounts) {
        if (amounts.length != weights.length) {
            revert ArrayLengthMismatch();
        }

        adjustedAmounts = new uint256[](amounts.length);
        for (uint256 i = 0; i < amounts.length; i++) {
            adjustedAmounts[i] = amounts[i];
        }

        if (remainder == 0 || weights.length == 0) {
            return adjustedAmounts;
        }

        uint256 totalWeight = 0;
        for (uint256 i = 0; i < weights.length; i++) {
            totalWeight += weights[i];
        }

        if (totalWeight == 0) {
            return adjustedAmounts;
        }

        // Calculate fractional parts (simplified approach)
        // Distribute remainder starting from the vault with largest weight
        uint256[] memory tempWeights = new uint256[](weights.length);
        for (uint256 i = 0; i < weights.length; i++) {
            tempWeights[i] = weights[i];
        }

        for (uint256 distributed = 0; distributed < remainder; distributed++) {
            // Find vault with highest remaining weight
            uint256 maxWeight = 0;
            uint256 maxIndex = 0;
            
            for (uint256 i = 0; i < tempWeights.length; i++) {
                if (tempWeights[i] > maxWeight) {
                    maxWeight = tempWeights[i];
                    maxIndex = i;
                }
            }

            if (maxWeight == 0) break; // No more weights available

            adjustedAmounts[maxIndex] += 1;
            tempWeights[maxIndex] = 0; // Remove this vault from next selection
        }

        return adjustedAmounts;
    }

    /**
     * @notice Calculates the allocation percentage for a vault
     * @dev Returns percentage scaled by a factor (e.g., 100 for percentage, 10000 for basis points)
     * @param vaultBalance Balance of the specific vault
     * @param totalBalance Total balance across all vaults  
     * @param scaleFactor Factor to scale the result (100 for percentage, 10000 for basis points)
     * @return allocation Allocation scaled by the scale factor
     */
    function calculateVaultAllocation(
        uint256 vaultBalance,
        uint256 totalBalance,
        uint256 scaleFactor
    ) internal pure returns (uint256 allocation) {
        if (totalBalance == 0) {
            return 0;
        }
        
        return (vaultBalance * scaleFactor) / totalBalance;
    }

    /**
     * @notice Validates that target allocations sum to exactly BasisPointConstants.ONE_HUNDRED_PERCENT_BPS (1,000,000)
     * @param targetAllocations Array of target allocations in basis points
     * @return isValid True if allocations sum to BasisPointConstants.ONE_HUNDRED_PERCENT_BPS
     * @return totalBps Sum of all target allocations
     */
    function validateTargetAllocations(
        uint256[] memory targetAllocations
    ) internal pure returns (bool isValid, uint256 totalBps) {
        totalBps = 0;
        for (uint256 i = 0; i < targetAllocations.length; i++) {
            if (targetAllocations[i] > BasisPointConstants.ONE_HUNDRED_PERCENT_BPS) {
                revert InvalidBasisPoints();
            }
            totalBps += targetAllocations[i];
        }
        
        isValid = (totalBps == BasisPointConstants.ONE_HUNDRED_PERCENT_BPS);
        return (isValid, totalBps);
    }

    /**
     * @notice Calculates the amount needed from each vault to reach target distribution
     * @dev Used for withdrawal planning to maintain target allocations
     * @param targetAmount Total amount to withdraw
     * @param vaultBalances Current vault balances
     * @param targetAllocations Target allocations in basis points
     * @return withdrawAmounts Amount to withdraw from each vault
     * @return feasible True if withdrawal is feasible with current balances
     */
    function calculateOptimalWithdrawal(
        uint256 targetAmount,
        uint256[] memory vaultBalances,
        uint256[] memory targetAllocations
    ) internal pure returns (uint256[] memory withdrawAmounts, bool feasible) {
        if (vaultBalances.length != targetAllocations.length) {
            revert ArrayLengthMismatch();
        }

        uint256 length = vaultBalances.length;
        withdrawAmounts = new uint256[](length);
        feasible = true;

        if (targetAmount == 0) {
            return (withdrawAmounts, feasible);
        }

        // Calculate current total balance
        uint256 totalBalance = 0;
        for (uint256 i = 0; i < length; i++) {
            totalBalance += vaultBalances[i];
        }

        if (totalBalance < targetAmount) {
            feasible = false;
            return (withdrawAmounts, feasible);
        }

        // Calculate remaining balance after withdrawal
        uint256 remainingBalance = totalBalance - targetAmount;

        // Calculate ideal remaining amounts based on target allocations
        for (uint256 i = 0; i < length; i++) {
            uint256 targetRemaining = (remainingBalance * targetAllocations[i]) / BasisPointConstants.ONE_HUNDRED_PERCENT_BPS;
            
            if (vaultBalances[i] <= targetRemaining) {
                // Vault is already at or below target, don't withdraw
                withdrawAmounts[i] = 0;
            } else {
                // Withdraw excess to reach target allocation
                withdrawAmounts[i] = vaultBalances[i] - targetRemaining;
            }
        }

        // Verify total withdrawal amount matches target
        uint256 totalWithdraw = 0;
        for (uint256 i = 0; i < length; i++) {
            totalWithdraw += withdrawAmounts[i];
        }

        // Adjust for any rounding differences
        if (totalWithdraw < targetAmount) {
            uint256 shortfall = targetAmount - totalWithdraw;
            // Add shortfall to vault with most available balance above target
            uint256 bestVault = 0;
            uint256 maxExcess = 0;
            
            for (uint256 i = 0; i < length; i++) {
                uint256 targetRemaining = (remainingBalance * targetAllocations[i]) / BasisPointConstants.ONE_HUNDRED_PERCENT_BPS;
                if (vaultBalances[i] > targetRemaining) {
                    uint256 excess = vaultBalances[i] - targetRemaining - withdrawAmounts[i];
                    if (excess > maxExcess) {
                        maxExcess = excess;
                        bestVault = i;
                    }
                }
            }
            
            withdrawAmounts[bestVault] += shortfall;
        }

        return (withdrawAmounts, feasible);
    }
}