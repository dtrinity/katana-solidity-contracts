// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { ERC4626Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import { ERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { IDStakeCollateralVault } from "./interfaces/IDStakeCollateralVault.sol";
import { IDStakeRouter } from "./interfaces/IDStakeRouter.sol";
import { BasisPointConstants } from "../../common/BasisPointConstants.sol";
import { SupportsWithdrawalFee } from "../../common/SupportsWithdrawalFee.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title DStakeToken
 * @dev ERC4626-compliant token representing shares in the DStakeCollateralVault.
 */
contract DStakeToken is Initializable, ERC4626Upgradeable, AccessControlUpgradeable, SupportsWithdrawalFee {
  using SafeERC20 for IERC20;

  // --- Roles ---
  bytes32 public constant FEE_MANAGER_ROLE = keccak256("FEE_MANAGER_ROLE");

  // --- Errors ---
  error ZeroAddress();
  error ZeroShares();
  error ERC4626ExceedsMaxWithdraw(uint256 assets, uint256 maxAssets);
  error ERC4626ExceedsMaxRedeem(uint256 shares, uint256 maxShares);

  // --- State ---
  IDStakeCollateralVault public collateralVault;
  IDStakeRouter public router;

  uint256 public constant MAX_WITHDRAWAL_FEE_BPS = BasisPointConstants.ONE_PERCENT_BPS;

  // --- Initializer ---
  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor() {
    _disableInitializers();
  }

  /**
   * @notice Initializes the DStakeToken contract
   * @dev This function replaces the constructor for upgradeable contracts
   * @param _dStable The underlying dStable asset
   * @param _name Name of the vault token
   * @param _symbol Symbol of the vault token
   * @param _initialAdmin Address to grant DEFAULT_ADMIN_ROLE
   * @param _initialFeeManager Address to grant FEE_MANAGER_ROLE
   */
  function initialize(
    IERC20 _dStable,
    string memory _name,
    string memory _symbol,
    address _initialAdmin,
    address _initialFeeManager
  ) public initializer {
    __ERC20_init(_name, _symbol);
    __ERC4626_init(_dStable);
    __AccessControl_init();
    _initializeWithdrawalFee(0);

    if (address(_dStable) == address(0) || _initialAdmin == address(0) || _initialFeeManager == address(0)) {
      revert ZeroAddress();
    }

    _grantRole(DEFAULT_ADMIN_ROLE, _initialAdmin);
    _grantRole(FEE_MANAGER_ROLE, _initialFeeManager);
  }

  // --- SupportsWithdrawalFee Implementation ---
  function _maxWithdrawalFeeBps() internal view virtual override returns (uint256) {
    return MAX_WITHDRAWAL_FEE_BPS;
  }

  /**
   * @notice Public getter for the current withdrawal fee in basis points.
   */
  function withdrawalFeeBps() public view returns (uint256) {
    return getWithdrawalFeeBps(); // Uses getter from SupportsWithdrawalFee
  }

  /**
   * @notice Public getter for the maximum withdrawal fee in basis points.
   */
  function maxWithdrawalFeeBps() public pure returns (uint256) {
    return MAX_WITHDRAWAL_FEE_BPS;
  }

  // --- ERC4626 Overrides ---

  /**
   * @inheritdoc ERC4626Upgradeable
   * @dev
   * IMPORTANT: When all vault shares have been redeemed, the router intentionally
   * leaves up to `dustTolerance` (1 wei by default) of wrapper tokens in the
   * `DStakeCollateralVault`. These wrapper tokens continue to accrue
   * yield via an ever-increasing price-per-share. As a result, it is
   * theoretically possible for `totalSupply() == 0` while `totalAssets()`
   * returns a non-zero value.
   *
   * The protocol explicitly accepts that the **first depositor after such a
   * complete withdrawal will receive whatever residual value has
   * accumulated**.  Given the minuscule starting balance (≤ 1 wei) and slow
   * growth rate, the team judged that the gas cost of enforcing a strict
   * invariant outweighed the negligible windfall.
   *
   * Please keep this in mind if `dustTolerance` is increased to a non-negligible value.
   */
  function totalAssets() public view virtual override returns (uint256) {
    if (address(collateralVault) == address(0)) {
      return 0;
    }
    return collateralVault.totalValueInDStable();
  }

  /**
   * @dev Pulls dSTABLE asset from depositor, then delegates the core deposit logic
   *      (converting dSTABLE to vault assets) to the router.
   */
  function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal virtual override {
    // Revert early if the calculated share amount is zero to prevent depositing assets without receiving shares
    if (shares == 0) {
      revert ZeroShares();
    }
    if (address(router) == address(0) || address(collateralVault) == address(0)) {
      revert ZeroAddress(); // Router or Vault not set
    }

    // Pull assets from caller
    super._deposit(caller, receiver, assets, shares); // This handles the ERC20 transfer

    // Approve router to spend the received assets (necessary because super._deposit transfers to this contract)
    IERC20(asset()).forceApprove(address(router), assets);

    // Delegate conversion and vault update logic to router
    router.deposit(assets);
  }

  /**
   * @dev Override to handle withdrawals with fees correctly.
   *      The `assets` parameter is the net amount of assets the user wants to receive.
   */
  function withdraw(uint256 assets, address receiver, address owner) public virtual override returns (uint256 shares) {
    // Calculate how many shares correspond to the desired NET `assets` amount.
    shares = previewWithdraw(assets);

    // Ensure the owner has enough shares to cover the withdrawal (checks in share terms rather than assets).
    if (shares > maxRedeem(owner)) {
      revert ERC4626ExceedsMaxRedeem(shares, maxRedeem(owner));
    }

    // Translate the shares back into the GROSS asset amount that needs to be withdrawn
    // so that the internal logic can compute the fee only once.
    uint256 grossAssets = convertToAssets(shares);

    _withdraw(_msgSender(), receiver, owner, grossAssets, shares);
    return shares;
  }

  /**
   * @notice Returns the maximum NET assets that `owner` can withdraw taking the current
   *         withdrawal fee into account.
   *
   *         OpenZeppelin's reference implementation returns the owner's share balance
   *         converted to assets (i.e. a gross value).  In a fee-charging vault that
   *         exposes `withdraw(netAssets)`, the intuitive expectation is that
   *         `maxWithdraw` already reflects what the user will actually receive after
   *         fees.  We therefore convert the share balance to GROSS assets first and then
   *         subtract the fee.
   */
  function maxWithdraw(address owner) public view virtual override returns (uint256) {
    uint256 grossAssets = convertToAssets(balanceOf(owner));
    return _getNetAmountAfterFee(grossAssets);
  }

  /**
   * @dev Override to ensure the withdrawal fee is deducted only once.
   *      The `shares` parameter is converted to its equivalent gross asset value, then the
   *      internal _withdraw handles fee calculation. The returned value is the net assets
   *      actually received by the `receiver`, matching previewRedeem().
   */
  function redeem(uint256 shares, address receiver, address owner) public virtual override returns (uint256 assets) {
    uint256 grossAssets = convertToAssets(shares); // shares → gross assets before fee

    if (shares > maxRedeem(owner)) {
      revert ERC4626ExceedsMaxRedeem(shares, maxRedeem(owner));
    }

    // Perform withdrawal using gross assets so that _withdraw computes the correct fee once
    _withdraw(_msgSender(), receiver, owner, grossAssets, shares);

    // Net assets the user effectively receives
    assets = _getNetAmountAfterFee(grossAssets);
    return assets;
  }

  /**
   * @dev Calculates withdrawal fee, then delegates the core withdrawal logic
   *      (converting vault assets back to dSTABLE) to the router.
   *      The `assets` parameter is now the gross amount that needs to be withdrawn from the vault.
   */
  function _withdraw(
    address caller,
    address receiver,
    address owner,
    uint256 assets, // This is now the GROSS amount
    uint256 shares
  ) internal virtual override {
    if (caller != owner) {
      _spendAllowance(owner, caller, shares);
    }

    if (address(router) == address(0) || address(collateralVault) == address(0)) {
      revert ZeroAddress(); // Router or Vault not set
    }

    uint256 fee = _calculateWithdrawalFee(assets); // Calculate fee on GROSS amount
    uint256 amountToSend = assets - fee; // Send NET amount to user

    // Burn shares from owner
    _burn(owner, shares);

    // Delegate conversion and vault update logic to router
    // Router is responsible for ensuring `amountToSend` of dSTABLE reaches the `receiver`.
    router.withdraw(amountToSend, receiver, owner);

    // Emit ERC4626 Withdraw event with the NET assets that were actually sent
    emit Withdraw(caller, receiver, owner, amountToSend, shares);

    // Optional: Emit fee event
    if (fee > 0) {
      emit WithdrawalFee(owner, receiver, fee);
    }
  }

  /**
   * @dev Preview withdraw including withdrawal fee.
   */
  function previewWithdraw(uint256 assets) public view virtual override returns (uint256) {
    uint256 grossAssetsRequired = _getGrossAmountRequiredForNet(assets);
    return super.previewWithdraw(grossAssetsRequired);
  }

  /**
   * @dev Preview redeem including withdrawal fee.
   */
  function previewRedeem(uint256 shares) public view virtual override returns (uint256) {
    uint256 grossAssets = super.previewRedeem(shares);
    return _getNetAmountAfterFee(grossAssets);
  }

  // --- Solver-Facing Methods ---

  /**
   * @notice Solver-facing deposit method using asset amounts
   * @dev Allows solvers to deposit into specific vaults using asset amounts
   * @param vaults Array of vault addresses to deposit into
   * @param assets Array of asset amounts to deposit into each vault
   * @param minShares Minimum dSTAKE shares to mint (slippage protection)
   * @param receiver Address to receive the minted dSTAKE shares
   * @return shares The amount of dSTAKE shares minted
   */
  function solverDepositAssets(
    address[] calldata vaults,
    uint256[] calldata assets,
    uint256 minShares,
    address receiver
  ) public virtual returns (uint256 shares) {
    // Calculate total assets
    uint256 totalAssetAmount = 0;
    for (uint256 i = 0; i < assets.length; i++) {
      totalAssetAmount += assets[i];
    }

    if (totalAssetAmount == 0) {
      revert ZeroShares();
    }

    // Preview shares to be minted based on total assets
    shares = previewDeposit(totalAssetAmount);
    if (shares < minShares) {
      revert ERC4626ExceedsMaxWithdraw(shares, minShares); // Reusing error for slippage check
    }

    if (address(router) == address(0)) {
      revert ZeroAddress();
    }

    // Pull assets from caller
    IERC20(asset()).safeTransferFrom(_msgSender(), address(this), totalAssetAmount);

    // Approve router to spend the assets
    IERC20(asset()).forceApprove(address(router), totalAssetAmount);

    // Delegate to router's solver deposit method
    router.solverDepositAssets(vaults, assets);

    // Clean up approval
    IERC20(asset()).forceApprove(address(router), 0);

    // Mint shares to receiver
    _mint(receiver, shares);

    // Emit ERC4626 Deposit event
    emit Deposit(_msgSender(), receiver, totalAssetAmount, shares);

    return shares;
  }

  /**
   * @notice Solver-facing deposit method using share amounts
   * @dev Allows solvers to deposit into specific vaults using share amounts
   * @param vaults Array of vault addresses to deposit into
   * @param shares Array of share amounts to deposit into each vault
   * @param minShares Minimum dSTAKE shares to mint (slippage protection)
   * @param receiver Address to receive the minted dSTAKE shares
   * @return totalShares The amount of dSTAKE shares minted
   */
  function solverDepositShares(
    address[] calldata vaults,
    uint256[] calldata shares,
    uint256 minShares,
    address receiver
  ) public virtual returns (uint256 totalShares) {
    // Calculate total assets by converting vault shares to asset amounts
    uint256 totalAssetAmount = 0;
    for (uint256 i = 0; i < vaults.length; i++) {
      if (shares[i] > 0) {
        // Use the vault's previewMint to convert shares to assets
        uint256 assetAmount = IERC4626(vaults[i]).previewMint(shares[i]);
        totalAssetAmount += assetAmount;
      }
    }

    if (totalAssetAmount == 0) {
      revert ZeroShares();
    }

    // Preview dSTAKE shares to be minted based on total assets
    totalShares = previewDeposit(totalAssetAmount);
    if (totalShares < minShares) {
      revert ERC4626ExceedsMaxWithdraw(totalShares, minShares); // Reusing error for slippage check
    }

    if (address(router) == address(0)) {
      revert ZeroAddress();
    }

    // Pull assets from caller
    IERC20(asset()).safeTransferFrom(_msgSender(), address(this), totalAssetAmount);

    // Approve router to spend the assets
    IERC20(asset()).forceApprove(address(router), totalAssetAmount);

    // Delegate to router's solver deposit method
    router.solverDepositShares(vaults, shares);

    // Clean up approval
    IERC20(asset()).forceApprove(address(router), 0);

    // Mint dSTAKE shares to receiver
    _mint(receiver, totalShares);

    // Emit ERC4626 Deposit event
    emit Deposit(_msgSender(), receiver, totalAssetAmount, totalShares);

    return totalShares;
  }

  /**
   * @notice Solver-facing withdrawal method using asset amounts
   * @dev Allows solvers to withdraw from specific vaults using asset amounts
   * @param vaults Array of vault addresses to withdraw from
   * @param assets Array of asset amounts to withdraw from each vault (net amounts)
   * @param maxShares Maximum dSTAKE shares to burn (slippage protection)
   * @param receiver Address to receive the withdrawn assets
   * @param owner Address that owns the dSTAKE shares being burned
   * @return shares The amount of dSTAKE shares burned
   */
  function solverWithdrawAssets(
    address[] calldata vaults,
    uint256[] calldata assets,
    uint256 maxShares,
    address receiver,
    address owner
  ) public virtual returns (uint256 shares) {
    // Calculate total net assets to withdraw
    uint256 totalNetAssets = 0;
    for (uint256 i = 0; i < assets.length; i++) {
      totalNetAssets += assets[i];
    }

    if (totalNetAssets == 0) {
      revert ZeroShares();
    }

    // Preview shares to be burned based on net assets (previewWithdraw handles fee calculation)
    shares = previewWithdraw(totalNetAssets);
    if (shares > maxShares) {
      revert ERC4626ExceedsMaxRedeem(shares, maxShares);
    }

    // Check allowance if caller is not owner
    if (_msgSender() != owner) {
      _spendAllowance(owner, _msgSender(), shares);
    }

    if (address(router) == address(0)) {
      revert ZeroAddress();
    }

    // Burn shares from owner
    _burn(owner, shares);

    // Delegate to router's solver withdrawal method - router handles the net amounts directly
    uint256 netWithdrawn = router.solverWithdrawAssets(vaults, assets, receiver, owner);

    // Transfer the net amount to receiver (no additional fee deduction)
    IERC20(asset()).safeTransfer(receiver, netWithdrawn);

    // Emit ERC4626 Withdraw event with net assets
    emit Withdraw(_msgSender(), receiver, owner, netWithdrawn, shares);

    return shares;
  }

  /**
   * @notice Solver-facing withdrawal method using share amounts
   * @dev Allows solvers to withdraw from specific vaults using share amounts
   * @param vaults Array of vault addresses to withdraw from
   * @param vaultShares Array of share amounts to withdraw from each vault
   * @param maxShares Maximum dSTAKE shares to burn (slippage protection)
   * @param receiver Address to receive the withdrawn assets
   * @param owner Address that owns the dSTAKE shares being burned
   * @return assets The amount of net assets withdrawn
   */
  function solverWithdrawShares(
    address[] calldata vaults,
    uint256[] calldata vaultShares,
    uint256 maxShares,
    address receiver,
    address owner
  ) public virtual returns (uint256 assets) {
    // Calculate expected net assets by converting vault shares to assets
    uint256 totalExpectedAssets = 0;
    for (uint256 i = 0; i < vaults.length; i++) {
      if (vaultShares[i] > 0) {
        // Use the vault's previewRedeem to convert shares to assets
        uint256 assetAmount = IERC4626(vaults[i]).previewRedeem(vaultShares[i]);
        totalExpectedAssets += assetAmount;
      }
    }

    if (totalExpectedAssets == 0) {
      revert ZeroShares();
    }

    // Calculate withdrawal fee from the expected assets
    uint256 fee = _calculateWithdrawalFee(totalExpectedAssets);
    uint256 netExpectedAssets = totalExpectedAssets - fee;

    // Preview dSTAKE shares to be burned based on net assets
    uint256 shares = previewWithdraw(netExpectedAssets);
    if (shares > maxShares) {
      revert ERC4626ExceedsMaxRedeem(shares, maxShares);
    }

    // Check allowance if caller is not owner
    if (_msgSender() != owner) {
      _spendAllowance(owner, _msgSender(), shares);
    }

    if (address(router) == address(0)) {
      revert ZeroAddress();
    }

    // Burn shares from owner
    _burn(owner, shares);

    // Delegate to router's solver withdrawal method - router returns net assets
    assets = router.solverWithdrawShares(vaults, vaultShares, receiver, owner);

    // Transfer the net amount to receiver (no additional fee deduction)
    IERC20(asset()).safeTransfer(receiver, assets);

    // Emit fee event if applicable
    if (fee > 0) {
      emit WithdrawalFee(owner, receiver, fee);
    }

    // Emit ERC4626 Withdraw event with net assets
    emit Withdraw(_msgSender(), receiver, owner, assets, shares);

    return assets;
  }

  // --- Governance Functions ---

  /**
   * @notice Sets the address of the DStakeRouter contract.
   * @dev Only callable by DEFAULT_ADMIN_ROLE.
   * @param _router The address of the new router contract.
   */
  function setRouter(address _router) external onlyRole(DEFAULT_ADMIN_ROLE) {
    if (_router == address(0)) {
      revert ZeroAddress();
    }
    router = IDStakeRouter(_router);
    emit RouterSet(_router);
  }

  /**
   * @notice Sets the address of the DStakeCollateralVault contract.
   * @dev Only callable by DEFAULT_ADMIN_ROLE.
   * @param _collateralVault The address of the new collateral vault contract.
   */
  function setCollateralVault(address _collateralVault) external onlyRole(DEFAULT_ADMIN_ROLE) {
    if (_collateralVault == address(0)) {
      revert ZeroAddress();
    }
    collateralVault = IDStakeCollateralVault(_collateralVault);
    emit CollateralVaultSet(_collateralVault);
  }

  /**
   * @notice Sets the withdrawal fee in basis points.
   * @dev Requires FEE_MANAGER_ROLE.
   * @param _feeBps The new withdrawal fee (e.g., 1000 = 0.1%).
   */
  function setWithdrawalFee(uint256 _feeBps) external onlyRole(FEE_MANAGER_ROLE) {
    _setWithdrawalFee(_feeBps);
  }

  // --- Events ---
  event RouterSet(address indexed router);
  event CollateralVaultSet(address indexed collateralVault);
}
