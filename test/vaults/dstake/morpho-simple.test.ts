import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { 
  MockMorphoBlue,
  Morpho4626Vault,
  TestMintableERC20
} from "../../../typechain-types";

describe("Morpho Components", function () {
  let owner: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  
  let morpho: MockMorphoBlue;
  let dUSD: TestMintableERC20;
  let morphoVault: Morpho4626Vault;

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
  });

  describe("MockMorphoBlue", function () {
    it("should create markets and track them correctly", async function () {
      const marketParams = {
        loanToken: await dUSD.getAddress(),
        collateralToken: ethers.ZeroAddress,
        oracle: ethers.ZeroAddress,
        irm: ethers.ZeroAddress,
        lltv: 0
      };

      // Calculate market ID  
      const marketId = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(address,address,address,address,uint256)"],
        [[marketParams.loanToken, marketParams.collateralToken, marketParams.oracle, marketParams.irm, marketParams.lltv]]
      ));

      const market = await morpho.market(marketId);
      expect(market.totalSupplyAssets).to.equal(ethers.parseUnits("10000", 18));
      expect(market.totalSupplyShares).to.equal(ethers.parseUnits("10000", 18));
    });

    it("should handle supply and withdraw", async function () {
      const marketParams = {
        loanToken: await dUSD.getAddress(),
        collateralToken: ethers.ZeroAddress,
        oracle: ethers.ZeroAddress,
        irm: ethers.ZeroAddress,
        lltv: 0
      };

      const supplyAmount = ethers.parseUnits("100", 18);
      await dUSD.connect(user1).approve(await morpho.getAddress(), supplyAmount);
      
      await morpho.connect(user1).supply(
        marketParams,
        supplyAmount,
        0,
        user1.address,
        "0x"
      );

      const marketId = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(address,address,address,address,uint256)"],
        [[marketParams.loanToken, marketParams.collateralToken, marketParams.oracle, marketParams.irm, marketParams.lltv]]
      ));

      const position = await morpho.position(marketId, user1.address);
      expect(position.supplyShares).to.equal(supplyAmount);

      // Withdraw half
      await morpho.connect(user1).withdraw(
        marketParams,
        supplyAmount / 2n,
        0,
        user1.address,
        user1.address
      );

      const positionAfter = await morpho.position(marketId, user1.address);
      expect(positionAfter.supplyShares).to.equal(supplyAmount / 2n);
    });
  });

  describe("Morpho4626Vault", function () {
    it("should implement ERC4626 interface correctly", async function () {
      expect(await morphoVault.asset()).to.equal(await dUSD.getAddress());
      expect(await morphoVault.totalAssets()).to.equal(0);
    });

    it("should allow deposits and mints shares", async function () {
      await dUSD.connect(user1).approve(await morphoVault.getAddress(), DEPOSIT_AMOUNT);
      
      const sharesBefore = await morphoVault.balanceOf(user1.address);
      expect(sharesBefore).to.equal(0);

      const expectedShares = await morphoVault.previewDeposit(DEPOSIT_AMOUNT);
      await morphoVault.connect(user1).deposit(DEPOSIT_AMOUNT, user1.address);

      const sharesAfter = await morphoVault.balanceOf(user1.address);
      expect(sharesAfter).to.equal(expectedShares);
      expect(sharesAfter).to.equal(DEPOSIT_AMOUNT); // 1:1 for first deposit

      const totalAssets = await morphoVault.totalAssets();
      expect(totalAssets).to.be.closeTo(DEPOSIT_AMOUNT, ethers.parseUnits("1", 15));
    });

    it("should allow minting exact shares", async function () {
      const sharesToMint = ethers.parseUnits("500", 18);
      const assetsNeeded = await morphoVault.previewMint(sharesToMint);
      
      await dUSD.connect(user1).approve(await morphoVault.getAddress(), assetsNeeded);
      await morphoVault.connect(user1).mint(sharesToMint, user1.address);

      const balance = await morphoVault.balanceOf(user1.address);
      expect(balance).to.equal(sharesToMint);
    });

    it("should allow withdrawals", async function () {
      // First deposit
      await dUSD.connect(user1).approve(await morphoVault.getAddress(), DEPOSIT_AMOUNT);
      await morphoVault.connect(user1).deposit(DEPOSIT_AMOUNT, user1.address);

      const shares = await morphoVault.balanceOf(user1.address);
      const dUSDBefore = await dUSD.balanceOf(user1.address);

      // Withdraw half
      const withdrawAmount = DEPOSIT_AMOUNT / 2n;
      const expectedShares = await morphoVault.previewWithdraw(withdrawAmount);
      await morphoVault.connect(user1).withdraw(withdrawAmount, user1.address, user1.address);

      const sharesAfter = await morphoVault.balanceOf(user1.address);
      const dUSDAfter = await dUSD.balanceOf(user1.address);

      expect(sharesAfter).to.equal(shares - expectedShares);
      expect(dUSDAfter).to.equal(dUSDBefore + withdrawAmount);
    });

    it("should allow redeeming shares", async function () {
      // First deposit
      await dUSD.connect(user1).approve(await morphoVault.getAddress(), DEPOSIT_AMOUNT);
      await morphoVault.connect(user1).deposit(DEPOSIT_AMOUNT, user1.address);

      const shares = await morphoVault.balanceOf(user1.address);
      const dUSDBefore = await dUSD.balanceOf(user1.address);

      // Redeem half shares
      const redeemShares = shares / 2n;
      const expectedAssets = await morphoVault.previewRedeem(redeemShares);
      await morphoVault.connect(user1).redeem(redeemShares, user1.address, user1.address);

      const sharesAfter = await morphoVault.balanceOf(user1.address);
      const dUSDAfter = await dUSD.balanceOf(user1.address);

      expect(sharesAfter).to.equal(shares - redeemShares);
      expect(dUSDAfter).to.equal(dUSDBefore + expectedAssets);
    });

    it("should correctly preview operations", async function () {
      // Initial state - 1:1 conversion
      const depositPreview = await morphoVault.previewDeposit(DEPOSIT_AMOUNT);
      expect(depositPreview).to.equal(DEPOSIT_AMOUNT);

      const mintPreview = await morphoVault.previewMint(DEPOSIT_AMOUNT);
      expect(mintPreview).to.equal(DEPOSIT_AMOUNT);

      // After first deposit
      await dUSD.connect(user1).approve(await morphoVault.getAddress(), DEPOSIT_AMOUNT);
      await morphoVault.connect(user1).deposit(DEPOSIT_AMOUNT, user1.address);

      // Should still be 1:1 if no yield accrued
      const withdrawPreview = await morphoVault.previewWithdraw(DEPOSIT_AMOUNT / 2n);
      expect(withdrawPreview).to.be.closeTo(DEPOSIT_AMOUNT / 2n, ethers.parseUnits("1", 15));

      const redeemPreview = await morphoVault.previewRedeem(DEPOSIT_AMOUNT / 2n);
      expect(redeemPreview).to.be.closeTo(DEPOSIT_AMOUNT / 2n, ethers.parseUnits("1", 15));
    });

    it("should handle multiple users", async function () {
      // User 1 deposits
      await dUSD.connect(user1).approve(await morphoVault.getAddress(), DEPOSIT_AMOUNT);
      await morphoVault.connect(user1).deposit(DEPOSIT_AMOUNT, user1.address);

      // User 2 deposits double
      await dUSD.connect(user2).approve(await morphoVault.getAddress(), DEPOSIT_AMOUNT * 2n);
      await morphoVault.connect(user2).deposit(DEPOSIT_AMOUNT * 2n, user2.address);

      expect(await morphoVault.balanceOf(user1.address)).to.equal(DEPOSIT_AMOUNT);
      expect(await morphoVault.balanceOf(user2.address)).to.equal(DEPOSIT_AMOUNT * 2n);
      expect(await morphoVault.totalSupply()).to.equal(DEPOSIT_AMOUNT * 3n);
      expect(await morphoVault.totalAssets()).to.be.closeTo(DEPOSIT_AMOUNT * 3n, ethers.parseUnits("1", 15));

      // User 1 withdraws all
      await morphoVault.connect(user1).redeem(await morphoVault.balanceOf(user1.address), user1.address, user1.address);
      
      expect(await morphoVault.balanceOf(user1.address)).to.equal(0);
      expect(await morphoVault.totalSupply()).to.equal(DEPOSIT_AMOUNT * 2n);
    });

    it("should respect max limits", async function () {
      expect(await morphoVault.maxDeposit(user1.address)).to.equal(ethers.MaxUint256);
      expect(await morphoVault.maxMint(user1.address)).to.equal(ethers.MaxUint256);
      
      await dUSD.connect(user1).approve(await morphoVault.getAddress(), DEPOSIT_AMOUNT);
      await morphoVault.connect(user1).deposit(DEPOSIT_AMOUNT, user1.address);
      
      expect(await morphoVault.maxWithdraw(user1.address)).to.be.closeTo(DEPOSIT_AMOUNT, ethers.parseUnits("1", 15));
      expect(await morphoVault.maxRedeem(user1.address)).to.equal(DEPOSIT_AMOUNT);
    });

    it("should integrate with MockMorphoBlue correctly", async function () {
      const marketParams = {
        loanToken: await dUSD.getAddress(),
        collateralToken: ethers.ZeroAddress,
        oracle: ethers.ZeroAddress,
        irm: ethers.ZeroAddress,
        lltv: 0
      };

      const marketId = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(address,address,address,address,uint256)"],
        [[marketParams.loanToken, marketParams.collateralToken, marketParams.oracle, marketParams.irm, marketParams.lltv]]
      ));

      // Check initial position
      const positionBefore = await morpho.position(marketId, await morphoVault.getAddress());
      expect(positionBefore.supplyShares).to.equal(0);

      // Deposit through vault
      await dUSD.connect(user1).approve(await morphoVault.getAddress(), DEPOSIT_AMOUNT);
      await morphoVault.connect(user1).deposit(DEPOSIT_AMOUNT, user1.address);

      // Check position after
      const positionAfter = await morpho.position(marketId, await morphoVault.getAddress());
      expect(positionAfter.supplyShares).to.be.gt(0);

      // Check market totals
      const market = await morpho.market(marketId);
      expect(market.totalSupplyAssets).to.equal(ethers.parseUnits("10000", 18) + DEPOSIT_AMOUNT);
    });
  });
});