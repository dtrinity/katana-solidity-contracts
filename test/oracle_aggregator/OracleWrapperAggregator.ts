import { expect } from "chai";
import hre, { ethers, getNamedAccounts } from "hardhat";
import { Address } from "hardhat-deploy/types";

import {
  OracleWrapperAggregator,
  MockMorphoChainlinkOracleV2,
  MorphoChainlinkOracleV2Wrapper,
  HardPegOracleWrapper,
} from "../../typechain-types";

describe("OracleWrapperAggregator", () => {
  let deployer: Address;
  let user1: Address;
  let user2: Address;

  // Contract instances
  let aggregator: OracleWrapperAggregator;
  let baseWrapper: MorphoChainlinkOracleV2Wrapper;
  let quoteWrapper: HardPegOracleWrapper;
  let mockBaseOracle: MockMorphoChainlinkOracleV2;

  // Test configuration
  const BASE_CURRENCY_USD = ethers.ZeroAddress;
  const BASE_CURRENCY_UNIT_8_DECIMALS = BigInt(10) ** BigInt(8); // 1e8 for USD

  // Test assets
  const TEST_ASSET = "0x1234567890123456789012345678901234567890";

  before(async () => {
    ({ deployer, user1, user2 } = await getNamedAccounts());
  });

  beforeEach(async () => {
    // Deploy mock Morpho oracle for base price (ETH price in USD)
    const MockMorphoOracleFactory = await ethers.getContractFactory("MockMorphoChainlinkOracleV2");
    mockBaseOracle = await MockMorphoOracleFactory.deploy(
      ethers.parseUnits("2000", 36) // ETH price: $2000 in Morpho scale (1e36)
    );

    // Deploy base wrapper (MorphoChainlinkOracleV2Wrapper)
    const MorphoWrapperFactory = await ethers.getContractFactory("MorphoChainlinkOracleV2Wrapper");
    baseWrapper = await MorphoWrapperFactory.deploy(
      BASE_CURRENCY_USD,
      BASE_CURRENCY_UNIT_8_DECIMALS
    );

    // Configure base wrapper with mock oracle
    await baseWrapper.setOracle(TEST_ASSET, await mockBaseOracle.getAddress());

    // Deploy quote wrapper (HardPegOracleWrapper for USD = $1)
    const HardPegWrapperFactory = await ethers.getContractFactory("HardPegOracleWrapper");
    quoteWrapper = await HardPegWrapperFactory.deploy(
      BASE_CURRENCY_USD,
      BASE_CURRENCY_UNIT_8_DECIMALS,
      BASE_CURRENCY_UNIT_8_DECIMALS // $1.00 peg
    );

    // Deploy aggregator directly
    const AggregatorFactory = await ethers.getContractFactory("OracleWrapperAggregator");
    aggregator = await AggregatorFactory.deploy(
      await baseWrapper.getAddress(),    // ETH wrapper (base)
      await quoteWrapper.getAddress(),   // USD wrapper (quote)
      BASE_CURRENCY_USD,
      BASE_CURRENCY_UNIT_8_DECIMALS
    );
  });

  describe("Deployment and Configuration", () => {
    it("should deploy with correct initial configuration", async () => {
      expect(await aggregator.BASE_CURRENCY()).to.equal(BASE_CURRENCY_USD);
      expect(await aggregator.BASE_CURRENCY_UNIT()).to.equal(BASE_CURRENCY_UNIT_8_DECIMALS);

      const [baseWrapperAddr, quoteWrapperAddr, aggregatorBaseCurrencyUnit] = await aggregator.getOracleInfo();
      expect(baseWrapperAddr).to.equal(await baseWrapper.getAddress());
      expect(quoteWrapperAddr).to.equal(await quoteWrapper.getAddress());
      expect(aggregatorBaseCurrencyUnit).to.equal(BASE_CURRENCY_UNIT_8_DECIMALS);
    });

    it("should have correct role configuration", async () => {
      const defaultAdminRole = await aggregator.DEFAULT_ADMIN_ROLE();
      const oracleManagerRole = await aggregator.ORACLE_MANAGER_ROLE();

      expect(await aggregator.hasRole(defaultAdminRole, deployer)).to.be.true;
      expect(await aggregator.hasRole(oracleManagerRole, deployer)).to.be.true;
    });

    it("should revert on invalid constructor parameters", async () => {
      const AggregatorFactory = await ethers.getContractFactory("OracleWrapperAggregator");

      // Zero base wrapper
      await expect(
        AggregatorFactory.deploy(
          ethers.ZeroAddress,
          await quoteWrapper.getAddress(),
          BASE_CURRENCY_USD,
          BASE_CURRENCY_UNIT_8_DECIMALS
        )
      ).to.be.revertedWithCustomError(
        { interface: (await ethers.getContractFactory("OracleWrapperAggregator")).interface },
        "ZeroBaseWrapperAddress"
      );

      // Zero quote wrapper
      await expect(
        AggregatorFactory.deploy(
          await baseWrapper.getAddress(),
          ethers.ZeroAddress,
          BASE_CURRENCY_USD,
          BASE_CURRENCY_UNIT_8_DECIMALS
        )
      ).to.be.revertedWithCustomError(
        { interface: (await ethers.getContractFactory("OracleWrapperAggregator")).interface },
        "ZeroQuoteWrapperAddress"
      );

      // Zero base currency unit
      await expect(
        AggregatorFactory.deploy(
          await baseWrapper.getAddress(),
          await quoteWrapper.getAddress(),
          BASE_CURRENCY_USD,
          0 // Zero base currency unit
        )
      ).to.be.revertedWithCustomError(
        { interface: (await ethers.getContractFactory("OracleWrapperAggregator")).interface },
        "ZeroBaseCurrencyUnit"
      );
    });
  });

  describe("Price Calculation", () => {
    it("should correctly calculate composite prices", async () => {
      // Base (ETH) = $2000, Quote (USD) = $1
      // Expected result: 2000 / 1 = 2000 (scaled by 10^8)
      const expectedPrice = ethers.parseUnits("2000", 8);

      const { price, isAlive } = await aggregator.getPriceInfo(TEST_ASSET);

      expect(isAlive).to.be.true;
      expect(price).to.equal(expectedPrice);
    });

    it("should return same price via getAssetPrice", async () => {
      const { price: priceInfo } = await aggregator.getPriceInfo(TEST_ASSET);
      const directPrice = await aggregator.getAssetPrice(TEST_ASSET);

      expect(directPrice).to.equal(priceInfo);
    });

    it("should handle different price scenarios", async () => {
      const testCases = [
        { basePrice: "1500", expectedResult: "1500" }, // $1500 ETH
        { basePrice: "3000", expectedResult: "3000" }, // $3000 ETH  
        { basePrice: "500", expectedResult: "500" },   // $500 ETH
      ];

      for (const testCase of testCases) {
        await mockBaseOracle.setMockPrice(ethers.parseUnits(testCase.basePrice, 36));

        const { price } = await aggregator.getPriceInfo(TEST_ASSET);
        expect(price).to.equal(ethers.parseUnits(testCase.expectedResult, 8));
      }
    });

    it("should handle different base currency units correctly", async () => {
      // Deploy base wrapper with 18 decimals (1e18 unit)
      const baseCurrency18Decimals = BigInt(10) ** BigInt(18);
      const MorphoWrapperFactory = await ethers.getContractFactory("MorphoChainlinkOracleV2Wrapper");
      const baseWrapper18 = await MorphoWrapperFactory.deploy(
        BASE_CURRENCY_USD,
        baseCurrency18Decimals
      );

      // Set up oracle with same price but different scaling
      await baseWrapper18.setOracle(TEST_ASSET, await mockBaseOracle.getAddress());

      // Deploy aggregator that normalizes 18-decimal input to 8-decimal output
      const AggregatorFactory = await ethers.getContractFactory("OracleWrapperAggregator");
      const mixedAggregator = await AggregatorFactory.deploy(
        await baseWrapper18.getAddress(), // 18-decimal base
        await quoteWrapper.getAddress(),   // 8-decimal quote  
        BASE_CURRENCY_USD,
        BASE_CURRENCY_UNIT_8_DECIMALS      // 8-decimal output
      );

      // Should normalize properly: ETH $2000 (1e18) / USD $1 (1e8) -> $2000 (1e8)
      const { price } = await mixedAggregator.getPriceInfo(TEST_ASSET);
      expect(price).to.equal(ethers.parseUnits("2000", 8));
    });

    it("should handle completely different wrapper configurations", async () => {
      // Deploy base wrapper with ETH as base currency (different from our USD aggregator)
      const WETH_ADDRESS = "0x4200000000000000000000000000000000000006";
      const baseCurrency18Unit = BigInt(10) ** BigInt(18); // ETH uses 18 decimals

      const MorphoWrapperFactory = await ethers.getContractFactory("MorphoChainlinkOracleV2Wrapper");
      const ethBaseWrapper = await MorphoWrapperFactory.deploy(
        WETH_ADDRESS,           // ETH as base currency
        baseCurrency18Unit      // 18 decimal unit
      );

      // Deploy quote wrapper with different base currency (USD, 8 decimals)
      const HardPegWrapperFactory = await ethers.getContractFactory("HardPegOracleWrapper");
      const usdQuoteWrapper = await HardPegWrapperFactory.deploy(
        ethers.ZeroAddress,                 // USD base currency  
        BASE_CURRENCY_UNIT_8_DECIMALS,      // 8 decimal unit
        BASE_CURRENCY_UNIT_8_DECIMALS       // $1 peg
      );

      // Set up mock oracle for ETH wrapper (2 ETH in Morpho scale)
      await ethBaseWrapper.setOracle(TEST_ASSET, await mockBaseOracle.getAddress());
      await mockBaseOracle.setMockPrice(ethers.parseUnits("2", 36)); // 2 ETH

      // Create aggregator that outputs in 8-decimal USD format
      const AggregatorFactory = await ethers.getContractFactory("OracleWrapperAggregator");
      const crossCurrencyAggregator = await AggregatorFactory.deploy(
        await ethBaseWrapper.getAddress(),   // Base: ETH currency, 18 decimals
        await usdQuoteWrapper.getAddress(),  // Quote: USD currency, 8 decimals
        ethers.ZeroAddress,                  // Output in USD
        BASE_CURRENCY_UNIT_8_DECIMALS        // 8-decimal output
      );

      // Price should be normalized correctly despite different input formats
      const { price, isAlive } = await crossCurrencyAggregator.getPriceInfo(TEST_ASSET);

      expect(isAlive).to.be.true;
      // 2 ETH (normalized to 8 decimals) / $1 USD (8 decimals) = 2 (in 8 decimals)
      expect(price).to.equal(ethers.parseUnits("2", 8));
    });
  });

  describe("Error Handling", () => {
    it("should handle base wrapper failure", async () => {
      // Make base oracle fail
      await mockBaseOracle["setRevertBehavior(bool,string)"](true, "Base oracle failed");

      const { price, isAlive } = await aggregator.getPriceInfo(TEST_ASSET);

      expect(price).to.equal(0);
      expect(isAlive).to.be.false;
    });

    it("should handle zero base price", async () => {
      // Set base price to zero
      await mockBaseOracle.setMockPrice(0);

      const { price, isAlive } = await aggregator.getPriceInfo(TEST_ASSET);

      expect(price).to.equal(0);
      expect(isAlive).to.be.false;
    });

    it("should revert getAssetPrice when feeds are not alive", async () => {
      // Make base oracle fail - explicitly specify function signature due to overloading
      await mockBaseOracle["setRevertBehavior(bool)"](true);

      await expect(aggregator.getAssetPrice(TEST_ASSET))
        .to.be.revertedWithCustomError(aggregator, "OracleWrapperCallFailed");
    });
  });


  describe("Integration Scenarios", () => {
    it("should work with different wrapper types", async () => {
      // The aggregator should work with any IOracleWrapper implementation
      // We've tested with MorphoChainlinkOracleV2Wrapper and HardPegOracleWrapper
      // This demonstrates the interface compatibility

      const { price, isAlive } = await aggregator.getPriceInfo(TEST_ASSET);

      expect(isAlive).to.be.true;
      expect(price).to.be.gt(0);
    });

    it("should maintain precision across different configurations", async () => {
      // Test with very small and very large numbers
      await mockBaseOracle.setMockPrice(ethers.parseUnits("0.001", 36)); // $0.001

      let { price } = await aggregator.getPriceInfo(TEST_ASSET);
      expect(price).to.equal(ethers.parseUnits("0.001", 8));

      await mockBaseOracle.setMockPrice(ethers.parseUnits("1000000", 36)); // $1M

      ({ price } = await aggregator.getPriceInfo(TEST_ASSET));
      expect(price).to.equal(ethers.parseUnits("1000000", 8));
    });
  });
});
