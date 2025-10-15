// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title OdosSwapLogic
/// @notice Library for handling Odos swap operations with surplus refund logic
library OdosSwapLogic {
    using SafeERC20 for IERC20;

    /// @dev Error when swap output is insufficient
    error InsufficientOutput(uint256 expected, uint256 actual);

    /// @dev Error when swap fails
    error SwapFailed();

    /// @notice Performs exact output swap with surplus refund
    /// @param tokenIn Input token address
    /// @param tokenOut Output token address
    /// @param amountOut Exact amount of output tokens needed
    /// @param amountInMaximum Maximum amount of input tokens to spend
    /// @param receiver Address to receive any surplus output tokens
    /// @param swapData Encoded swap data for the router
    /// @param router Router address to execute the swap
    /// @return amountInSpent Amount of input tokens actually spent
    function swapExactOutput(
        address tokenIn,
        address tokenOut,
        uint256 amountOut,
        uint256 amountInMaximum,
        address receiver,
        bytes memory swapData,
        address router
    ) external returns (uint256 amountInSpent) {
        IERC20 inputToken = IERC20(tokenIn);
        IERC20 outputToken = IERC20(tokenOut);

        // Record initial balances
        uint256 inputBalanceBefore = inputToken.balanceOf(address(this));
        uint256 outputBalanceBefore = outputToken.balanceOf(address(this));

        // Approve router to spend input tokens
        inputToken.forceApprove(router, amountInMaximum);

        // Execute the swap
        (bool success, ) = router.call(swapData);
        if (!success) {
            revert SwapFailed();
        }

        // Check balances after swap
        uint256 inputBalanceAfter = inputToken.balanceOf(address(this));
        uint256 outputBalanceAfter = outputToken.balanceOf(address(this));

        amountInSpent = inputBalanceBefore - inputBalanceAfter;
        uint256 outputReceived = outputBalanceAfter - outputBalanceBefore;

        // Ensure we received at least the required output
        if (outputReceived < amountOut) {
            revert InsufficientOutput(amountOut, outputReceived);
        }

        // If there's surplus output, send it to the receiver
        if (outputReceived > amountOut) {
            uint256 surplus = outputReceived - amountOut;
            outputToken.safeTransfer(receiver, surplus);
        }

        // Reset allowance for security
        inputToken.forceApprove(router, 0);
    }
}
