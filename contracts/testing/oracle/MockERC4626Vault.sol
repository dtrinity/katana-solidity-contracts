// SPDX-License-Identifier: MIT
/* ———————————————————————————————————————————————————————————————————————————————— *
 *    _____     ______   ______     __     __   __     __     ______   __  __       *
 *   /\  __-.  /\__  _\ /\  == \   /\ \   /\ "-.\ \   /\ \   /\__  _\ /\ \_\ \      *
 *   \ \ \/\ \ \/_/\ \/ \ \  __<   \ \ \  \ \ \-.  \  \ \ \  \/_/\ \/ \ \____ \     *
 *    \ \____-    \ \_\  \ \_\ \_\  \ \_\  \ \_\\"\_\  \ \_\    \ \_\  \/\_____\    *
 *     \/____/     \/_/   \/_/ /_/   \/_/   \/_/ \/_/   \/_/     \/_/   \/_____/    *
 *                                                                                  *
 * ————————————————————————————————— dtrinity.org ————————————————————————————————— *
 *                                                                                  *
 *                                         ▲                                        *
 *                                        ▲ ▲                                       *
 *                                                                                  *
 * ———————————————————————————————————————————————————————————————————————————————— *
 * dTRINITY Protocol: https://github.com/dtrinity                                   *
 * ———————————————————————————————————————————————————————————————————————————————— */

pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/interfaces/IERC4626.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title MockERC4626Vault
 * @notice Mock ERC-4626 vault for testing oracle wrapper functionality
 * @dev Allows manipulation of exchange rates for testing protection mechanisms
 */
contract MockERC4626Vault is ERC20, IERC4626 {
  using SafeERC20 for IERC20;
  using Math for uint256;

  /* STATE */

  /// @notice The underlying asset
  IERC20 private immutable _asset;

  /// @notice Mock total assets (can be manipulated for testing)
  uint256 private _totalAssets;

  /// @notice Whether the vault is paused
  bool private _paused;

  /* EVENTS */

  event MockAssetsSet(uint256 newTotalAssets);
  event MockPaused();
  event MockUnpaused();
  event MockDeposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares);
  event MockWithdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares);

  /* ERRORS */

  error VaultPaused();
  error ZeroShares();
  error ZeroAssets();

  /**
   * @notice Constructor
   * @param underlyingAsset The underlying ERC20 asset
   * @param name Vault token name
   * @param symbol Vault token symbol
   */
  constructor(address underlyingAsset, string memory name, string memory symbol) ERC20(name, symbol) {
    _asset = IERC20(underlyingAsset);
    _totalAssets = 0;
  }

  /* IERC4626 IMPLEMENTATION */

  /**
   * @notice Returns the address of the underlying token used by the vault
   * @return The address of the underlying asset
   */
  function asset() external view override returns (address) {
    return address(_asset);
  }

  /**
   * @notice Returns the total amount of the underlying asset managed by the vault
   * @return Total assets (manipulatable for testing)
   */
  function totalAssets() external view override returns (uint256) {
    return _totalAssets;
  }

  /**
   * @notice Converts asset amount to shares
   * @param assets Amount of assets
   * @return shares Amount of shares
   */
  function convertToShares(uint256 assets) public view override returns (uint256 shares) {
    uint256 supply = totalSupply();
    return supply == 0 ? assets : assets.mulDiv(supply, _totalAssets, Math.Rounding.Floor);
  }

  /**
   * @notice Converts shares to asset amount
   * @param shares Amount of shares
   * @return assets Amount of assets
   */
  function convertToAssets(uint256 shares) public view override returns (uint256 assets) {
    uint256 supply = totalSupply();
    return supply == 0 ? shares : shares.mulDiv(_totalAssets, supply, Math.Rounding.Floor);
  }

  /**
   * @notice Maximum assets that can be deposited
   * @return Maximum deposit amount
   */
  function maxDeposit(address) external pure override returns (uint256) {
    return type(uint256).max;
  }

  /**
   * @notice Preview deposit shares
   * @param assets Assets to deposit
   * @return shares Shares that would be minted
   */
  function previewDeposit(uint256 assets) public view override returns (uint256 shares) {
    return convertToShares(assets);
  }

  /**
   * @notice Deposit assets and mint shares
   * @param assets Amount of assets to deposit
   * @param receiver Receiver of vault shares
   * @return shares Amount of shares minted
   */
  function deposit(uint256 assets, address receiver) external override returns (uint256 shares) {
    if (_paused) revert VaultPaused();
    if (assets == 0) revert ZeroAssets();

    shares = previewDeposit(assets);
    if (shares == 0) revert ZeroShares();

    _asset.safeTransferFrom(msg.sender, address(this), assets);
    _totalAssets += assets;
    _mint(receiver, shares);

    emit MockDeposit(msg.sender, receiver, assets, shares);
    emit Deposit(msg.sender, receiver, assets, shares);

    return shares;
  }

  /**
   * @notice Maximum shares that can be minted
   * @return Maximum mint amount
   */
  function maxMint(address) external pure override returns (uint256) {
    return type(uint256).max;
  }

  /**
   * @notice Preview mint assets needed
   * @param shares Shares to mint
   * @return assets Assets needed
   */
  function previewMint(uint256 shares) public view override returns (uint256 assets) {
    uint256 supply = totalSupply();
    return supply == 0 ? shares : shares.mulDiv(_totalAssets, supply, Math.Rounding.Ceil);
  }

  /**
   * @notice Mint shares by depositing assets
   * @param shares Shares to mint
   * @param receiver Receiver of shares
   * @return assets Assets deposited
   */
  function mint(uint256 shares, address receiver) external override returns (uint256 assets) {
    if (_paused) revert VaultPaused();
    if (shares == 0) revert ZeroShares();

    assets = previewMint(shares);
    if (assets == 0) revert ZeroAssets();

    _asset.safeTransferFrom(msg.sender, address(this), assets);
    _totalAssets += assets;
    _mint(receiver, shares);

    emit MockDeposit(msg.sender, receiver, assets, shares);
    emit Deposit(msg.sender, receiver, assets, shares);

    return assets;
  }

  /**
   * @notice Maximum assets that can be withdrawn by owner
   * @return Maximum withdraw amount
   */
  function maxWithdraw(address owner) external view override returns (uint256) {
    uint256 shares = balanceOf(owner);
    return convertToAssets(shares);
  }

  /**
   * @notice Preview withdraw shares needed
   * @param assets Assets to withdraw
   * @return shares Shares needed
   */
  function previewWithdraw(uint256 assets) public view override returns (uint256 shares) {
    return convertToShares(assets);
  }

  /**
   * @notice Withdraw assets by burning shares
   * @param assets Assets to withdraw
   * @param receiver Receiver of assets
   * @param owner Owner of shares
   * @return shares Shares burned
   */
  function withdraw(uint256 assets, address receiver, address owner) external override returns (uint256 shares) {
    if (_paused) revert VaultPaused();
    if (assets == 0) revert ZeroAssets();

    shares = previewWithdraw(assets);
    if (shares == 0) revert ZeroShares();

    if (msg.sender != owner) {
      _spendAllowance(owner, msg.sender, shares);
    }

    _burn(owner, shares);
    _totalAssets -= assets;
    _asset.safeTransfer(receiver, assets);

    emit MockWithdraw(msg.sender, receiver, owner, assets, shares);
    emit Withdraw(msg.sender, receiver, owner, assets, shares);

    return shares;
  }

  /**
   * @notice Maximum shares that can be redeemed by owner
   * @return Maximum redeem amount
   */
  function maxRedeem(address owner) external view override returns (uint256) {
    return balanceOf(owner);
  }

  /**
   * @notice Preview redeem assets received
   * @param shares Shares to redeem
   * @return assets Assets that would be received
   */
  function previewRedeem(uint256 shares) public view override returns (uint256 assets) {
    return convertToAssets(shares);
  }

  /**
   * @notice Redeem shares for assets
   * @param shares Shares to redeem
   * @param receiver Receiver of assets
   * @param owner Owner of shares
   * @return assets Assets received
   */
  function redeem(uint256 shares, address receiver, address owner) external override returns (uint256 assets) {
    if (_paused) revert VaultPaused();
    if (shares == 0) revert ZeroShares();

    assets = previewRedeem(shares);
    if (assets == 0) revert ZeroAssets();

    if (msg.sender != owner) {
      _spendAllowance(owner, msg.sender, shares);
    }

    _burn(owner, shares);
    _totalAssets -= assets;
    _asset.safeTransfer(receiver, assets);

    emit MockWithdraw(msg.sender, receiver, owner, assets, shares);
    emit Withdraw(msg.sender, receiver, owner, assets, shares);

    return assets;
  }

  /* MOCK-SPECIFIC FUNCTIONS FOR TESTING */

  /**
   * @notice Directly set total assets (for testing manipulation scenarios)
   * @param newTotalAssets New total assets amount
   */
  function setMockTotalAssets(uint256 newTotalAssets) external {
    _totalAssets = newTotalAssets;
    emit MockAssetsSet(newTotalAssets);
  }

  /**
   * @notice Simulate donation attack by adding assets without minting shares
   * @param donationAmount Amount to donate directly
   */
  function simulateDonationAttack(uint256 donationAmount) external {
    _asset.safeTransferFrom(msg.sender, address(this), donationAmount);
    _totalAssets += donationAmount;
    // No shares minted - this simulates direct transfer to vault
  }

  /**
   * @notice Pause the vault (for testing error conditions)
   */
  function setPaused(bool pausedState) external {
    _paused = pausedState;
    if (pausedState) {
      emit MockPaused();
    } else {
      emit MockUnpaused();
    }
  }

  /**
   * @notice Check if vault is paused
   * @return True if paused
   */
  function paused() external view returns (bool) {
    return _paused;
  }

  /**
   * @notice Get current exchange rate for debugging
   * @return Current rate (assets per share)
   */
  function getCurrentExchangeRate() external view returns (uint256) {
    uint256 supply = totalSupply();
    return supply == 0 ? 1e18 : (_totalAssets * 1e18) / supply;
  }
}
