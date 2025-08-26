// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../../vaults/dstake/libraries/AllocationCalculator.sol";

/**
 * @title AllocationCalculatorHarness
 * @notice Test harness to expose library functions for unit testing
 */
contract AllocationCalculatorHarness {
    using AllocationCalculator for *;

    function calculateCurrentAllocations(
        uint256[] memory vaultBalances
    ) external pure returns (uint256[] memory allocations, uint256 totalBalance) {
        return AllocationCalculator.calculateCurrentAllocations(vaultBalances);
    }

    function calculateDeficitsAndSurpluses(
        uint256[] memory currentAllocations,
        uint256[] memory targetAllocations
    ) external pure returns (
        uint256[] memory deficits,
        uint256[] memory surpluses,
        uint256 totalDeficit,
        uint256 totalSurplus
    ) {
        return AllocationCalculator.calculateDeficitsAndSurpluses(
            currentAllocations,
            targetAllocations
        );
    }

    function splitAmountEvenly(
        uint256 totalAmount,
        uint256 vaultCount
    ) external pure returns (uint256[] memory amounts) {
        return AllocationCalculator.splitAmountEvenly(totalAmount, vaultCount);
    }

    function splitAmountProportionally(
        uint256 totalAmount,
        uint256[] memory weights
    ) external pure returns (uint256[] memory amounts, uint256 remainder) {
        return AllocationCalculator.splitAmountProportionally(totalAmount, weights);
    }

    function distributeRemainder(
        uint256[] memory amounts,
        uint256 totalAmount,
        uint256[] memory weights,
        uint256 remainder
    ) external pure returns (uint256[] memory adjustedAmounts) {
        return AllocationCalculator.distributeRemainder(
            amounts,
            totalAmount,
            weights,
            remainder
        );
    }

    function calculateVaultAllocation(
        uint256 vaultBalance,
        uint256 totalBalance,
        uint256 scaleFactor
    ) external pure returns (uint256 allocation) {
        return AllocationCalculator.calculateVaultAllocation(
            vaultBalance,
            totalBalance,
            scaleFactor
        );
    }

    function validateTargetAllocations(
        uint256[] memory targetAllocations
    ) external pure returns (bool isValid, uint256 totalBps) {
        return AllocationCalculator.validateTargetAllocations(targetAllocations);
    }

    function calculateOptimalWithdrawal(
        uint256 targetAmount,
        uint256[] memory vaultBalances,
        uint256[] memory targetAllocations
    ) external pure returns (uint256[] memory withdrawAmounts, bool feasible) {
        return AllocationCalculator.calculateOptimalWithdrawal(
            targetAmount,
            vaultBalances,
            targetAllocations
        );
    }
}