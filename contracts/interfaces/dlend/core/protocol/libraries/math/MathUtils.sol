// SPDX-License-Identifier: agpl-3.0
pragma solidity ^0.8.20;

import { WadRayMath } from "./WadRayMath.sol";

/**
 * @title MathUtils
 * @dev Minimal math utilities library - created to replace missing dlend dependency
 */
library MathUtils {
  using WadRayMath for uint256;

  uint256 internal constant SECONDS_PER_YEAR = 365 days;

  /**
   * @dev Function to calculate the interest using a linear interest rate formula
   * @param rate The interest rate, in ray
   * @param lastUpdateTimestamp The timestamp of the last update of the interest
   * @return The interest accumulated during the timeDelta, in ray
   */
  function calculateLinearInterest(uint256 rate, uint40 lastUpdateTimestamp) internal view returns (uint256) {
    //solium-disable-next-line
    uint256 timeDifference = block.timestamp - uint256(lastUpdateTimestamp);

    return ((rate * timeDifference) / SECONDS_PER_YEAR) + WadRayMath.RAY;
  }
}
