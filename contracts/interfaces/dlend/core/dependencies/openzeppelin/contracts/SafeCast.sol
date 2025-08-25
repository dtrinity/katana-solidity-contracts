// SPDX-License-Identifier: agpl-3.0
pragma solidity ^0.8.20;

/**
 * @title SafeCast
 * @dev Minimal safe casting library - created to replace missing dlend dependency
 */
library SafeCast {
  /**
   * @dev Converts a uint256 to its uint128 representation, reverting on overflow.
   */
  function toUint128(uint256 value) internal pure returns (uint128) {
    require(value <= type(uint128).max, "SafeCast: value doesn't fit in 128 bits");
    return uint128(value);
  }

  /**
   * @dev Converts a uint256 to its uint40 representation, reverting on overflow.
   */
  function toUint40(uint256 value) internal pure returns (uint40) {
    require(value <= type(uint40).max, "SafeCast: value doesn't fit in 40 bits");
    return uint40(value);
  }
}
