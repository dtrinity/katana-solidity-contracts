// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @notice Mock router that simulates a LiFi swap by pulling `fromToken` and sending `toToken`.
 */
contract MockLiFiRouter {
    using SafeERC20 for IERC20;

    event SwapExecuted(
        address indexed fromToken,
        address indexed toToken,
        address indexed recipient,
        uint256 amountIn,
        uint256 amountOut
    );

    function swap(
        address fromToken,
        address toToken,
        address recipient,
        uint256 amountIn,
        uint256 amountOut
    ) external payable {
        // Pull the specified input amount
        IERC20(fromToken).safeTransferFrom(msg.sender, address(this), amountIn);
        // Send the specified output amount
        IERC20(toToken).safeTransfer(recipient, amountOut);
        emit SwapExecuted(fromToken, toToken, recipient, amountIn, amountOut);
    }
}
