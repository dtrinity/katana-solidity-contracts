// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/interfaces/IERC3156FlashLender.sol";
import "@openzeppelin/contracts/interfaces/IERC3156FlashBorrower.sol";

import "../RedeemerV2.sol";
import "../IssuerV2.sol";
import "../CollateralHolderVault.sol";

/**
 * @title FlashMintCollateralExchanger
 * @notice Internal admin helper to rotate CollateralHolderVault assets via flash mint + redeem + LiFi swap + mint.
 *         All operations are single-transaction, heavily permissioned, and limited by allowlists.
 */
contract FlashMintCollateralExchanger is AccessControl, Pausable, ReentrancyGuard, IERC3156FlashBorrower {
    using SafeERC20 for IERC20Metadata;

    /* Roles */
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    /* Errors */
    error NotFlashLender();
    error InvalidInitiator();
    error UnsupportedAsset(address asset);
    error RouterNotAllowed(address router);
    error SpenderNotAllowed(address spender);
    error RecipientNotAllowed(address recipient);
    error ChainIdMismatch(uint256 expected, uint256 actualFrom, uint256 actualTo);
    error DeadlineExpired(uint256 deadline, uint256 currentTimestamp);
    error TokenMismatch(address expected, address actual);
    error AmountOutTooLow(uint256 actual, uint256 minExpected);
    error CollateralPairMustDiffer();
    error FlashAmountTooHigh(uint256 requested, uint256 available);
    error ShortfallNotCovered();
    error RedeemerRoleMissing();
    error ValueMismatch(uint256 expected, uint256 supplied);

    /* Data structures */
    struct LiFiData {
        address callTo; // Router/target
        address approveTo; // Spender that will pull fromCollateral
        uint256 value; // ETH value to forward
        bytes data; // Encoded call data
        uint256 deadline; // Timestamp by which the swap must execute
        address recipient; // Expected recipient of toCollateral (enforced)
        uint256 fromChainId; // Must equal current chain
        uint256 toChainId; // Must equal current chain
    }

    struct FlashExchangeParams {
        address fromCollateral;
        address toCollateral;
        uint256 flashAmount; // dStable to borrow
        uint256 minCollateralOut; // From Redeemer
        uint256 minToAmount; // From swap
        uint256 minMinted; // From Issuer
        address shortfallPayer; // Address to pull dStable from if minted < amount+fee
        bool useProtocolRedeem; // If true, call redeemAsProtocol (requires role)
        LiFiData lifiData;
    }

    /* Immutable configuration */
    IERC20Metadata public immutable dstable;

    /* Core dependencies (mutable by admin) */
    IERC3156FlashLender public flashLender;
    RedeemerV2 public redeemer;
    IssuerV2 public issuer;
    CollateralHolderVault public collateralVault;

    /* Governance sinks */
    address public surplusRecipient;

    /* Swap configuration */
    address public swapRouter;
    mapping(address => bool) public allowedCollaterals;

    /* Events */
    event SwapRouterUpdated(address indexed router);
    event CollateralAllowed(address indexed collateral, bool allowed);
    event FlashLenderUpdated(address indexed lender);
    event RedeemerUpdated(address indexed redeemer);
    event IssuerUpdated(address indexed issuer);
    event CollateralVaultUpdated(address indexed vault);
    event SurplusRecipientUpdated(address indexed recipient);
    event FlashExchangeExecuted(
        address indexed operator,
        address indexed fromCollateral,
        address indexed toCollateral,
        uint256 flashAmount,
        uint256 minted,
        uint256 fee,
        uint256 shortfallFromPayer
    );

    constructor(
        address _dstable,
        address _flashLender,
        address _redeemer,
        address _issuer,
        address _collateralVault,
        address _surplusRecipient
    ) {
        dstable = IERC20Metadata(_dstable);
        flashLender = IERC3156FlashLender(_flashLender);
        redeemer = RedeemerV2(_redeemer);
        issuer = IssuerV2(_issuer);
        collateralVault = CollateralHolderVault(_collateralVault);
        surplusRecipient = _surplusRecipient;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(OPERATOR_ROLE, msg.sender);
    }

    /* ----------------------------- Admin config ----------------------------- */

    function setFlashLender(address lender) external onlyRole(DEFAULT_ADMIN_ROLE) {
        flashLender = IERC3156FlashLender(lender);
        emit FlashLenderUpdated(lender);
    }

    function setRedeemer(address _redeemer) external onlyRole(DEFAULT_ADMIN_ROLE) {
        redeemer = RedeemerV2(_redeemer);
        emit RedeemerUpdated(_redeemer);
    }

    function setIssuer(address _issuer) external onlyRole(DEFAULT_ADMIN_ROLE) {
        issuer = IssuerV2(_issuer);
        emit IssuerUpdated(_issuer);
    }

    function setCollateralVault(address _vault) external onlyRole(DEFAULT_ADMIN_ROLE) {
        collateralVault = CollateralHolderVault(_vault);
        emit CollateralVaultUpdated(_vault);
    }

    function setSurplusRecipient(address recipient) external onlyRole(DEFAULT_ADMIN_ROLE) {
        surplusRecipient = recipient;
        emit SurplusRecipientUpdated(recipient);
    }

    function setSwapRouter(address router) external onlyRole(DEFAULT_ADMIN_ROLE) {
        swapRouter = router;
        emit SwapRouterUpdated(router);
    }

    function allowCollateral(address collateral, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        allowedCollaterals[collateral] = allowed;
        emit CollateralAllowed(collateral, allowed);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /* ------------------------------ Flash entry ----------------------------- */

    /**
     * @notice Executes a flash-mint based collateral exchange using the provided parameters.
     * @dev msg.value must equal params.lifiData.value (typically zero). Caller supplies any required ETH upfront.
     */
    function executeFlashExchange(
        FlashExchangeParams calldata params
    ) external payable onlyRole(OPERATOR_ROLE) nonReentrant whenNotPaused {
        if (params.fromCollateral == params.toCollateral) {
            revert CollateralPairMustDiffer();
        }
        if (!allowedCollaterals[params.fromCollateral] || !allowedCollaterals[params.toCollateral]) {
            revert UnsupportedAsset(
                !allowedCollaterals[params.fromCollateral] ? params.fromCollateral : params.toCollateral
            );
        }
        if (msg.value != params.lifiData.value) {
            revert ValueMismatch(params.lifiData.value, msg.value);
        }

        // Encode params for callback
        bytes memory data = abi.encode(params);
        // Pre-approve token contract to pull repayments after callback
        dstable.forceApprove(address(flashLender), type(uint256).max);
        bool ok = flashLender.flashLoan(this, address(dstable), params.flashAmount, data);
        require(ok, "flashLoan failed");
        // Sweep any residual dStable (post-burn) to surplus recipient
        uint256 leftover = dstable.balanceOf(address(this));
        if (leftover > 0 && surplusRecipient != address(0)) {
            dstable.safeTransfer(surplusRecipient, leftover);
        }
    }

    /* ---------------------------- Flash callback ---------------------------- */

    function onFlashLoan(
        address initiator,
        address token,
        uint256 amount,
        uint256 fee,
        bytes calldata data
    ) external override returns (bytes32) {
        if (msg.sender != address(flashLender)) {
            revert NotFlashLender();
        }
        if (initiator != address(this)) {
            revert InvalidInitiator();
        }
        if (token != address(dstable)) {
            revert TokenMismatch(address(dstable), token);
        }

        // Pre-approve lender (token) for repayment burning
        dstable.forceApprove(msg.sender, type(uint256).max);

        FlashExchangeParams memory params = abi.decode(data, (FlashExchangeParams));

        // Basic param validation
        if (params.fromCollateral == params.toCollateral) revert CollateralPairMustDiffer();
        if (!allowedCollaterals[params.fromCollateral] || !allowedCollaterals[params.toCollateral]) {
            revert UnsupportedAsset(
                !allowedCollaterals[params.fromCollateral] ? params.fromCollateral : params.toCollateral
            );
        }
        _validateLiFi(params.lifiData, params.toCollateral);

        {
            // 1) Redeem borrowed dStable for fromCollateral
            _redeem(params, amount);
            // 2) Swap fromCollateral -> toCollateral via LiFi
            uint256 toCollateralReceived = _executeSwap(params);
            if (toCollateralReceived < params.minToAmount) {
                revert AmountOutTooLow(toCollateralReceived, params.minToAmount);
            }

            // 3) Mint dStable using toCollateral
            uint256 minted = _mint(params, toCollateralReceived);
            if (minted < params.minMinted) {
                revert AmountOutTooLow(minted, params.minMinted);
            }

            // 4) Ensure ability to repay flash loan, pull shortfall if needed
            uint256 shortfall = _ensureRepayment(amount, fee, params.shortfallPayer);

            // 5) Sweep any residual collaterals to the vault
            _sweepCollateral(params.fromCollateral);
            _sweepCollateral(params.toCollateral);

            emit FlashExchangeExecuted(
                tx.origin,
                params.fromCollateral,
                params.toCollateral,
                amount,
                minted,
                fee,
                shortfall
            );
        }

        return keccak256("ERC3156FlashBorrower.onFlashLoan");
    }

    /* ----------------------------- Internal logic --------------------------- */

    function _redeem(FlashExchangeParams memory params, uint256 flashAmount) internal {
        // Approve Redeemer for the borrowed amount
        _safeApprove(address(dstable), address(redeemer), flashAmount);

        if (params.useProtocolRedeem) {
            if (!redeemer.hasRole(redeemer.REDEMPTION_MANAGER_ROLE(), address(this))) {
                revert RedeemerRoleMissing();
            }
            redeemer.redeemAsProtocol(flashAmount, params.fromCollateral, params.minCollateralOut);
        } else {
            redeemer.redeem(flashAmount, params.fromCollateral, params.minCollateralOut);
        }

        // Clear approval
        _safeApprove(address(dstable), address(redeemer), 0);
    }

    function _executeSwap(FlashExchangeParams memory params) internal returns (uint256 toReceived) {
        LiFiData memory lifi = params.lifiData;

        if (swapRouter == address(0)) revert RouterNotAllowed(lifi.callTo);
        if (lifi.callTo != swapRouter) revert RouterNotAllowed(lifi.callTo);
        if (lifi.approveTo != swapRouter) revert SpenderNotAllowed(lifi.approveTo);
        if (lifi.recipient != address(this)) revert RecipientNotAllowed(lifi.recipient);

        uint256 fromBalance = IERC20Metadata(params.fromCollateral).balanceOf(address(this));
        _safeApprove(params.fromCollateral, lifi.approveTo, fromBalance);

        uint256 toBalanceBefore = IERC20Metadata(params.toCollateral).balanceOf(lifi.recipient);

        (bool ok, ) = lifi.callTo.call{ value: lifi.value }(lifi.data);
        require(ok, "LiFi call failed");

        uint256 toBalanceAfter = IERC20Metadata(params.toCollateral).balanceOf(lifi.recipient);
        toReceived = toBalanceAfter - toBalanceBefore;

        if (toReceived < params.minToAmount) {
            revert AmountOutTooLow(toReceived, params.minToAmount);
        }

        // Ensure fromCollateral is fully spent or sweep remainder later; clear allowance
        _safeApprove(params.fromCollateral, lifi.approveTo, 0);
    }

    function _mint(FlashExchangeParams memory params, uint256 toCollateralReceived) internal returns (uint256 minted) {
        uint256 toBal = IERC20Metadata(params.toCollateral).balanceOf(address(this));
        // Sanity: ensure we observe the received amount locally
        require(toBal >= toCollateralReceived, "missing toCollateral");

        _safeApprove(params.toCollateral, address(issuer), toBal);
        issuer.issue(toBal, params.toCollateral, params.minMinted);
        _safeApprove(params.toCollateral, address(issuer), 0);

        minted = dstable.balanceOf(address(this));
    }

    function _ensureRepayment(
        uint256 amount,
        uint256 fee,
        address shortfallPayer
    ) internal returns (uint256 shortfall) {
        uint256 due = amount + fee;
        uint256 bal = dstable.balanceOf(address(this));
        if (bal < due) {
            shortfall = due - bal;
            if (shortfallPayer == address(0)) {
                revert ShortfallNotCovered();
            }
            dstable.safeTransferFrom(shortfallPayer, address(this), shortfall);
            bal = dstable.balanceOf(address(this));
        }
        require(bal >= due, "insufficient to repay");
        // Approve lender (token contract) to burn due amount after callback
        dstable.forceApprove(address(flashLender), due);
    }

    function _validateLiFi(LiFiData memory lifi, address expectedToCollateral) internal view {
        if (lifi.deadline < block.timestamp) {
            revert DeadlineExpired(lifi.deadline, block.timestamp);
        }
        if (lifi.fromChainId != block.chainid || lifi.toChainId != block.chainid) {
            revert ChainIdMismatch(block.chainid, lifi.fromChainId, lifi.toChainId);
        }
        if (lifi.recipient != address(this)) {
            revert RecipientNotAllowed(lifi.recipient);
        }
        if (lifi.value != 0 && address(this).balance < lifi.value) {
            revert ValueMismatch(lifi.value, address(this).balance);
        }
        // expectedToCollateral is enforced by balance delta on this contract
        expectedToCollateral; // silence unused warning
    }

    function _sweepCollateral(address token) internal {
        uint256 bal = IERC20Metadata(token).balanceOf(address(this));
        if (bal > 0) {
            IERC20Metadata(token).safeTransfer(address(collateralVault), bal);
        }
    }

    function _safeApprove(address token, address spender, uint256 amount) internal {
        IERC20Metadata erc = IERC20Metadata(token);
        erc.forceApprove(spender, amount);
    }

    /* ------------------------------- Recovery ------------------------------- */

    function sweep(address token, address to) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 bal = IERC20Metadata(token).balanceOf(address(this));
        IERC20Metadata(token).safeTransfer(to, bal);
    }

    receive() external payable {}
}
