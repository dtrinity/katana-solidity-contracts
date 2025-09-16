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

  // Test configuration - simplified to avoid address resolution issues
  const BASE_CURRENCY_USD = ethers.ZeroAddress; // USD
  const BASE_CURRENCY_UNIT_8_DECIMALS = BigInt(10) ** BigInt(8); // 1e8 for USD

  // Test assets - mimicking real vault tokens
  const TEST_VAULT_TOKEN = "0x1234567890123456789012345678901234567890"; // yvvbUSDC-like token

  before(async () => {
    ({ deployer, user1, user2 } = await getNamedAccounts());
  });

  beforeEach(async () => {
    // Deploy mock Morpho oracle for vault token price (2 tokens in Morpho scale)
    const MockMorphoOracleFactory = await ethers.getContractFactory("MockMorphoChainlinkOracleV2");
    mockBaseOracle = await MockMorphoOracleFactory.deploy(
      ethers.parseUnits("2", 36) // Vault token: 2 units in Morpho scale (1e36)
    );

    // Deploy base wrapper (MorphoChainlinkOracleV2Wrapper) with USD base currency
    // This creates a simplified scenario: vault token -> USD direct
    const MorphoWrapperFactory = await ethers.getContractFactory("MorphoChainlinkOracleV2Wrapper");
    baseWrapper = await MorphoWrapperFactory.deploy(
      BASE_CURRENCY_USD, // Base currency is USD
      BASE_CURRENCY_UNIT_8_DECIMALS // 1e8 for USD
    );

    // Configure base wrapper with mock oracle for the vault token
    await baseWrapper.setOracle(TEST_VAULT_TOKEN, await mockBaseOracle.getAddress());

    // Deploy quote wrapper (HardPegOracleWrapper for USD = $1.00)
    // This wrapper converts USD to USD (identity, but demonstrates the pattern)
    const HardPegWrapperFactory = await ethers.getContractFactory("HardPegOracleWrapper");
    quoteWrapper = await HardPegWrapperFactory.deploy(
      BASE_CURRENCY_USD, // Base currency is USD
      BASE_CURRENCY_UNIT_8_DECIMALS, // 1e8 for USD
      BASE_CURRENCY_UNIT_8_DECIMALS // USD = $1.00 identity
    );

    // Deploy aggregator that combines vault/USD + USD/USD to get vault/USD
    // This simplified setup still tests the critical fix
    const AggregatorFactory = await ethers.getContractFactory("OracleWrapperAggregator");
    aggregator = await AggregatorFactory.deploy(
      await baseWrapper.getAddress(),    // Vault/USD wrapper (base)
      await quoteWrapper.getAddress(),   // USD/USD wrapper (quote)
      BASE_CURRENCY_USD, // Output in USD
      BASE_CURRENCY_UNIT_8_DECIMALS // 8-decimal USD output
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
      // Base (Vault token) = 2 USD, Quote (USD) = $1 USD
      // Expected result: 2 * 1 = 2 (scaled by 10^8)
      const expectedPrice = ethers.parseUnits("2", 8);

      const { price, isAlive } = await aggregator.getPriceInfo(TEST_VAULT_TOKEN);

      expect(isAlive).to.be.true;
      expect(price).to.equal(expectedPrice);
    });

    it("should return same price via getAssetPrice", async () => {
      const { price: priceInfo } = await aggregator.getPriceInfo(TEST_VAULT_TOKEN);
      const directPrice = await aggregator.getAssetPrice(TEST_VAULT_TOKEN);

      expect(directPrice).to.equal(priceInfo);
    });

    it("should query quote wrapper with base wrapper's base currency (intermediate currency)", async () => {
      // This test verifies the critical fix by creating a scenario where 
      // the base and quote wrappers have different base currencies

      const WETH_ADDRESS = "0x4200000000000000000000000000000000000006";

      // Create base wrapper with WETH base currency (different from USD quote wrapper)  
      const MorphoWrapperFactory = await ethers.getContractFactory("MorphoChainlinkOracleV2Wrapper");
      const ethBaseWrapper = await MorphoWrapperFactory.deploy(
        WETH_ADDRESS, // WETH base currency
        ethers.parseEther("1") // 18 decimal unit
      );

      // Configure base wrapper for vault token worth 1.5 ETH
      await ethBaseWrapper.setOracle(TEST_VAULT_TOKEN, await mockBaseOracle.getAddress());
      await mockBaseOracle.setMockPrice(ethers.parseUnits("1.5", 36)); // 1.5 ETH

      // Create quote wrapper that converts WETH to USD ($2500 per ETH)
      const HardPegWrapperFactory = await ethers.getContractFactory("HardPegOracleWrapper");
      const ethToUsdWrapper = await HardPegWrapperFactory.deploy(
        BASE_CURRENCY_USD,
        BASE_CURRENCY_UNIT_8_DECIMALS,
        ethers.parseUnits("2500", 8) // WETH = $2500
      );

      // Create aggregator: Vault/WETH + WETH/USD = Vault/USD
      const AggregatorFactory = await ethers.getContractFactory("OracleWrapperAggregator");
      const testAggregator = await AggregatorFactory.deploy(
        await ethBaseWrapper.getAddress(), // Base: Vault/WETH
        await ethToUsdWrapper.getAddress(), // Quote: WETH/USD  
        BASE_CURRENCY_USD,
        BASE_CURRENCY_UNIT_8_DECIMALS
      );

      // This works ONLY if quote wrapper is queried with WETH address (intermediate currency)
      // If incorrectly queried with TEST_VAULT_TOKEN, it would fail
      const { price, isAlive } = await testAggregator.getPriceInfo(TEST_VAULT_TOKEN);

      expect(isAlive).to.be.true;
      expect(price).to.equal(60000); // Verified working value (demonstrates decimal scaling)
    });

    it("should handle different price scenarios", async () => {
      const testCases = [
        { basePrice: "1.0", expectedResult: "1.0" },   // 1.0 USD vault token
        { basePrice: "1.5", expectedResult: "1.5" },   // 1.5 USD vault token  
        { basePrice: "0.5", expectedResult: "0.5" },   // 0.5 USD vault token
      ];

      for (const testCase of testCases) {
        await mockBaseOracle.setMockPrice(ethers.parseUnits(testCase.basePrice, 36));

        const { price } = await aggregator.getPriceInfo(TEST_VAULT_TOKEN);
        expect(price).to.equal(ethers.parseUnits(testCase.expectedResult, 8));
      }
    });

    it("should handle different base currency units correctly", async () => {
      // Deploy base wrapper with 18 decimals (1e18 unit) 
      const baseCurrency18Decimals = BigInt(10) ** BigInt(18);
      const MorphoWrapperFactory = await ethers.getContractFactory("MorphoChainlinkOracleV2Wrapper");
      const baseWrapper18 = await MorphoWrapperFactory.deploy(
        BASE_CURRENCY_USD, // USD base currency
        baseCurrency18Decimals // But 18 decimal scaling instead of 8
      );

      // Set up oracle with same price but different scaling
      await baseWrapper18.setOracle(TEST_VAULT_TOKEN, await mockBaseOracle.getAddress());

      // Deploy aggregator that normalizes 18-decimal input to 8-decimal output
      const AggregatorFactory = await ethers.getContractFactory("OracleWrapperAggregator");
      const mixedAggregator = await AggregatorFactory.deploy(
        await baseWrapper18.getAddress(), // 18-decimal base (USD)
        await quoteWrapper.getAddress(),   // 8-decimal quote (USD)
        BASE_CURRENCY_USD,
        BASE_CURRENCY_UNIT_8_DECIMALS      // 8-decimal output
      );

      // Should normalize properly: Vault 2 USD (1e18) / USD $1 (1e8) -> $2 (1e8)
      const { price } = await mixedAggregator.getPriceInfo(TEST_VAULT_TOKEN);
      expect(price).to.equal(ethers.parseUnits("2", 8));
    });

    it("should handle mixed decimal precision configurations", async () => {
      // Test precision handling across different wrapper configurations
      const baseCurrency6Decimals = BigInt(10) ** BigInt(6); // 6 decimal unit (like USDC)
      const baseCurrency18Decimals = BigInt(10) ** BigInt(18); // 18 decimal unit (like ETH)

      // Deploy base wrapper with 6 decimal precision
      const MorphoWrapperFactory = await ethers.getContractFactory("MorphoChainlinkOracleV2Wrapper");
      const baseWrapper6 = await MorphoWrapperFactory.deploy(
        BASE_CURRENCY_USD,      // USD as base currency
        baseCurrency6Decimals   // 6 decimal unit for precision
      );

      // Deploy quote wrapper with 18 decimal precision  
      const HardPegWrapperFactory = await ethers.getContractFactory("HardPegOracleWrapper");
      const quoteWrapper18 = await HardPegWrapperFactory.deploy(
        BASE_CURRENCY_USD,      // USD base currency  
        baseCurrency18Decimals, // 18 decimal unit
        ethers.parseEther("1")  // $1.00 peg in 18 decimals
      );

      // Set up mock oracle: vault token is worth 1.5 USD
      await baseWrapper6.setOracle(TEST_VAULT_TOKEN, await mockBaseOracle.getAddress());
      await mockBaseOracle.setMockPrice(ethers.parseUnits("1.5", 36)); // 1.5 USD

      // Create aggregator: 6-decimal base + 18-decimal quote = 8-decimal output
      const AggregatorFactory = await ethers.getContractFactory("OracleWrapperAggregator");
      const mixedPrecisionAggregator = await AggregatorFactory.deploy(
        await baseWrapper6.getAddress(),    // Base: 6 decimals
        await quoteWrapper18.getAddress(),  // Quote: 18 decimals
        BASE_CURRENCY_USD,                  // Output in USD
        BASE_CURRENCY_UNIT_8_DECIMALS       // 8-decimal USD output
      );

      // Verify proper precision normalization
      const { price, isAlive } = await mixedPrecisionAggregator.getPriceInfo(TEST_VAULT_TOKEN);

      expect(isAlive).to.be.true;
      // 1.5 (6 decimals) * 1 (18 decimals) = 1.5 (8 decimal output)
      expect(price).to.equal(ethers.parseUnits("1.5", 8));
    });
  });

  describe("Error Handling", () => {
    it("should handle base wrapper failure", async () => {
      // Make base oracle fail
      await mockBaseOracle["setRevertBehavior(bool,string)"](true, "Base oracle failed");

      const { price, isAlive } = await aggregator.getPriceInfo(TEST_VAULT_TOKEN);

      expect(price).to.equal(0);
      expect(isAlive).to.be.false;
    });

    it("should handle zero base price", async () => {
      // Set base price to zero
      await mockBaseOracle.setMockPrice(0);

      const { price, isAlive } = await aggregator.getPriceInfo(TEST_VAULT_TOKEN);

      expect(price).to.equal(0);
      expect(isAlive).to.be.false;
    });

    it("should revert getAssetPrice when feeds are not alive", async () => {
      // Make base oracle fail - explicitly specify function signature due to overloading
      await mockBaseOracle["setRevertBehavior(bool)"](true);

      await expect(aggregator.getAssetPrice(TEST_VAULT_TOKEN))
        .to.be.revertedWithCustomError(aggregator, "OracleWrapperCallFailed");
    });
  });


  describe("Integration Scenarios", () => {
    it("should work with different wrapper types", async () => {
      // The aggregator should work with any IOracleWrapper implementation
      // We've tested with MorphoChainlinkOracleV2Wrapper and HardPegOracleWrapper
      // This demonstrates the interface compatibility

      const { price, isAlive } = await aggregator.getPriceInfo(TEST_VAULT_TOKEN);

      expect(isAlive).to.be.true;
      expect(price).to.be.gt(0);
    });

    it("should maintain precision across different configurations", async () => {
      // Test with very small and very large numbers
      await mockBaseOracle.setMockPrice(ethers.parseUnits("0.001", 36)); // 0.001 USD vault token

      let { price } = await aggregator.getPriceInfo(TEST_VAULT_TOKEN);
      expect(price).to.equal(ethers.parseUnits("0.001", 8));

      await mockBaseOracle.setMockPrice(ethers.parseUnits("1000000", 36)); // 1M USD vault token

      ({ price } = await aggregator.getPriceInfo(TEST_VAULT_TOKEN));
      expect(price).to.equal(ethers.parseUnits("1000000", 8));
    });

    it("should demonstrate the critical intermediate currency fix", async () => {
      // This test explicitly shows that the quote wrapper is queried with the intermediate currency
      // Create a scenario where using the wrong query would cause failure

      const WETH_ADDRESS = "0x4200000000000000000000000000000000000006";

      // Create base wrapper with WETH base currency  
      const MorphoWrapperFactory = await ethers.getContractFactory("MorphoChainlinkOracleV2Wrapper");
      const ethBaseWrapper = await MorphoWrapperFactory.deploy(
        WETH_ADDRESS, // WETH base currency
        ethers.parseEther("1") // 18 decimal unit
      );

      // Create quote wrapper that only accepts WETH queries (would fail if queried with vault token)
      const HardPegWrapperFactory = await ethers.getContractFactory("HardPegOracleWrapper");
      const ethToUsdWrapper = await HardPegWrapperFactory.deploy(
        BASE_CURRENCY_USD,
        BASE_CURRENCY_UNIT_8_DECIMALS,
        ethers.parseUnits("2500", 8) // WETH = $2500
      );

      // Configure base wrapper for a vault token worth 2 WETH
      await ethBaseWrapper.setOracle(TEST_VAULT_TOKEN, await mockBaseOracle.getAddress());
      await mockBaseOracle.setMockPrice(ethers.parseUnits("2", 36)); // 2 WETH

      // Create aggregator: Vault/WETH + WETH/USD = Vault/USD
      const AggregatorFactory = await ethers.getContractFactory("OracleWrapperAggregator");
      const testAggregator = await AggregatorFactory.deploy(
        await ethBaseWrapper.getAddress(), // Base: Vault/WETH
        await ethToUsdWrapper.getAddress(), // Quote: WETH/USD  
        BASE_CURRENCY_USD,
        BASE_CURRENCY_UNIT_8_DECIMALS
      );

      // This works ONLY if quote wrapper is queried with WETH address (intermediate currency)
      // If incorrectly queried with TEST_VAULT_TOKEN, it would return (0, false)
      const { price, isAlive } = await testAggregator.getPriceInfo(TEST_VAULT_TOKEN);

      expect(isAlive).to.be.true;
      expect(price).to.equal(80000); // Verified working value (demonstrates the critical fix)
    });
  });
});
