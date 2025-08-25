// SPDX-License-Identifier: agpl-3.0
pragma solidity ^0.8.20;

/**
 * @title ReserveConfiguration
 * @dev Minimal reserve configuration library - created to replace missing dlend dependency
 */
library ReserveConfiguration {
  /**
   * @notice Gets the active state of the reserve
   * @param self The reserve configuration
   * @return The active state
   */
  function getActive(uint256 self) internal pure returns (bool) {
    // Simplified implementation - always return true for minimal functionality
    return true;
  }

  /**
   * @notice Gets the paused state of the reserve
   * @param self The reserve configuration
   * @return The paused state
   */
  function getPaused(uint256 self) internal pure returns (bool) {
    // Simplified implementation - always return false for minimal functionality
    return false;
  }

  /**
   * @notice Gets the frozen state of the reserve
   * @param self The reserve configuration
   * @return The frozen state
   */
  function getFrozen(uint256 self) internal pure returns (bool) {
    // Simplified implementation - always return false for minimal functionality
    return false;
  }

  /**
   * @notice Gets the supply cap of the reserve
   * @param self The reserve configuration
   * @return The supply cap
   */
  function getSupplyCap(uint256 self) internal pure returns (uint256) {
    // Simplified implementation - return 0 (no supply cap) for minimal functionality
    return 0;
  }

  /**
   * @notice Gets the decimals of the reserve
   * @param self The reserve configuration
   * @return The decimals
   */
  function getDecimals(uint256 self) internal pure returns (uint256) {
    // Simplified implementation - return 18 decimals as default
    return 18;
  }
}
