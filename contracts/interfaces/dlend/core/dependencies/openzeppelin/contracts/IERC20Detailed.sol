// SPDX-License-Identifier: agpl-3.0
pragma solidity ^0.8.20;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title IERC20Detailed
 * @dev Interface for ERC20 tokens with detailed information - created to replace missing dlend dependency
 */
interface IERC20Detailed is IERC20 {
  function name() external view returns (string memory);
  function symbol() external view returns (string memory);
  function decimals() external view returns (uint8);
}
