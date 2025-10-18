// SPDX-License-Identifier: agpl-3.0
pragma solidity ^0.8.20;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title IERC20WithPermit
 * @dev Interface for ERC20 tokens with permit functionality - created to replace missing dlend dependency
 */
interface IERC20WithPermit is IERC20 {
    /**
     * @dev Sets approval for spending tokens via signature
     * @param owner Token owner's address
     * @param spender Address authorized to spend
     * @param value Amount to approve
     * @param deadline Timestamp until when the permit is valid
     * @param v Recovery byte of the signature
     * @param r First 32 bytes of the signature
     * @param s Second 32 bytes of the signature
     */
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}
