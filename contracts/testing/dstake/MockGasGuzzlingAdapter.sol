// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IDStableConversionAdapterV2 } from "contracts/vaults/dstake/interfaces/IDStableConversionAdapterV2.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MockGasGuzzlingAdapter
 * @notice Test adapter that intentionally burns nearly all call gas and reverts.
 *         Used to assert the router surfaces gas-griefing adapters as hard failures.
 */
contract MockGasGuzzlingAdapter is IDStableConversionAdapterV2 {
  using SafeERC20 for IERC20;

  address public immutable dStable;
  address public immutable collateralVault;
  address public immutable strategyShareToken;
  uint256 public immutable gasFloor;

  error GasBomb();

  constructor(address _dStable, address _collateralVault, address _strategyShareToken, uint256 _gasFloor) {
    dStable = _dStable;
    collateralVault = _collateralVault;
    strategyShareToken = _strategyShareToken;
    gasFloor = _gasFloor;
  }

  // IDStableConversionAdapterV2 ------------------------------------------------

  function depositIntoStrategy(uint256 stableAmount) external override returns (address, uint256) {
    // Pull funds so the caller must rely on revert for refund (simulates adapter side-effects).
    IERC20(dStable).safeTransferFrom(msg.sender, address(this), stableAmount);
    _burnGas();
    revert GasBomb();
  }

  function withdrawFromStrategy(uint256) external pure override returns (uint256) {
    revert GasBomb();
  }

  function previewDepositIntoStrategy(uint256 stableAmount) external view override returns (address, uint256) {
    return (strategyShareToken, stableAmount);
  }

  function previewWithdrawFromStrategy(uint256 strategyShareAmount) external view override returns (uint256) {
    return strategyShareAmount;
  }

  function strategyShareValueInDStable(address, uint256 strategyShareAmount) external view override returns (uint256) {
    return strategyShareAmount;
  }

  function strategyShare() external view override returns (address) {
    return strategyShareToken;
  }

  // Internal -------------------------------------------------------------------

  function _burnGas() private view {
    // Consume almost all forwarded gas while leaving a small remainder defined by `gasFloor`.
    while (gasleft() > gasFloor) {
      assembly {
        pop(0)
      }
    }
  }
}
