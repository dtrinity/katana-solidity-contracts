// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../../odos/OdosSwapLogic.sol";

/// @title OdosSwapLogicHarness
/// @notice Test harness for OdosSwapLogic library
contract OdosSwapLogicHarness {
    using OdosSwapLogic for *;

    /// @notice External wrapper for testing OdosSwapLogic.swapExactOutput
    function callSwapExactOutput(
        address tokenIn,
        address tokenOut,
        uint256 amountOut,
        uint256 amountInMaximum,
        address receiver,
        bytes memory swapData,
        address router
    ) external returns (uint256 amountInSpent) {
        return OdosSwapLogic.swapExactOutput(tokenIn, tokenOut, amountOut, amountInMaximum, receiver, swapData, router);
    }

    /// @notice Allow contract to receive tokens
    receive() external payable {}
}
