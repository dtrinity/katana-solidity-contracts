import { expect } from "chai";
import hre, { ethers, getNamedAccounts } from "hardhat";
import { Address } from "hardhat-deploy/types";

import {
  MorphoChainlinkOracleV2Wrapper,
  MorphoChainlinkOracleV2WrapperWithThresholding,
  MockMorphoChainlinkOracleV2,
} from "../../typechain-types";

describe("MorphoChainlinkOracleV2Wrapper", () => {
  let deployer: Address;
  let user1: Address;
  let user2: Address;

  // Contract instances
  let morphoWrapper: MorphoChainlinkOracleV2Wrapper;
  let morphoWrapperWithThresholding: MorphoChainlinkOracleV2WrapperWithThresholding;
  let mockMorphoOracle1: MockMorphoChainlinkOracleV2;
  let mockMorphoOracle2: MockMorphoChainlinkOracleV2;

  // Test configuration
  const BASE_CURRENCY_USD = ethers.ZeroAddress;
  const BASE_CURRENCY_UNIT_8_DECIMALS = BigInt(10) ** BigInt(8); // 1e8 for USD

  // Test assets
  const WETH_ADDRESS = "0x1234567890123456789012345678901234567890";
  const WBTC_ADDRESS = "0x2345678901234567890123456789012345678901";
  const NON_EXISTENT_ASSET = "0x000000000000000000000000000000000000dEaD";

  before(async () => {
    ({ deployer, user1, user2 } = await getNamedAccounts());
  });

  beforeEach(async () => {
    // Deploy mock Morpho oracles with different initial prices
    const MockMorphoOracleFactory = await ethers.getContractFactory("MockMorphoChainlinkOracleV2");

    // WETH price: 1500 USD (1500 * 1e36)
    mockMorphoOracle1 = await MockMorphoOracleFactory.deploy(
      ethers.parseUnits("1500", 36)
    );

    // WBTC price: 30000 USD (30000 * 1e36)
    mockMorphoOracle2 = await MockMorphoOracleFactory.deploy(
      ethers.parseUnits("30000", 36)
    );

    // Deploy wrappers
    const MorphoWrapperFactory = await ethers.getContractFactory("MorphoChainlinkOracleV2Wrapper");
    morphoWrapper = await MorphoWrapperFactory.deploy(
      BASE_CURRENCY_USD,
      BASE_CURRENCY_UNIT_8_DECIMALS
    );

    const MorphoWrapperWithThresholdingFactory = await ethers.getContractFactory("MorphoChainlinkOracleV2WrapperWithThresholding");
    morphoWrapperWithThresholding = await MorphoWrapperWithThresholdingFactory.deploy(
      BASE_CURRENCY_USD,
      BASE_CURRENCY_UNIT_8_DECIMALS
    );

    // Grant Oracle Manager role to deployer for testing
    const oracleManagerRole = await morphoWrapper.ORACLE_MANAGER_ROLE();
    await morphoWrapper.grantRole(oracleManagerRole, deployer);
    await morphoWrapperWithThresholding.grantRole(oracleManagerRole, deployer);

    // Set up oracles for test assets
    await morphoWrapper.setOracle(WETH_ADDRESS, await mockMorphoOracle1.getAddress());
    await morphoWrapper.setOracle(WBTC_ADDRESS, await mockMorphoOracle2.getAddress());

    await morphoWrapperWithThresholding.setOracle(WETH_ADDRESS, await mockMorphoOracle1.getAddress());
    await morphoWrapperWithThresholding.setOracle(WBTC_ADDRESS, await mockMorphoOracle2.getAddress());
  });

  describe("Deployment and Configuration", () => {
    it("should deploy with correct initial configuration", async () => {
      expect(await morphoWrapper.BASE_CURRENCY()).to.equal(BASE_CURRENCY_USD);
      expect(await morphoWrapper.BASE_CURRENCY_UNIT()).to.equal(BASE_CURRENCY_UNIT_8_DECIMALS);
    });

    it("should have correct role configuration", async () => {
      const defaultAdminRole = await morphoWrapper.DEFAULT_ADMIN_ROLE();
      const oracleManagerRole = await morphoWrapper.ORACLE_MANAGER_ROLE();

      expect(await morphoWrapper.hasRole(defaultAdminRole, deployer)).to.be.true;
      expect(await morphoWrapper.hasRole(oracleManagerRole, deployer)).to.be.true;
    });
  });

  describe("Oracle Management", () => {
    it("should allow setting oracles for assets", async () => {
      const testAsset = "0x3456789012345678901234567890123456789012";
      const testOracle = await mockMorphoOracle1.getAddress();

      await expect(morphoWrapper.setOracle(testAsset, testOracle))
        .to.emit(morphoWrapper, "OracleSet")
        .withArgs(testAsset, testOracle);

      expect(await morphoWrapper.assetToOracle(testAsset)).to.equal(testOracle);
    });

    it("should allow removing oracles for assets", async () => {
      await expect(morphoWrapper.removeOracle(WETH_ADDRESS))
        .to.emit(morphoWrapper, "OracleRemoved")
        .withArgs(WETH_ADDRESS);

      expect(await morphoWrapper.assetToOracle(WETH_ADDRESS)).to.equal(ethers.ZeroAddress);
    });

    it("should revert when non-ORACLE_MANAGER tries to set oracle", async () => {
      const testAsset = "0x3456789012345678901234567890123456789012";
      const testOracle = await mockMorphoOracle1.getAddress();
      const unauthorizedSigner = await ethers.getSigner(user2);
      const oracleManagerRole = await morphoWrapper.ORACLE_MANAGER_ROLE();

      await expect(
        morphoWrapper.connect(unauthorizedSigner).setOracle(testAsset, testOracle)
      )
        .to.be.revertedWithCustomError(morphoWrapper, "AccessControlUnauthorizedAccount")
        .withArgs(user2, oracleManagerRole);
    });
  });

  describe("Price Retrieval", () => {
    it("should correctly convert Morpho prices to base currency units", async () => {
      // WETH: 1500 USD * 1e36 -> should convert to 1500 * 1e8
      const { price: wethPrice, isAlive: wethAlive } = await morphoWrapper.getPriceInfo(WETH_ADDRESS);

      expect(wethAlive).to.be.true;
      expect(wethPrice).to.equal(ethers.parseUnits("1500", 8)); // 1500 * 1e8

      // WBTC: 30000 USD * 1e36 -> should convert to 30000 * 1e8
      const { price: wbtcPrice, isAlive: wbtcAlive } = await morphoWrapper.getPriceInfo(WBTC_ADDRESS);

      expect(wbtcAlive).to.be.true;
      expect(wbtcPrice).to.equal(ethers.parseUnits("30000", 8)); // 30000 * 1e8
    });

    it("should return same price via getAssetPrice and getPriceInfo", async () => {
      const { price: priceInfo } = await morphoWrapper.getPriceInfo(WETH_ADDRESS);
      const directPrice = await morphoWrapper.getAssetPrice(WETH_ADDRESS);

      expect(directPrice).to.equal(priceInfo);
    });

    it("should handle zero prices correctly", async () => {
      // Set mock oracle to return zero price
      await mockMorphoOracle1.setMockPrice(0);

      const { price, isAlive } = await morphoWrapper.getPriceInfo(WETH_ADDRESS);

      expect(price).to.equal(0);
      expect(isAlive).to.be.false;
    });

    it("should handle oracle failures gracefully", async () => {
      // Configure mock oracle to revert
      await mockMorphoOracle1["setRevertBehavior(bool,string)"](true, "Simulated oracle failure");

      const { price, isAlive } = await morphoWrapper.getPriceInfo(WETH_ADDRESS);

      expect(price).to.equal(0);
      expect(isAlive).to.be.false;
    });

    it("should revert when getting price for non-existent asset", async () => {
      await expect(morphoWrapper.getPriceInfo(NON_EXISTENT_ASSET))
        .to.be.revertedWithCustomError(morphoWrapper, "OracleNotSet")
        .withArgs(NON_EXISTENT_ASSET);

      await expect(morphoWrapper.getAssetPrice(NON_EXISTENT_ASSET))
        .to.be.revertedWithCustomError(morphoWrapper, "OracleNotSet")
        .withArgs(NON_EXISTENT_ASSET);
    });

    it("should revert when getAssetPrice called on failed oracle", async () => {
      // Configure mock oracle to revert
      await mockMorphoOracle1["setRevertBehavior(bool)"](true);

      await expect(morphoWrapper.getAssetPrice(WETH_ADDRESS))
        .to.be.revertedWithCustomError(morphoWrapper, "OraclePriceError");
    });
  });

  describe("Price Scale Conversion", () => {
    it("should correctly handle different price magnitudes", async () => {
      const testPrices = [
        { morphoPrice: ethers.parseUnits("1", 36), expectedBase: ethers.parseUnits("1", 8) },
        { morphoPrice: ethers.parseUnits("0.001", 36), expectedBase: ethers.parseUnits("0.001", 8) },
        { morphoPrice: ethers.parseUnits("1000000", 36), expectedBase: ethers.parseUnits("1000000", 8) },
      ];

      for (const testCase of testPrices) {
        await mockMorphoOracle1.setMockPrice(testCase.morphoPrice);

        const { price } = await morphoWrapper.getPriceInfo(WETH_ADDRESS);
        expect(price).to.equal(testCase.expectedBase);
      }
    });

    it("should handle edge case of maximum uint256 price", async () => {
      // Set a very large price that shouldn't overflow
      const largePrice = ethers.parseUnits("1000000000", 36); // 1B * 1e36
      await mockMorphoOracle1.setMockPrice(largePrice);

      const { price, isAlive } = await morphoWrapper.getPriceInfo(WETH_ADDRESS);

      expect(isAlive).to.be.true;
      expect(price).to.equal(ethers.parseUnits("1000000000", 8)); // 1B * 1e8
    });
  });

  describe("MorphoChainlinkOracleV2WrapperWithThresholding", () => {
    it("should apply thresholding when configured", async () => {
      const lowerThreshold = ethers.parseUnits("1000", 8); // $1000 threshold
      const fixedPrice = ethers.parseUnits("1200", 8);     // $1200 fixed price

      // Set threshold configuration
      await morphoWrapperWithThresholding.setThresholdConfig(
        WETH_ADDRESS,
        lowerThreshold,
        fixedPrice
      );

      // Current price is $1500, which is above threshold, so should return fixed price
      const { price, isAlive } = await morphoWrapperWithThresholding.getPriceInfo(WETH_ADDRESS);

      expect(isAlive).to.be.true;
      expect(price).to.equal(fixedPrice);
    });

    it("should not apply thresholding when price is below threshold", async () => {
      const lowerThreshold = ethers.parseUnits("2000", 8); // $2000 threshold
      const fixedPrice = ethers.parseUnits("1800", 8);     // $1800 fixed price

      // Set threshold configuration
      await morphoWrapperWithThresholding.setThresholdConfig(
        WETH_ADDRESS,
        lowerThreshold,
        fixedPrice
      );

      // Current price is $1500, which is below $2000 threshold, so should return original price
      const { price, isAlive } = await morphoWrapperWithThresholding.getPriceInfo(WETH_ADDRESS);

      expect(isAlive).to.be.true;
      expect(price).to.equal(ethers.parseUnits("1500", 8)); // Original price
    });

    it("should allow removing threshold configuration", async () => {
      // Set threshold configuration first
      await morphoWrapperWithThresholding.setThresholdConfig(
        WETH_ADDRESS,
        ethers.parseUnits("1000", 8),
        ethers.parseUnits("1200", 8)
      );

      // Remove threshold configuration
      await expect(morphoWrapperWithThresholding.removeThresholdConfig(WETH_ADDRESS))
        .to.emit(morphoWrapperWithThresholding, "ThresholdConfigRemoved")
        .withArgs(WETH_ADDRESS);

      // Should now return original price without thresholding
      const { price } = await morphoWrapperWithThresholding.getPriceInfo(WETH_ADDRESS);
      expect(price).to.equal(ethers.parseUnits("1500", 8)); // Original price
    });

    it("should not apply thresholding when oracle fails", async () => {
      // Configure threshold
      await morphoWrapperWithThresholding.setThresholdConfig(
        WETH_ADDRESS,
        ethers.parseUnits("1000", 8),
        ethers.parseUnits("1200", 8)
      );

      // Make oracle fail
      await mockMorphoOracle1["setRevertBehavior(bool)"](true);

      const { price, isAlive } = await morphoWrapperWithThresholding.getPriceInfo(WETH_ADDRESS);

      expect(price).to.equal(0);
      expect(isAlive).to.be.false;
    });
  });

  describe("Integration Scenarios", () => {
    it("should handle multiple assets with different oracle configurations", async () => {
      // Test that each asset uses its own oracle correctly
      const wethInfo = await morphoWrapper.getPriceInfo(WETH_ADDRESS);
      const wbtcInfo = await morphoWrapper.getPriceInfo(WBTC_ADDRESS);

      expect(wethInfo.price).to.equal(ethers.parseUnits("1500", 8));
      expect(wbtcInfo.price).to.equal(ethers.parseUnits("30000", 8));
      expect(wethInfo.isAlive).to.be.true;
      expect(wbtcInfo.isAlive).to.be.true;
    });

    it("should handle partial oracle failures correctly", async () => {
      // Make WETH oracle fail but keep WBTC working
      await mockMorphoOracle1["setRevertBehavior(bool)"](true);

      const wethInfo = await morphoWrapper.getPriceInfo(WETH_ADDRESS);
      const wbtcInfo = await morphoWrapper.getPriceInfo(WBTC_ADDRESS);

      expect(wethInfo.isAlive).to.be.false;
      expect(wbtcInfo.isAlive).to.be.true;
      expect(wbtcInfo.price).to.equal(ethers.parseUnits("30000", 8));
    });

    it("should handle oracle replacement correctly", async () => {
      // Deploy a new mock oracle with different price
      const MockMorphoOracleFactory = await ethers.getContractFactory("MockMorphoChainlinkOracleV2");
      const newMockOracle = await MockMorphoOracleFactory.deploy(
        ethers.parseUnits("2000", 36) // $2000
      );

      // Replace the oracle for WETH
      await morphoWrapper.setOracle(WETH_ADDRESS, await newMockOracle.getAddress());

      // Should now return the new price
      const { price, isAlive } = await morphoWrapper.getPriceInfo(WETH_ADDRESS);

      expect(isAlive).to.be.true;
      expect(price).to.equal(ethers.parseUnits("2000", 8));
    });
  });
});
