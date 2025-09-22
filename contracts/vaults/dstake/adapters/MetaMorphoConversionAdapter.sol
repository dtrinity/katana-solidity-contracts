// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { IDStableConversionAdapterV2 } from "../interfaces/IDStableConversionAdapterV2.sol";
import { BasisPointConstants } from "../../../common/BasisPointConstants.sol";

/**
 * @title MetaMorphoConversionAdapter
 * @notice Adapter for converting between dSTABLE assets and MetaMorpho vault shares
 * @dev Implements IDStableConversionAdapterV2 interface with security considerations for external vault integration
 *
 * Security considerations:
 * - Validates vault asset matches expected dStable
 * - Implements slippage protection via minimum output validation
 * - Uses ReentrancyGuard to prevent reentrancy attacks
 * - Clears approvals after operations
 * - Validates all return values from external vault
 * - Ensures no value remains in adapter contract
 *
 * Note on slippage protection:
 * While ERC-4626 vaults like MetaMorpho should theoretically have no slippage (shares are
 * deterministic based on totalAssets/totalSupply), we include slippage protection for:
 * 1. Protection against malicious vault implementations
 * 2. Handling vaults with fees (deposit/withdrawal fees)
 * 3. Protection during high-volatility periods where underlying Morpho positions may change
 * 4. Future-proofing against MetaMorpho vaults that may implement dynamic fees
 * 5. Emergency situations where governance may need to allow higher slippage to prevent DoS
 */
contract MetaMorphoConversionAdapter is IDStableConversionAdapterV2, ReentrancyGuard, AccessControl {
  using SafeERC20 for IERC20;
  using Math for uint256;

  // --- Constants ---
  uint256 private constant MIN_SHARES = 100; // Minimum shares to prevent dust attacks (100 wei)

  // --- Mutable State ---
  uint256 private maxSlippageBps; // Current max slippage protection

  // --- Errors ---
  error ZeroAddress();
  error InvalidAmount();
  error AssetMismatch(address expected, address actual);
  error SlippageExceeded(uint256 expected, uint256 actual);
  error InsufficientOutput(uint256 output, uint256 minimum);
  error VaultOperationFailed();
  error DustAmount();
  error SlippageTooHigh(uint256 slippage, uint256 maximum);
  error ValuationUnavailable();

  // --- Events ---
  event ConversionToVault(address indexed from, uint256 dStableAmount, uint256 vaultShares);
  event ConversionFromVault(address indexed to, uint256 vaultShares, uint256 dStableAmount);
  event EmergencyWithdraw(address indexed token, uint256 amount);
  event MaxSlippageUpdated(uint256 oldSlippage, uint256 newSlippage);

  // --- Immutable State ---
  address public immutable dStable;
  IERC4626 public immutable metaMorphoVault;
  address public immutable collateralVault;
  uint8 public immutable assetDecimals; // decimals of dStable asset
  uint8 public immutable shareDecimals; // decimals of ERC4626 share token
  uint256 public immutable assetUnit; // 10 ** assetDecimals
  uint256 public immutable shareUnit; // 10 ** shareDecimals

  // --- Constructor ---
  /**
   * @param _dStable The address of the dSTABLE asset (e.g., dUSD)
   * @param _metaMorphoVault The address of the MetaMorpho vault (must be ERC4626)
   * @param _collateralVault The address of the DStakeCollateralVaultV2
   * @param _initialAdmin The initial admin address (will be transferred to governance later)
   */
  constructor(address _dStable, address _metaMorphoVault, address _collateralVault, address _initialAdmin) {
    if (_dStable == address(0) || _metaMorphoVault == address(0) || _collateralVault == address(0) || _initialAdmin == address(0)) {
      revert ZeroAddress();
    }

    dStable = _dStable;
    metaMorphoVault = IERC4626(_metaMorphoVault);
    collateralVault = _collateralVault;

    // Initialize access control - grant admin role to both initial admin and collateral vault
    _grantRole(DEFAULT_ADMIN_ROLE, _initialAdmin);
    _grantRole(DEFAULT_ADMIN_ROLE, _collateralVault);

    // Initialize slippage to 1% (backward compatibility)
    maxSlippageBps = BasisPointConstants.ONE_PERCENT_BPS;

    // Critical: Verify the vault's underlying asset matches our dStable
    address vaultUnderlying = metaMorphoVault.asset();
    if (vaultUnderlying != _dStable) {
      revert AssetMismatch(_dStable, vaultUnderlying);
    }

    // Cache decimals and unit scalars for safe probing and gas efficiency
    assetDecimals = IERC20Metadata(_dStable).decimals();
    shareDecimals = IERC20Metadata(_metaMorphoVault).decimals();
    assetUnit = 10 ** uint256(assetDecimals);
    shareUnit = 10 ** uint256(shareDecimals);

    // Verify vault is functional by checking it can preview operations with a 1 unit asset probe
    metaMorphoVault.previewDeposit(assetUnit);
  }

  // --- IDStableConversionAdapterV2 Implementation ---

  /**
   * @inheritdoc IDStableConversionAdapterV2
   * @dev Converts dStable to MetaMorpho vault shares with slippage protection
   */
  function depositIntoStrategy(
    uint256 dStableAmount
  ) external override nonReentrant returns (address _strategyShare, uint256 strategyShareAmount) {
    if (dStableAmount == 0) revert InvalidAmount();

    // 1. Pull dStable from caller (router)
    IERC20(dStable).safeTransferFrom(msg.sender, address(this), dStableAmount);

    // 2. Preview expected shares with slippage tolerance
    uint256 expectedShares = metaMorphoVault.previewDeposit(dStableAmount);

    // Calculate minimum acceptable shares (with slippage protection)
    uint256 minShares = expectedShares.mulDiv(
      BasisPointConstants.ONE_HUNDRED_PERCENT_BPS - maxSlippageBps,
      BasisPointConstants.ONE_HUNDRED_PERCENT_BPS,
      Math.Rounding.Floor
    );

    // Prevent dust deposits that could be vulnerable to rounding attacks
    if (minShares < MIN_SHARES) revert DustAmount();

    // 3. Approve vault to spend exact amount (not max uint to prevent griefing)
    IERC20(dStable).forceApprove(address(metaMorphoVault), dStableAmount);

    // 4. Deposit to vault and send shares directly to collateral vault
    uint256 actualShares;
    try metaMorphoVault.deposit(dStableAmount, collateralVault) returns (uint256 shares) {
      actualShares = shares;
    } catch {
      // Clear approval on failure
      IERC20(dStable).forceApprove(address(metaMorphoVault), 0);
      revert VaultOperationFailed();
    }

    // 5. Clear any remaining approval as a safety measure
    IERC20(dStable).forceApprove(address(metaMorphoVault), 0);

    // 6. Validate received shares against slippage
    if (actualShares < minShares) {
      revert SlippageExceeded(expectedShares, actualShares);
    }

    // 7. Ensure no dStable remains in this contract (defense in depth)
    uint256 remainingBalance = IERC20(dStable).balanceOf(address(this));
    if (remainingBalance > 0) {
      IERC20(dStable).safeTransfer(msg.sender, remainingBalance);
    }

    emit ConversionToVault(msg.sender, dStableAmount, actualShares);
    return (address(metaMorphoVault), actualShares);
  }

  /**
   * @inheritdoc IDStableConversionAdapterV2
   * @dev Converts MetaMorpho vault shares back to dStable with slippage protection
   */
  function withdrawFromStrategy(uint256 strategyShareAmount) external override nonReentrant returns (uint256 dStableAmount) {
    if (strategyShareAmount == 0) revert InvalidAmount();

    // 1. Pull vault shares from caller (router)
    IERC20(address(metaMorphoVault)).safeTransferFrom(msg.sender, address(this), strategyShareAmount);

    // 2. Preview expected assets with slippage tolerance
    uint256 expectedAssets = metaMorphoVault.previewRedeem(strategyShareAmount);

    // Calculate minimum acceptable assets
    uint256 minAssets = expectedAssets.mulDiv(
      BasisPointConstants.ONE_HUNDRED_PERCENT_BPS - maxSlippageBps,
      BasisPointConstants.ONE_HUNDRED_PERCENT_BPS,
      Math.Rounding.Floor
    );

    // 3. Redeem shares for dStable, sending directly to caller
    uint256 actualAssets = metaMorphoVault.redeem(strategyShareAmount, msg.sender, address(this));

    // 4. Validate received assets against slippage
    if (actualAssets < minAssets) {
      revert SlippageExceeded(expectedAssets, actualAssets);
    }

    // 5. Ensure no vault shares remain in this contract
    uint256 remainingShares = IERC20(address(metaMorphoVault)).balanceOf(address(this));
    if (remainingShares > 0) {
      // Attempt to redeem any remaining shares
      try metaMorphoVault.redeem(remainingShares, msg.sender, address(this)) returns (uint256) {
        // Additional assets sent to caller
      } catch {
        // If redemption fails, leave shares in contract (emergency withdrawal available)
        // Don't transfer shares back to avoid inconsistent state
      }
    }

    emit ConversionFromVault(msg.sender, strategyShareAmount, actualAssets);
    return actualAssets;
  }

  /**
   * @inheritdoc IDStableConversionAdapterV2
   * @dev Returns the current value of vault shares in dStable terms
   */
  function strategyShareValueInDStable(address _strategyShare, uint256 strategyShareAmount) external view override returns (uint256) {
    if (_strategyShare != address(metaMorphoVault)) {
      revert AssetMismatch(address(metaMorphoVault), _strategyShare);
    }

    // Use try-catch to handle potential revert from external vault
    try metaMorphoVault.previewRedeem(strategyShareAmount) returns (uint256 assets) {
      return assets;
    } catch {
      // If preview fails, use convertToAssets as fallback
      try metaMorphoVault.convertToAssets(strategyShareAmount) returns (uint256 assets) {
        return assets;
      } catch {
        revert ValuationUnavailable();
      }
    }
  }

  /**
   * @inheritdoc IDStableConversionAdapterV2
   */
  function previewWithdrawFromStrategy(uint256 strategyShareAmount) external view override returns (uint256 dStableAmount) {
    try metaMorphoVault.previewRedeem(strategyShareAmount) returns (uint256 assets) {
      // Apply slippage for preview (conservative estimate)
      return
        assets.mulDiv(
          BasisPointConstants.ONE_HUNDRED_PERCENT_BPS - maxSlippageBps,
          BasisPointConstants.ONE_HUNDRED_PERCENT_BPS,
          Math.Rounding.Floor
        );
    } catch {
      return 0;
    }
  }

  /**
   * @inheritdoc IDStableConversionAdapterV2
   */
  function previewDepositIntoStrategy(
    uint256 dStableAmount
  ) external view override returns (address _strategyShare, uint256 strategyShareAmount) {
    try metaMorphoVault.previewDeposit(dStableAmount) returns (uint256 shares) {
      // Apply slippage for preview (conservative estimate)
      uint256 expectedShares = shares.mulDiv(
        BasisPointConstants.ONE_HUNDRED_PERCENT_BPS - maxSlippageBps,
        BasisPointConstants.ONE_HUNDRED_PERCENT_BPS,
        Math.Rounding.Floor
      );
      return (address(metaMorphoVault), expectedShares);
    } catch {
      return (address(metaMorphoVault), 0);
    }
  }

  /**
   * @inheritdoc IDStableConversionAdapterV2
   */
  function strategyShare() external view override returns (address) {
    return address(metaMorphoVault);
  }

  // --- Admin Functions ---

  /**
   * @notice Set the maximum slippage protection
   * @dev Only callable by admin role. Cannot exceed 100% (10000 basis points)
   * @param newSlippageBps New slippage protection in basis points
   */
  function setMaxSlippage(uint256 newSlippageBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
    if (newSlippageBps > BasisPointConstants.ONE_HUNDRED_PERCENT_BPS) {
      revert SlippageTooHigh(newSlippageBps, BasisPointConstants.ONE_HUNDRED_PERCENT_BPS);
    }

    uint256 oldSlippage = maxSlippageBps;
    maxSlippageBps = newSlippageBps;

    emit MaxSlippageUpdated(oldSlippage, newSlippageBps);
  }

  // --- Emergency Functions ---

  /**
   * @notice Emergency function to recover stuck tokens
   * @dev Only callable by admin role
   * @param token The token to recover
   * @param amount The amount to recover
   */
  function emergencyWithdraw(address token, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
    if (token == address(0)) {
      // Withdraw ETH with gas limit to prevent reentrancy
      (bool success, ) = msg.sender.call{ value: amount, gas: 2300 }("");
      if (!success) revert VaultOperationFailed();
    } else {
      // Withdraw ERC20
      IERC20(token).safeTransfer(msg.sender, amount);
    }

    emit EmergencyWithdraw(token, amount);
  }

  // --- View Functions ---

  /**
   * @notice Get the current maximum slippage protection
   * @return slippageBps Current slippage protection in basis points
   */
  function getMaxSlippage() external view returns (uint256 slippageBps) {
    return maxSlippageBps;
  }

  /**
   * @notice Check if the vault is currently functional
   * @return bool True if vault appears to be working
   */
  function isVaultHealthy() external view returns (bool) {
    // First check if we can read basic vault state
    try metaMorphoVault.totalAssets() returns (uint256 assets) {
      try metaMorphoVault.totalSupply() returns (uint256 supply) {
        // Check for broken vault state
        if (supply == 0) {
          // No shares minted yet, vault should be healthy if it can preview
          try metaMorphoVault.previewDeposit(assetUnit) returns (uint256) {
            return true;
          } catch {
            return false;
          }
        } else {
          // Shares exist, check if exchange rate is reasonable
          if (assets == 0) {
            return false; // Vault has shares but no assets - bad state
          }
          // Check if preview functions work using one share unit
          try metaMorphoVault.convertToAssets(shareUnit) returns (uint256) {
            return true;
          } catch {
            return false;
          }
        }
      } catch {
        return false;
      }
    } catch {
      return false;
    }
  }

  /**
   * @notice Get the current exchange rate from the vault
   * @return rate The current exchange rate (scaled by 1e18)
   */
  function getExchangeRate() external view returns (uint256 rate) {
    uint256 totalShares = metaMorphoVault.totalSupply();
    if (totalShares == 0) {
      return 1e18;
    }

    uint256 totalAssets = metaMorphoVault.totalAssets();
    return (totalAssets * 1e18) / totalShares;
  }
}
