// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IMorpho {
  struct MarketParams {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
  }

  struct Position {
    uint256 supplyShares;
    uint128 borrowShares;
    uint128 collateral;
  }

  struct Market {
    uint128 totalSupplyAssets;
    uint128 totalSupplyShares;
    uint128 totalBorrowAssets;
    uint128 totalBorrowShares;
    uint128 lastUpdate;
    uint128 fee;
  }

  // Core supply/withdraw for suppliers
  function supply(
    MarketParams calldata marketParams,
    uint256 assets,
    uint256 shares,
    address onBehalf,
    bytes calldata data
  ) external returns (uint256 assetsSupplied, uint256 sharesMinted);

  function withdraw(
    MarketParams calldata marketParams,
    uint256 assets,
    uint256 shares,
    address onBehalf,
    address receiver
  ) external returns (uint256 assetsWithdrawn, uint256 sharesBurned);

  // Collateral and borrowing (not required by wrapper but included for completeness/mocks)
  function supplyCollateral(MarketParams calldata marketParams, uint256 assets, address onBehalf, bytes calldata data) external;

  function withdrawCollateral(MarketParams calldata marketParams, uint256 assets, address onBehalf, address receiver) external;

  function borrow(
    MarketParams calldata marketParams,
    uint256 assets,
    uint256 shares,
    address onBehalf,
    address receiver
  ) external returns (uint256 assetsBorrowed, uint256 sharesBorrowed);

  function repay(
    MarketParams calldata marketParams,
    uint256 assets,
    uint256 shares,
    address onBehalf,
    bytes calldata data
  ) external returns (uint256 assetsRepaid, uint256 sharesRepaid);

  // Views
  function market(bytes32 marketId) external view returns (Market memory);
  function position(bytes32 marketId, address user) external view returns (Position memory);
}

