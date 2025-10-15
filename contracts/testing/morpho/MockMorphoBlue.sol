// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IMorpho } from "../../interfaces/morpho/IMorpho.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { MarketParamsLib } from "./MarketParamsLib.sol";

contract MockMorphoBlue is IMorpho {
    using SafeERC20 for IERC20;

    struct Totals {
        uint256 supplyAssets;
        uint256 supplyShares;
        uint256 borrowAssets;
        uint256 borrowShares;
    }

    mapping(bytes32 => Market) public markets;
    mapping(bytes32 => mapping(address => Position)) public positions;

    event MarketCreated(bytes32 indexed id, MarketParams params);

    function createMarket(MarketParams memory params) external returns (bytes32 id) {
        id = MarketParamsLib.id(params);
        Market storage m = markets[id];
        require(m.lastUpdate == 0, "exists");
        m.lastUpdate = uint128(block.timestamp);
        emit MarketCreated(id, params);
    }

    function seedSupply(MarketParams memory params, uint256 assets) external {
        bytes32 id = MarketParamsLib.id(params);
        Market storage m = markets[id];
        require(m.lastUpdate != 0, "no market");
        IERC20(params.loanToken).safeTransferFrom(msg.sender, address(this), assets);
        // 1:1 shares baseline if none
        uint256 shares = m.totalSupplyShares == 0
            ? assets
            : (assets * uint256(m.totalSupplyShares)) / uint256(m.totalSupplyAssets);
        m.totalSupplyAssets = uint128(uint256(m.totalSupplyAssets) + assets);
        m.totalSupplyShares = uint128(uint256(m.totalSupplyShares) + shares);
        positions[id][address(this)].supplyShares += shares;
    }

    function supply(
        MarketParams calldata params,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        bytes calldata /*data*/
    ) external returns (uint256 assetsSupplied, uint256 sharesMinted) {
        bytes32 id = MarketParamsLib.id(params);
        Market storage m = markets[id];
        require(m.lastUpdate != 0, "no market");
        if (assets > 0) {
            IERC20(params.loanToken).safeTransferFrom(msg.sender, address(this), assets);
            sharesMinted = m.totalSupplyShares == 0
                ? assets
                : (assets * uint256(m.totalSupplyShares)) / uint256(m.totalSupplyAssets);
            assetsSupplied = assets;
        } else {
            // shares path
            sharesMinted = shares;
            assetsSupplied =
                (shares * uint256(m.totalSupplyAssets)) /
                (uint256(m.totalSupplyShares) == 0 ? 1 : uint256(m.totalSupplyShares));
            IERC20(params.loanToken).safeTransferFrom(msg.sender, address(this), assetsSupplied);
        }
        m.totalSupplyAssets = uint128(uint256(m.totalSupplyAssets) + assetsSupplied);
        m.totalSupplyShares = uint128(uint256(m.totalSupplyShares) + sharesMinted);
        positions[id][onBehalf].supplyShares += sharesMinted;
    }

    function withdraw(
        MarketParams calldata params,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        address receiver
    ) external returns (uint256 assetsWithdrawn, uint256 sharesBurned) {
        bytes32 id = MarketParamsLib.id(params);
        Market storage m = markets[id];
        require(m.lastUpdate != 0, "no market");
        Position storage p = positions[id][onBehalf];
        if (assets > 0) {
            sharesBurned =
                (assets * uint256(m.totalSupplyShares)) /
                (uint256(m.totalSupplyAssets) == 0 ? 1 : uint256(m.totalSupplyAssets));
            assetsWithdrawn = assets;
        } else {
            sharesBurned = shares;
            assetsWithdrawn =
                (shares * uint256(m.totalSupplyAssets)) /
                (uint256(m.totalSupplyShares) == 0 ? 1 : uint256(m.totalSupplyShares));
        }
        require(p.supplyShares >= sharesBurned, "insufficient shares");
        p.supplyShares -= sharesBurned;
        m.totalSupplyShares = uint128(uint256(m.totalSupplyShares) - sharesBurned);
        m.totalSupplyAssets = uint128(uint256(m.totalSupplyAssets) - assetsWithdrawn);
        IERC20(params.loanToken).safeTransfer(receiver, assetsWithdrawn);
    }

    function supplyCollateral(MarketParams calldata params, uint256 assets, address onBehalf, bytes calldata) external {
        bytes32 id = MarketParamsLib.id(params);
        Market storage m = markets[id];
        require(m.lastUpdate != 0, "no market");
        IERC20(params.collateralToken).safeTransferFrom(msg.sender, address(this), assets);
        positions[id][onBehalf].collateral += uint128(assets);
    }

    function withdrawCollateral(
        MarketParams calldata params,
        uint256 assets,
        address onBehalf,
        address receiver
    ) external {
        bytes32 id = MarketParamsLib.id(params);
        Market storage m = markets[id];
        require(m.lastUpdate != 0, "no market");
        Position storage p = positions[id][onBehalf];
        require(p.collateral >= assets, "insufficient collat");
        p.collateral -= uint128(assets);
        IERC20(params.collateralToken).safeTransfer(receiver, assets);
    }

    function borrow(
        MarketParams calldata params,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        address receiver
    ) external returns (uint256 assetsBorrowed, uint256 sharesBorrowed) {
        bytes32 id = MarketParamsLib.id(params);
        Market storage m = markets[id];
        require(m.lastUpdate != 0, "no market");
        if (assets > 0) {
            sharesBorrowed = m.totalBorrowShares == 0
                ? assets
                : (assets * uint256(m.totalBorrowShares)) / uint256(m.totalBorrowAssets);
            assetsBorrowed = assets;
        } else {
            sharesBorrowed = shares;
            assetsBorrowed =
                (shares * uint256(m.totalBorrowAssets)) /
                (uint256(m.totalBorrowShares) == 0 ? 1 : uint256(m.totalBorrowShares));
        }
        positions[id][onBehalf].borrowShares += uint128(sharesBorrowed);
        m.totalBorrowShares = uint128(uint256(m.totalBorrowShares) + sharesBorrowed);
        m.totalBorrowAssets = uint128(uint256(m.totalBorrowAssets) + assetsBorrowed);
        IERC20(params.loanToken).safeTransfer(receiver, assetsBorrowed);
    }

    function repay(
        MarketParams calldata params,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        bytes calldata /*data*/
    ) external returns (uint256 assetsRepaid, uint256 sharesRepaid) {
        bytes32 id = MarketParamsLib.id(params);
        Market storage m = markets[id];
        require(m.lastUpdate != 0, "no market");
        Position storage p = positions[id][onBehalf];
        if (assets > 0) {
            sharesRepaid = m.totalBorrowShares == 0
                ? assets
                : (assets * uint256(m.totalBorrowShares)) / uint256(m.totalBorrowAssets);
            assetsRepaid = assets;
        } else {
            sharesRepaid = shares;
            assetsRepaid =
                (shares * uint256(m.totalBorrowAssets)) /
                (uint256(m.totalBorrowShares) == 0 ? 1 : uint256(m.totalBorrowShares));
        }
        require(p.borrowShares >= sharesRepaid, "insufficient debt shares");
        IERC20(params.loanToken).safeTransferFrom(msg.sender, address(this), assetsRepaid);
        p.borrowShares -= uint128(sharesRepaid);
        m.totalBorrowShares = uint128(uint256(m.totalBorrowShares) - sharesRepaid);
        m.totalBorrowAssets = uint128(uint256(m.totalBorrowAssets) - assetsRepaid);
    }

    function market(bytes32 marketId) external view returns (Market memory) {
        return markets[marketId];
    }

    function position(bytes32 marketId, address user) external view returns (Position memory) {
        return positions[marketId][user];
    }
}
