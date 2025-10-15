// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IMorpho } from "../../interfaces/morpho/IMorpho.sol";

library MarketParamsLib {
    function id(IMorpho.MarketParams memory p) internal pure returns (bytes32) {
        return keccak256(abi.encode(p));
    }
}
