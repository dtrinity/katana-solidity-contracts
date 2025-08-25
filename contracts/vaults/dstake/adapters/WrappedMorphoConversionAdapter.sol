// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IDStableConversionAdapter } from "../interfaces/IDStableConversionAdapter.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";

/**
 * @title WrappedMorphoConversionAdapter
 * @notice Adapter for converting between a dSTABLE asset (like dUSD) and Morpho4626Vault shares
 * @dev Implements the IDStableConversionAdapter interface.
 *      Interacts with a Morpho4626Vault contract that wraps Morpho Blue supply positions.
 */
contract WrappedMorphoConversionAdapter is IDStableConversionAdapter {
  using SafeERC20 for IERC20;

  // --- Errors ---
  error ZeroAddress();
  error InvalidAmount();
  error InconsistentState(string message);

  // --- State ---
  address public immutable dStable; // The underlying dSTABLE asset (e.g., dUSD)
  IERC4626 public immutable morphoVault; // The Morpho4626Vault instance
  address public immutable collateralVault; // The DStakeCollateralVault to deposit vault shares into

  // --- Constructor ---
  /**
   * @param _dStable The address of the dSTABLE asset (e.g., dUSD)
   * @param _morphoVault The address of the Morpho4626Vault
   * @param _collateralVault The address of the DStakeCollateralVault
   */
  constructor(address _dStable, address _morphoVault, address _collateralVault) {
    if (_dStable == address(0) || _morphoVault == address(0) || _collateralVault == address(0)) {
      revert ZeroAddress();
    }
    dStable = _dStable;
    morphoVault = IERC4626(_morphoVault);
    collateralVault = _collateralVault;

    // Sanity check: Ensure the Morpho vault uses the correct underlying
    if (morphoVault.asset() != _dStable) {
      revert InconsistentState("Morpho vault underlying mismatch");
    }
  }

  // --- IDStableConversionAdapter Implementation ---

  /**
   * @inheritdoc IDStableConversionAdapter
   * @dev Converts dStable -> morphoVault shares by depositing into Morpho4626Vault.
   *      The vault mints shares directly to the collateralVault.
   */
  function convertToVaultAsset(uint256 dStableAmount) external override returns (address _vaultAsset, uint256 vaultAssetAmount) {
    if (dStableAmount == 0) {
      revert InvalidAmount();
    }

    // 1. Pull dStable from caller (Router)
    IERC20(dStable).safeTransferFrom(msg.sender, address(this), dStableAmount);

    // 2. Approve the Morpho vault to pull the dStable
    IERC20(dStable).forceApprove(address(morphoVault), dStableAmount);

    // 3. Deposit dStable into the Morpho vault, minting shares to collateralVault
    vaultAssetAmount = morphoVault.deposit(dStableAmount, collateralVault);

    return (address(morphoVault), vaultAssetAmount);
  }

  /**
   * @inheritdoc IDStableConversionAdapter
   * @dev Converts morphoVault shares -> dStable by withdrawing from Morpho4626Vault.
   *      The vault sends the dStable directly to msg.sender.
   */
  function convertFromVaultAsset(uint256 vaultAssetAmount) external override returns (uint256 dStableAmount) {
    if (vaultAssetAmount == 0) {
      revert InvalidAmount();
    }

    // 1. Pull morphoVault shares from caller (Router)
    IERC20(address(morphoVault)).safeTransferFrom(msg.sender, address(this), vaultAssetAmount);

    // 2. Redeem from Morpho vault, sending dStable to msg.sender
    dStableAmount = morphoVault.redeem(vaultAssetAmount, msg.sender, address(this));

    if (dStableAmount == 0) {
      revert InvalidAmount();
    }

    return dStableAmount;
  }

  /**
   * @inheritdoc IDStableConversionAdapter
   * @dev Uses Morpho vault's previewRedeem function to get the underlying value (dStable).
   */
  function assetValueInDStable(address _vaultAsset, uint256 vaultAssetAmount) external view override returns (uint256) {
    require(_vaultAsset == address(morphoVault), "Invalid vault asset");
    return morphoVault.previewRedeem(vaultAssetAmount);
  }

  /**
   * @inheritdoc IDStableConversionAdapter
   * @dev Uses Morpho vault's previewRedeem function.
   */
  function previewConvertFromVaultAsset(uint256 vaultAssetAmount) external view override returns (uint256 dStableAmount) {
    return morphoVault.previewRedeem(vaultAssetAmount);
  }

  /**
   * @inheritdoc IDStableConversionAdapter
   * @dev Uses Morpho vault's previewDeposit function.
   */
  function previewConvertToVaultAsset(uint256 dStableAmount) external view override returns (address _vaultAsset, uint256 vaultAssetAmount) {
    return (address(morphoVault), morphoVault.previewDeposit(dStableAmount));
  }

  /**
   * @inheritdoc IDStableConversionAdapter
   * @dev Returns the Morpho vault address.
   */
  function vaultAsset() external view override returns (address) {
    return address(morphoVault);
  }
}