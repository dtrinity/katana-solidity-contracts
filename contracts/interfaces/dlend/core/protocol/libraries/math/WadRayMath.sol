// SPDX-License-Identifier: agpl-3.0
pragma solidity ^0.8.20;

/**
 * @title WadRayMath
 * @dev Minimal math library for wad and ray operations - created to replace missing dlend dependency
 */
library WadRayMath {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant RAY = 1e27;
    uint256 internal constant HALF_RAY = RAY / 2;

    /**
     * @dev Multiplies two ray values, rounding half up to the nearest ray
     * @param a Ray
     * @param b Ray
     * @return c = a * b, in ray
     */
    function rayMul(uint256 a, uint256 b) internal pure returns (uint256 c) {
        if (a == 0 || b == 0) {
            return 0;
        }

        c = (a * b + HALF_RAY) / RAY;
    }

    /**
     * @dev Divides two ray values, rounding half up to the nearest ray
     * @param a Ray
     * @param b Ray
     * @return c = a / b, in ray
     */
    function rayDiv(uint256 a, uint256 b) internal pure returns (uint256 c) {
        require(b != 0, "Division by zero");
        c = (a * RAY + b / 2) / b;
    }

    /**
     * @dev Casts ray down to wad
     * @param a Ray
     * @return b = a converted to wad, rounded half up to the nearest wad
     */
    function rayToWad(uint256 a) internal pure returns (uint256 b) {
        b = (a + (RAY / WAD) / 2) / (RAY / WAD);
    }
}
