// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { ERC4626Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import { ERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { IDStakeCollateralVaultV2 } from "./interfaces/IDStakeCollateralVaultV2.sol";
import { IDStakeRouterV2 } from "./interfaces/IDStakeRouterV2.sol";
import { BasisPointConstants } from "../../common/BasisPointConstants.sol";
import { SupportsWithdrawalFee } from "../../common/SupportsWithdrawalFee.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title DStakeTokenV2
 * @dev ERC4626-compliant token representing shares in the DStakeCollateralVaultV2.
 */
contract DStakeTokenV2 is Initializable, ERC4626Upgradeable, AccessControlUpgradeable, SupportsWithdrawalFee {
  using SafeERC20 for IERC20;

  // --- Roles ---
  bytes32 public constant FEE_MANAGER_ROLE = keccak256("FEE_MANAGER_ROLE");

  // --- Errors ---
  error ZeroAddress();
  error ZeroShares();
  error ERC4626ExceedsMaxWithdraw(uint256 assets, uint256 maxAssets);
  error ERC4626ExceedsMaxRedeem(uint256 shares, uint256 maxShares);
  error InvalidIncentiveBps(uint256 incentiveBps, uint256 maxIncentiveBps);
  error AutoWithdrawShortfall(uint256 expectedNet, uint256 actualNet);

  // --- State ---
  IDStakeCollateralVaultV2 public collateralVault;
  IDStakeRouterV2 public router;

  uint256 public constant MAX_WITHDRAWAL_FEE_BPS = BasisPointConstants.ONE_PERCENT_BPS;
  uint256 public constant MAX_REINVEST_INCENTIVE_BPS = BasisPointConstants.ONE_PERCENT_BPS * 20; // 20% max incentive
  uint256 public reinvestIncentiveBps;

  // --- Initializer ---
  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor() {
    _disableInitializers();
  }

  /**
   * @notice Initializes the DStakeTokenV2 contract
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

    // Initialize reinvest incentive to 1%
    reinvestIncentiveBps = BasisPointConstants.ONE_PERCENT_BPS;
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
   * IMPORTANT: This function returns the total dStable value, including:
   * 1. Assets held in the `DStakeCollateralVaultV2` (wrapper tokens that accrue yield)
   * 2. Any dStable balance held directly by this contract (collected fees from solver withdrawals)
   *
   * Including the contract's dStable balance ensures that withdrawal fees collected
   * from solver withdrawals are properly accounted for in the share pricing, preventing
   * value leakage from the accounting set.
   *
   * When all vault shares have been redeemed, the router intentionally
   * leaves up to `dustTolerance` (1 wei by default) of wrapper tokens in the
   * `DStakeCollateralVaultV2`. These wrapper tokens continue to accrue
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
    // Include both vault holdings and any dStable balance in this contract (fees)
    return collateralVault.totalValueInDStable() + IERC20(asset()).balanceOf(address(this));
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
    uint256 maxAssets = maxWithdraw(owner);
    if (assets > maxAssets) {
      revert ERC4626ExceedsMaxWithdraw(assets, maxAssets);
    }

    // Calculate how many shares correspond to the desired NET `assets` amount.
    shares = previewWithdraw(assets);
    // Rounding note: `previewWithdraw` ultimately calls OpenZeppelin's `_convertToShares` with
    // `Math.Rounding.Ceil`, so any positive-net withdrawal request maps to at least one share.
    // A zero-share result therefore implies `assets == 0`, meaning no funds leave the vault.

    // Ensure the owner has enough shares to cover the withdrawal (checks in share terms rather than assets).
    uint256 maxRedeemShares = maxRedeem(owner);
    if (shares > maxRedeemShares) {
      revert ERC4626ExceedsMaxRedeem(shares, maxRedeemShares);
    }

    // Translate the shares back into the GROSS asset amount that needs to be withdrawn
    // so that the internal logic can compute the fee only once.
    uint256 grossAssets = _getGrossAmountRequiredForNet(assets);

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

    uint256 maxRedeemShares = maxRedeem(owner);
    if (shares > maxRedeemShares) {
      revert ERC4626ExceedsMaxRedeem(shares, maxRedeemShares);
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
   *      The `assets` parameter is the gross amount that needs to be withdrawn from the vault.
   *      The router now returns the gross proceeds to this contract, ensuring all withdrawal
   *      paths share a single fee application point.
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

    // Burn shares from owner
    _burn(owner, shares);

    // Delegate conversion and vault update logic to router
    uint256 grossWithdrawn = router.withdraw(assets);
    uint256 minNetAmount = _getNetAmountAfterFee(assets);
    _settleWithdrawal(caller, receiver, owner, shares, assets, grossWithdrawn, minNetAmount);
  }

  function _settleWithdrawal(
    address caller,
    address receiver,
    address owner,
    uint256 shares,
    uint256 grossRequested,
    uint256 grossReceived,
    uint256 minNetAmount
  ) internal returns (uint256 netAmount) {
    if (grossReceived < grossRequested) {
      revert ERC4626ExceedsMaxWithdraw(grossRequested, grossReceived);
    }

    uint256 fee = _calculateWithdrawalFee(grossReceived);
    netAmount = grossReceived - fee;

    if (netAmount < minNetAmount) {
      revert AutoWithdrawShortfall(minNetAmount, netAmount);
    }

    IERC20(asset()).safeTransfer(receiver, netAmount);

    emit Withdraw(caller, receiver, owner, netAmount, shares);

    if (fee > 0) {
      emit WithdrawalFee(owner, receiver, fee);
    }
    return netAmount;
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
   * @dev Allows solvers to deposit into specific strategy vaults using asset amounts
   * @param strategyVaults Array of strategy vault addresses to deposit into
   * @param assets Array of asset amounts to deposit into each strategy vault
   * @param minShares Minimum dSTAKE shares to mint (slippage protection)
   * @param receiver Address to receive the minted dSTAKE shares
   * @return shares The amount of dSTAKE shares minted
   */
  function solverDepositAssets(
    address[] calldata strategyVaults,
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
    router.solverDepositAssets(strategyVaults, assets);

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
   * @dev Allows solvers to deposit into specific strategy vaults using share amounts
   * @param strategyVaults Array of strategy vault addresses to deposit into
   * @param strategyShares Array of strategy share amounts to deposit into each vault
   * @param minShares Minimum dSTAKE shares to mint (slippage protection)
   * @param receiver Address to receive the minted dSTAKE shares
   * @return totalShares The amount of dSTAKE shares minted
   */
  function solverDepositShares(
    address[] calldata strategyVaults,
    uint256[] calldata strategyShares,
    uint256 minShares,
    address receiver
  ) public virtual returns (uint256 totalShares) {
    // Calculate total assets by converting strategy vault shares to asset amounts
    uint256 totalAssetAmount = 0;
    for (uint256 i = 0; i < strategyVaults.length; i++) {
      if (strategyShares[i] > 0) {
        // Use the strategy vault's previewMint to convert shares to assets
        uint256 assetAmount = IERC4626(strategyVaults[i]).previewMint(strategyShares[i]);
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
    router.solverDepositShares(strategyVaults, strategyShares);

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
   * @dev Allows solvers to withdraw from specific strategy vaults using asset amounts.
   *      The router returns gross amounts, and this function handles fee calculation.
   * @param strategyVaults Array of strategy vault addresses to withdraw from
   * @param assets Array of asset amounts to withdraw from each vault (net amounts requested)
   * @param maxShares Maximum dSTAKE shares to burn (slippage protection)
   * @param receiver Address to receive the withdrawn assets (after fees)
   * @param owner Address that owns the dSTAKE shares being burned
   * @return shares The amount of dSTAKE shares burned
   */
  function solverWithdrawAssets(
    address[] calldata strategyVaults,
    uint256[] calldata assets,
    uint256 maxShares,
    address receiver,
    address owner
  ) public virtual returns (uint256 shares) {
    // Calculate total net assets requested by the solver
    uint256 totalNetAssets = 0;
    uint256 totalGrossAssets = 0;
    uint256[] memory grossAssetRequests = new uint256[](assets.length);
    for (uint256 i = 0; i < assets.length; i++) {
      uint256 requestedNetAmount = assets[i];
      totalNetAssets += requestedNetAmount;

      if (requestedNetAmount > 0) {
        uint256 requestedGrossAmount = _getGrossAmountRequiredForNet(requestedNetAmount);
        grossAssetRequests[i] = requestedGrossAmount;
        totalGrossAssets += requestedGrossAmount;
      }
    }

    if (totalNetAssets == 0) {
      revert ZeroShares();
    }

    uint256 aggregatedGross = _getGrossAmountRequiredForNet(totalNetAssets);
    if (aggregatedGross > totalGrossAssets) {
      uint256 shortfall = aggregatedGross - totalGrossAssets;
      for (uint256 i = assets.length; i > 0; i--) {
        uint256 idx = i - 1;
        if (grossAssetRequests[idx] > 0) {
          grossAssetRequests[idx] += shortfall;
          break;
        }
      }
      totalGrossAssets = aggregatedGross;
    }

    // Convert the gross withdrawal request into shares using ceiling rounding so we never under-burn
    shares = _convertToShares(totalGrossAssets, Math.Rounding.Ceil);
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

    // Delegate to router's solver withdrawal method
    // Router withdraws the GROSS amounts from strategy vaults and returns those assets to this contract
    //
    // FEE RESPONSIBILITY DESIGN:
    // The router receives gross requests that correspond to a desired net withdrawal after fees.
    // It returns the GROSS amount withdrawn to this contract, which then applies the withdrawal fee.
    // This ensures:
    // 1. Only DStakeTokenV2 applies withdrawal fees (router does NOT apply any fees)
    // 2. Fees are applied exactly once on the gross amount returned by the router
    // 3. Router focuses solely on vault operations and slippage management
    // 4. Fee calculation is centralized in the token contract for consistency
    //
    // DOUBLE-CHARGING PREVENTION:
    // The router's solverWithdrawAssets function explicitly does NOT apply any fees.
    // It withdraws the requested amounts from strategy vaults and returns all proceeds
    // as gross amounts to this contract. This contract then applies the withdrawal fee
    // once on the gross amount and transfers the net amount to the receiver.
    uint256 grossWithdrawn = router.solverWithdrawAssets(strategyVaults, grossAssetRequests);

    _settleWithdrawal(_msgSender(), receiver, owner, shares, totalGrossAssets, grossWithdrawn, totalNetAssets);

    return shares;
  }

  /**
   * @notice Solver-facing withdrawal method using share amounts
   * @dev Allows solvers to withdraw from specific strategy vaults using share amounts.
   *      The router returns gross amounts, and this function handles fee calculation.
   * @param strategyVaults Array of strategy vault addresses to withdraw from
   * @param strategyShares Array of strategy share amounts to withdraw from each vault
   * @param maxShares Maximum dSTAKE shares to burn (slippage protection)
   * @param receiver Address to receive the withdrawn assets (after fees)
   * @param owner Address that owns the dSTAKE shares being burned
   * @return assets The amount of net assets withdrawn (after fees)
   */
  function solverWithdrawShares(
    address[] calldata strategyVaults,
    uint256[] calldata strategyShares,
    uint256 maxShares,
    address receiver,
    address owner
  ) public virtual returns (uint256 assets) {
    // Calculate expected gross assets by converting strategy vault shares to assets
    uint256 totalGrossAssets = 0;
    for (uint256 i = 0; i < strategyVaults.length; i++) {
      if (strategyShares[i] > 0) {
        // Use the strategy vault's previewRedeem to convert shares to assets
        uint256 assetAmount = IERC4626(strategyVaults[i]).previewRedeem(strategyShares[i]);
        totalGrossAssets += assetAmount;
      }
    }

    if (totalGrossAssets == 0) {
      revert ZeroShares();
    }

    // Preview dSTAKE shares to be burned (using rounding up to prevent exploitation)
    // Use _convertToShares with Math.Rounding.Ceil to ensure non-zero shares for non-zero withdrawals
    uint256 shares = _convertToShares(totalGrossAssets, Math.Rounding.Ceil);

    // Critical: Prevent zero-share withdrawals that would drain collateral without burning shares
    if (shares == 0 && totalGrossAssets > 0) {
      revert ZeroShares();
    }

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

    // Delegate to router's solver withdrawal method - router returns gross assets
    //
    // FEE RESPONSIBILITY DESIGN:
    // The router receives share amounts to withdraw and performs the actual withdrawals from strategy vaults.
    // It returns the GROSS amount of assets obtained from those withdrawals to this contract.
    // This ensures:
    // 1. Only DStakeTokenV2 applies withdrawal fees (router does NOT apply any fees)
    // 2. Fees are applied exactly once on the gross amount returned by the router
    // 3. Router focuses solely on vault operations and share-to-asset conversions
    // 4. Fee calculation is centralized in the token contract for consistency
    //
    // DOUBLE-CHARGING PREVENTION:
    // The router's solverWithdrawShares function explicitly does NOT apply any fees.
    // It converts the requested shares to assets via strategy vault withdrawals and
    // returns all proceeds as gross amounts to this contract. This contract then
    // applies the withdrawal fee once on the gross amount and transfers the net
    // amount to the receiver.
    uint256 grossWithdrawn = router.solverWithdrawShares(strategyVaults, strategyShares);

    uint256 minNetAmount = _getNetAmountAfterFee(totalGrossAssets);
    assets = _settleWithdrawal(_msgSender(), receiver, owner, shares, totalGrossAssets, grossWithdrawn, minNetAmount);

    return assets;
  }

  // --- Fee Management ---

  /**
   * @notice Reinvests accumulated withdrawal fees back into strategy vaults.
   * @dev This function deposits any dStable balance held by this contract back through the router,
   *      ensuring fees are reinvested and properly accounted for in the protocol's assets.
   *      The caller receives a small incentive (configurable by governance) to encourage regular reinvestment.
   * @return amountReinvested The amount of fees reinvested (after incentive).
   */
  function reinvestFees() external returns (uint256 amountReinvested) {
    uint256 totalAmount = IERC20(asset()).balanceOf(address(this));

    if (totalAmount == 0) {
      return 0;
    }

    if (address(router) == address(0) || address(collateralVault) == address(0)) {
      revert ZeroAddress();
    }

    // Calculate incentive for the caller
    uint256 incentive = 0;
    if (reinvestIncentiveBps > 0) {
      incentive = Math.mulDiv(totalAmount, reinvestIncentiveBps, BasisPointConstants.ONE_HUNDRED_PERCENT_BPS);

      // Transfer incentive to caller
      if (incentive > 0) {
        IERC20(asset()).safeTransfer(_msgSender(), incentive);
      }
    }

    // Calculate amount to reinvest (total minus incentive)
    amountReinvested = totalAmount - incentive;

    if (amountReinvested > 0) {
      // Approve router to spend the remaining fees
      IERC20(asset()).approve(address(router), amountReinvested);

      // Reinvest fees through the router (converts to strategy shares and deposits)
      router.deposit(amountReinvested);
    }

    emit FeesReinvested(amountReinvested, incentive, _msgSender());
    return amountReinvested;
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
    router = IDStakeRouterV2(_router);
    emit RouterSet(_router);
  }

  /**
   * @notice Sets the address of the DStakeCollateralVaultV2 contract.
   * @dev Only callable by DEFAULT_ADMIN_ROLE.
   * @param _collateralVault The address of the new collateral vault contract.
   */
  function setCollateralVault(address _collateralVault) external onlyRole(DEFAULT_ADMIN_ROLE) {
    if (_collateralVault == address(0)) {
      revert ZeroAddress();
    }
    collateralVault = IDStakeCollateralVaultV2(_collateralVault);
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

  /**
   * @notice Sets the reinvestment incentive.
   * @dev Only callable by FEE_MANAGER_ROLE. Uses 2 decimal precision (1 bps = 100).
   * @param _incentiveBps The new reinvestment incentive in basis points (e.g., 10000 = 1%, max 200000 = 20%).
   */
  function setReinvestIncentive(uint256 _incentiveBps) external onlyRole(FEE_MANAGER_ROLE) {
    if (_incentiveBps > MAX_REINVEST_INCENTIVE_BPS) {
      revert InvalidIncentiveBps(_incentiveBps, MAX_REINVEST_INCENTIVE_BPS);
    }
    reinvestIncentiveBps = _incentiveBps;
    emit ReinvestIncentiveSet(_incentiveBps);
  }

  // --- Events ---
  event RouterSet(address indexed router);
  event CollateralVaultSet(address indexed collateralVault);
  event FeesReinvested(uint256 amountReinvested, uint256 incentive, address indexed caller);
  event ReinvestIncentiveSet(uint256 incentiveBps);
}
