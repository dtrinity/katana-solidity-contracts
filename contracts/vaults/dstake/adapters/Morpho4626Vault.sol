// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ERC4626 } from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IMorpho } from "../../../interfaces/morpho/IMorpho.sol";
import { MarketParamsLib } from "../../../testing/morpho/MarketParamsLib.sol";

/**
 * @title Morpho4626Vault
 * @notice ERC-4626 compliant vault that wraps Morpho Blue supply positions
 * @dev This vault allows users to deposit dSTABLE tokens and receive shares representing
 *      their proportional ownership of the Morpho Blue supply position
 */
contract Morpho4626Vault is ERC4626 {
  using SafeERC20 for IERC20;
  using Math for uint256;

  IMorpho public immutable morpho;
  bytes32 public immutable marketId;
  IMorpho.MarketParams public marketParams;

  /**
   * @notice Constructor
   * @param _morpho The Morpho Blue contract address
   * @param _marketParams The market parameters for the target market
   * @param _name The name of the vault token
   * @param _symbol The symbol of the vault token
   */
  constructor(
    IMorpho _morpho,
    IMorpho.MarketParams memory _marketParams,
    string memory _name,
    string memory _symbol
  ) ERC20(_name, _symbol) ERC4626(IERC20(_marketParams.loanToken)) {
    morpho = _morpho;
    marketParams = _marketParams;
    marketId = MarketParamsLib.id(_marketParams);
  }

  /**
   * @notice Returns the total assets (dSTABLE) held by the vault in Morpho
   * @return The total amount of assets
   */
  function totalAssets() public view virtual override returns (uint256) {
    IMorpho.Market memory market = morpho.market(marketId);
    IMorpho.Position memory pos = morpho.position(marketId, address(this));
    
    if (market.totalSupplyShares == 0) {
      return 0;
    }
    
    // Calculate assets from shares
    return (uint256(pos.supplyShares) * uint256(market.totalSupplyAssets)) / uint256(market.totalSupplyShares);
  }

  /**
   * @notice Deposits assets and mints shares to receiver
   * @param assets The amount of assets to deposit
   * @param receiver The address to receive the shares
   * @return shares The amount of shares minted
   */
  function deposit(uint256 assets, address receiver) public virtual override returns (uint256 shares) {
    if (assets == 0) revert();
    
    shares = previewDeposit(assets);
    if (shares == 0) revert();
    
    // Transfer assets from sender
    IERC20(asset()).safeTransferFrom(msg.sender, address(this), assets);
    
    // Approve Morpho to spend the assets
    IERC20(asset()).forceApprove(address(morpho), assets);
    
    // Supply to Morpho
    morpho.supply(marketParams, assets, 0, address(this), "");
    
    // Mint shares to receiver
    _mint(receiver, shares);
    
    emit Deposit(msg.sender, receiver, assets, shares);
  }

  /**
   * @notice Mints exact shares to receiver by depositing assets
   * @param shares The amount of shares to mint
   * @param receiver The address to receive the shares
   * @return assets The amount of assets deposited
   */
  function mint(uint256 shares, address receiver) public virtual override returns (uint256 assets) {
    if (shares == 0) revert();
    
    assets = previewMint(shares);
    if (assets == 0) revert();
    
    // Transfer assets from sender
    IERC20(asset()).safeTransferFrom(msg.sender, address(this), assets);
    
    // Approve Morpho to spend the assets
    IERC20(asset()).forceApprove(address(morpho), assets);
    
    // Supply to Morpho
    morpho.supply(marketParams, assets, 0, address(this), "");
    
    // Mint shares to receiver
    _mint(receiver, shares);
    
    emit Deposit(msg.sender, receiver, assets, shares);
  }

  /**
   * @notice Withdraws assets to receiver by burning shares from owner
   * @param assets The amount of assets to withdraw
   * @param receiver The address to receive the assets
   * @param owner The address whose shares will be burned
   * @return shares The amount of shares burned
   */
  function withdraw(uint256 assets, address receiver, address owner) public virtual override returns (uint256 shares) {
    if (assets == 0) revert();
    
    shares = previewWithdraw(assets);
    if (shares == 0) revert();
    
    // Check allowance if caller is not owner
    if (msg.sender != owner) {
      uint256 allowed = allowance(owner, msg.sender);
      if (allowed != type(uint256).max) {
        if (allowed < shares) revert();
        _spendAllowance(owner, msg.sender, shares);
      }
    }
    
    // Burn shares from owner
    _burn(owner, shares);
    
    // Withdraw from Morpho
    morpho.withdraw(marketParams, assets, 0, address(this), receiver);
    
    emit Withdraw(msg.sender, receiver, owner, assets, shares);
  }

  /**
   * @notice Redeems shares for assets and sends to receiver
   * @param shares The amount of shares to redeem
   * @param receiver The address to receive the assets
   * @param owner The address whose shares will be burned
   * @return assets The amount of assets withdrawn
   */
  function redeem(uint256 shares, address receiver, address owner) public virtual override returns (uint256 assets) {
    if (shares == 0) revert();
    
    assets = previewRedeem(shares);
    if (assets == 0) revert();
    
    // Check allowance if caller is not owner
    if (msg.sender != owner) {
      uint256 allowed = allowance(owner, msg.sender);
      if (allowed != type(uint256).max) {
        if (allowed < shares) revert();
        _spendAllowance(owner, msg.sender, shares);
      }
    }
    
    // Burn shares from owner
    _burn(owner, shares);
    
    // Withdraw from Morpho
    morpho.withdraw(marketParams, assets, 0, address(this), receiver);
    
    emit Withdraw(msg.sender, receiver, owner, assets, shares);
  }

  /**
   * @notice Previews the amount of shares that would be minted for a deposit
   * @param assets The amount of assets to deposit
   * @return The amount of shares that would be minted
   */
  function previewDeposit(uint256 assets) public view virtual override returns (uint256) {
    return _convertToShares(assets, Math.Rounding.Floor);
  }

  /**
   * @notice Previews the amount of assets needed to mint shares
   * @param shares The amount of shares to mint
   * @return The amount of assets needed
   */
  function previewMint(uint256 shares) public view virtual override returns (uint256) {
    return _convertToAssets(shares, Math.Rounding.Ceil);
  }

  /**
   * @notice Previews the amount of shares that would be burned for a withdrawal
   * @param assets The amount of assets to withdraw
   * @return The amount of shares that would be burned
   */
  function previewWithdraw(uint256 assets) public view virtual override returns (uint256) {
    return _convertToShares(assets, Math.Rounding.Ceil);
  }

  /**
   * @notice Previews the amount of assets that would be withdrawn for redeeming shares
   * @param shares The amount of shares to redeem
   * @return The amount of assets that would be withdrawn
   */
  function previewRedeem(uint256 shares) public view virtual override returns (uint256) {
    return _convertToAssets(shares, Math.Rounding.Floor);
  }

  /**
   * @dev Converts assets to shares using Morpho market data
   */
  function _convertToShares(uint256 assets, Math.Rounding rounding) internal view virtual override returns (uint256) {
    uint256 supply = totalSupply();
    if (supply == 0) {
      // 1:1 ratio for first deposit
      return assets;
    }
    
    uint256 totalAssetsAmount = totalAssets();
    if (totalAssetsAmount == 0) {
      return assets;
    }
    
    return assets.mulDiv(supply, totalAssetsAmount, rounding);
  }

  /**
   * @dev Converts shares to assets using Morpho market data
   */
  function _convertToAssets(uint256 shares, Math.Rounding rounding) internal view virtual override returns (uint256) {
    uint256 supply = totalSupply();
    if (supply == 0) {
      return shares;
    }
    
    return shares.mulDiv(totalAssets(), supply, rounding);
  }

  /**
   * @notice Returns the maximum amount that can be deposited
   * @return The maximum deposit amount (no limit)
   */
  function maxDeposit(address) public pure virtual override returns (uint256) {
    return type(uint256).max;
  }

  /**
   * @notice Returns the maximum shares that can be minted
   * @return The maximum mint amount (no limit)
   */
  function maxMint(address) public pure virtual override returns (uint256) {
    return type(uint256).max;
  }

  /**
   * @notice Returns the maximum amount that can be withdrawn
   * @param owner The address to check
   * @return The maximum withdrawal amount
   */
  function maxWithdraw(address owner) public view virtual override returns (uint256) {
    return _convertToAssets(balanceOf(owner), Math.Rounding.Floor);
  }

  /**
   * @notice Returns the maximum shares that can be redeemed
   * @param owner The address to check
   * @return The maximum redeemable shares
   */
  function maxRedeem(address owner) public view virtual override returns (uint256) {
    return balanceOf(owner);
  }
}