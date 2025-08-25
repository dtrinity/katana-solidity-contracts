import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { 
  MockMorphoBlue,
  Morpho4626Vault,
  WrappedMorphoConversionAdapter,
  DStakeToken,
  DStakeCollateralVault,
  DStakeRouterDLend,
  TestMintableERC20
} from "../../../typechain-types";

describe("Morpho Integration with dSTAKE", function () {
  let owner: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  
  let morpho: MockMorphoBlue;
  let dUSD: TestMintableERC20;
  let morphoVault: Morpho4626Vault;
  let adapter: WrappedMorphoConversionAdapter;
  let dStakeToken: DStakeToken;
  let collateralVault: DStakeCollateralVault;
  let router: DStakeRouterDLend;

  const INITIAL_SUPPLY = ethers.parseUnits("1000000", 18);
  const DEPOSIT_AMOUNT = ethers.parseUnits("1000", 18);

  beforeEach(async function () {
    [owner, user1, user2] = await ethers.getSigners();

    // Deploy mock dUSD token
    const TestMintableERC20Factory = await ethers.getContractFactory("TestMintableERC20");
    dUSD = await TestMintableERC20Factory.deploy("Mock dUSD", "dUSD", 18);
    await dUSD.mint(owner.address, INITIAL_SUPPLY);
    await dUSD.mint(user1.address, INITIAL_SUPPLY);
    await dUSD.mint(user2.address, INITIAL_SUPPLY);

    // Deploy MockMorphoBlue
    const MockMorphoBlueFactory = await ethers.getContractFactory("MockMorphoBlue");
    morpho = await MockMorphoBlueFactory.deploy();

    // Create a market
    const marketParams = {
      loanToken: await dUSD.getAddress(),
      collateralToken: ethers.ZeroAddress, // Pure supply market
      oracle: ethers.ZeroAddress,
      irm: ethers.ZeroAddress,
      lltv: 0
    };

    await morpho.createMarket(marketParams);

    // Seed the market with initial liquidity
    await dUSD.approve(await morpho.getAddress(), ethers.parseUnits("10000", 18));
    await morpho.seedSupply(marketParams, ethers.parseUnits("10000", 18));

    // Deploy Morpho4626Vault
    const Morpho4626VaultFactory = await ethers.getContractFactory("Morpho4626Vault");
    morphoVault = await Morpho4626VaultFactory.deploy(
      await morpho.getAddress(),
      marketParams,
      "Morpho dUSD Vault",
      "mvdUSD"
    );

    // Deploy dSTAKE infrastructure
    const DStakeTokenFactory = await ethers.getContractFactory("DStakeToken");
    dStakeToken = await DStakeTokenFactory.deploy();
    await dStakeToken.initialize(
      await dUSD.getAddress(),
      "Staked dUSD",
      "sdUSD",
      owner.address,
      owner.address
    );
    
    // Set withdrawal fee to 1%
    await dStakeToken.setWithdrawalFeeBps(100);

    const DStakeCollateralVaultFactory = await ethers.getContractFactory("DStakeCollateralVault");
    collateralVault = await DStakeCollateralVaultFactory.deploy(
      await dStakeToken.getAddress(),
      await dUSD.getAddress()
    );

    const DStakeRouterDLendFactory = await ethers.getContractFactory("DStakeRouterDLend");
    router = await DStakeRouterDLendFactory.deploy(
      await dStakeToken.getAddress(),
      await collateralVault.getAddress()
    );

    // Deploy WrappedMorphoConversionAdapter
    const WrappedMorphoConversionAdapterFactory = await ethers.getContractFactory("WrappedMorphoConversionAdapter");
    adapter = await WrappedMorphoConversionAdapterFactory.deploy(
      await dUSD.getAddress(),
      await morphoVault.getAddress(),
      await collateralVault.getAddress()
    );

    // Set router on collateral vault
    await collateralVault.setRouter(await router.getAddress());

    // Configure router with adapter
    await router.addVaultAsset(await morphoVault.getAddress(), await adapter.getAddress());
    await router.setDefaultDepositVaultAsset(await morphoVault.getAddress());

    // Set router and collateral vault on dStakeToken
    await dStakeToken.setRouter(await router.getAddress());
    await dStakeToken.setCollateralVault(await collateralVault.getAddress());

    // Grant necessary roles
    await collateralVault.grantRole(await collateralVault.ROUTER_ROLE(), await router.getAddress());
  });

  describe("Morpho4626Vault", function () {
    it("should allow deposits and mints shares", async function () {
      await dUSD.connect(user1).approve(await morphoVault.getAddress(), DEPOSIT_AMOUNT);
      
      const sharesBefore = await morphoVault.balanceOf(user1.address);
      expect(sharesBefore).to.equal(0);

      await morphoVault.connect(user1).deposit(DEPOSIT_AMOUNT, user1.address);

      const sharesAfter = await morphoVault.balanceOf(user1.address);
      expect(sharesAfter).to.be.gt(0);
      expect(sharesAfter).to.equal(DEPOSIT_AMOUNT); // 1:1 for first deposit

      const totalAssets = await morphoVault.totalAssets();
      expect(totalAssets).to.be.closeTo(DEPOSIT_AMOUNT, ethers.parseUnits("1", 15)); // Allow small rounding
    });

    it("should allow withdrawals", async function () {
      // First deposit
      await dUSD.connect(user1).approve(await morphoVault.getAddress(), DEPOSIT_AMOUNT);
      await morphoVault.connect(user1).deposit(DEPOSIT_AMOUNT, user1.address);

      const shares = await morphoVault.balanceOf(user1.address);
      const dUSDBefore = await dUSD.balanceOf(user1.address);

      // Withdraw half
      const withdrawAmount = DEPOSIT_AMOUNT / 2n;
      await morphoVault.connect(user1).withdraw(withdrawAmount, user1.address, user1.address);

      const sharesAfter = await morphoVault.balanceOf(user1.address);
      const dUSDAfter = await dUSD.balanceOf(user1.address);

      expect(sharesAfter).to.be.lt(shares);
      expect(dUSDAfter).to.equal(dUSDBefore + withdrawAmount);
    });

    it("should correctly preview deposits and withdrawals", async function () {
      const previewDeposit = await morphoVault.previewDeposit(DEPOSIT_AMOUNT);
      expect(previewDeposit).to.equal(DEPOSIT_AMOUNT); // 1:1 for first deposit

      await dUSD.connect(user1).approve(await morphoVault.getAddress(), DEPOSIT_AMOUNT);
      await morphoVault.connect(user1).deposit(DEPOSIT_AMOUNT, user1.address);

      const previewWithdraw = await morphoVault.previewWithdraw(DEPOSIT_AMOUNT / 2n);
      expect(previewWithdraw).to.be.closeTo(DEPOSIT_AMOUNT / 2n, ethers.parseUnits("1", 15));
    });
  });

  describe("WrappedMorphoConversionAdapter", function () {
    it("should convert dStable to vault assets", async function () {
      await dUSD.connect(user1).approve(await dStakeToken.getAddress(), DEPOSIT_AMOUNT);

      const tx = await dStakeToken.connect(user1).deposit(
        DEPOSIT_AMOUNT,
        user1.address
      );

      // Check that vault shares were minted to collateral vault
      const vaultShares = await morphoVault.balanceOf(await collateralVault.getAddress());
      expect(vaultShares).to.be.gt(0);
      expect(vaultShares).to.equal(DEPOSIT_AMOUNT); // 1:1 for first deposit

      // Check that dSTAKE tokens were minted to user
      const dStakeBalance = await dStakeToken.balanceOf(user1.address);
      expect(dStakeBalance).to.equal(DEPOSIT_AMOUNT);
    });

    it("should convert vault assets back to dStable", async function () {
      // First deposit
      await dUSD.connect(user1).approve(await dStakeToken.getAddress(), DEPOSIT_AMOUNT);
      await dStakeToken.connect(user1).deposit(
        DEPOSIT_AMOUNT,
        user1.address
      );

      const dStakeBalance = await dStakeToken.balanceOf(user1.address);
      const dUSDBefore = await dUSD.balanceOf(user1.address);

      // Withdraw half
      const withdrawAmount = dStakeBalance / 2n;
      await dStakeToken.connect(user1).withdraw(
        withdrawAmount,
        user1.address,
        user1.address
      );

      const dStakeAfter = await dStakeToken.balanceOf(user1.address);
      const dUSDAfter = await dUSD.balanceOf(user1.address);

      expect(dStakeAfter).to.equal(dStakeBalance - withdrawAmount);
      
      // Account for withdrawal fee (1%)
      const expectedDUSD = withdrawAmount * 99n / 100n;
      expect(dUSDAfter).to.be.closeTo(dUSDBefore + expectedDUSD, ethers.parseUnits("1", 15));
    });

    it("should correctly preview conversions", async function () {
      const previewTo = await adapter.previewConvertToVaultAsset(DEPOSIT_AMOUNT);
      expect(previewTo).to.equal(DEPOSIT_AMOUNT); // 1:1 for first deposit

      const previewFrom = await adapter.previewConvertFromVaultAsset(DEPOSIT_AMOUNT);
      expect(previewFrom).to.equal(DEPOSIT_AMOUNT); // 1:1 initially
    });

    it("should return correct asset value in dStable", async function () {
      const assetValue = await adapter.assetValueInDStable(await morphoVault.getAddress(), DEPOSIT_AMOUNT);
      expect(assetValue).to.equal(DEPOSIT_AMOUNT);
    });
  });

  describe("Integration with dSTAKE Router", function () {
    it("should handle multiple deposits and withdrawals", async function () {
      // User 1 deposits
      await dUSD.connect(user1).approve(await dStakeToken.getAddress(), DEPOSIT_AMOUNT);
      await dStakeToken.connect(user1).deposit(
        DEPOSIT_AMOUNT,
        user1.address
      );

      // User 2 deposits
      await dUSD.connect(user2).approve(await dStakeToken.getAddress(), DEPOSIT_AMOUNT * 2n);
      await dStakeToken.connect(user2).deposit(
        DEPOSIT_AMOUNT * 2n,
        user2.address
      );

      // Check balances
      expect(await dStakeToken.balanceOf(user1.address)).to.equal(DEPOSIT_AMOUNT);
      expect(await dStakeToken.balanceOf(user2.address)).to.equal(DEPOSIT_AMOUNT * 2n);

      // User 1 withdraws half
      await dStakeToken.connect(user1).withdraw(
        DEPOSIT_AMOUNT / 2n,
        user1.address,
        user1.address
      );

      expect(await dStakeToken.balanceOf(user1.address)).to.equal(DEPOSIT_AMOUNT / 2n);
    });

    it("should maintain value parity across operations", async function () {
      // Initial deposit
      await dUSD.connect(user1).approve(await dStakeToken.getAddress(), DEPOSIT_AMOUNT);
      await dStakeToken.connect(user1).deposit(
        DEPOSIT_AMOUNT,
        user1.address
      );

      const totalSupply = await dStakeToken.totalSupply();
      const totalAssets = await dStakeToken.totalAssets();
      
      // Total assets should equal total supply initially
      expect(totalAssets).to.be.closeTo(totalSupply, ethers.parseUnits("1", 15));

      // Another user deposits
      await dUSD.connect(user2).approve(await dStakeToken.getAddress(), DEPOSIT_AMOUNT);
      await dStakeToken.connect(user2).deposit(
        DEPOSIT_AMOUNT,
        user2.address
      );

      const totalSupplyAfter = await dStakeToken.totalSupply();
      const totalAssetsAfter = await dStakeToken.totalAssets();
      
      // Value parity should be maintained
      expect(totalAssetsAfter).to.be.closeTo(totalSupplyAfter, ethers.parseUnits("1", 15));
    });
  });

  describe("MockMorphoBlue", function () {
    it("should track positions correctly", async function () {
      const marketParams = {
        loanToken: await dUSD.getAddress(),
        collateralToken: ethers.ZeroAddress,
        oracle: ethers.ZeroAddress,
        irm: ethers.ZeroAddress,
        lltv: 0
      };

      // Get market ID
      const MarketParamsLib = await ethers.getContractFactory("MarketParamsLib");
      const marketParamsLib = await MarketParamsLib.deploy();
      const marketId = await marketParamsLib.id(marketParams);

      // Check initial position
      const positionBefore = await morpho.position(marketId, await morphoVault.getAddress());
      expect(positionBefore.supplyShares).to.equal(0);

      // Deposit through vault
      await dUSD.connect(user1).approve(await morphoVault.getAddress(), DEPOSIT_AMOUNT);
      await morphoVault.connect(user1).deposit(DEPOSIT_AMOUNT, user1.address);

      // Check position after
      const positionAfter = await morpho.position(marketId, await morphoVault.getAddress());
      expect(positionAfter.supplyShares).to.be.gt(0);
    });

    it("should handle market totals correctly", async function () {
      const marketParams = {
        loanToken: await dUSD.getAddress(),
        collateralToken: ethers.ZeroAddress,
        oracle: ethers.ZeroAddress,
        irm: ethers.ZeroAddress,
        lltv: 0
      };

      const MarketParamsLib = await ethers.getContractFactory("MarketParamsLib");
      const marketParamsLib = await MarketParamsLib.deploy();
      const marketId = await marketParamsLib.id(marketParams);

      const marketBefore = await morpho.market(marketId);
      const totalSupplyBefore = marketBefore.totalSupplyAssets;

      // Deposit through vault
      await dUSD.connect(user1).approve(await morphoVault.getAddress(), DEPOSIT_AMOUNT);
      await morphoVault.connect(user1).deposit(DEPOSIT_AMOUNT, user1.address);

      const marketAfter = await morpho.market(marketId);
      const totalSupplyAfter = marketAfter.totalSupplyAssets;

      expect(totalSupplyAfter).to.equal(totalSupplyBefore + DEPOSIT_AMOUNT);
    });
  });
});