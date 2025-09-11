import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

import { getConfig } from "../../config/config";

/**
 * Get asset symbol from token addresses configuration
 *
 * @param assetAddress The address of the asset to look up
 * @param config The network configuration containing token addresses
 * @returns The symbol for the asset or a truncated address if not found
 */
function getAssetSymbol(assetAddress: string, config: any): string {
  const tokenAddresses = config.tokenAddresses || {};

  for (const [symbol, address] of Object.entries(tokenAddresses)) {
    if (address === assetAddress) {
      return symbol;
    }
  }

  // Fallback to address suffix if not found
  return `0x${assetAddress.slice(-8)}`;
}

/**
 * Performs comprehensive sanity checks on oracle wrapper aggregators
 * Verifies both the aggregated result and individual source feeds
 *
 * @param hre The Hardhat runtime environment
 * @param aggregator The deployed OracleWrapperAggregator contract instance
 * @param groupConfig Configuration object for the aggregator group
 * @param groupConfig.baseWrapperDeploymentId Deployment ID of the base wrapper
 * @param groupConfig.quoteWrapperDeploymentId Deployment ID of the quote wrapper
 * @param groupConfig.baseCurrencyUnit Base currency unit for calculations
 * @param groupConfig.assets Array of asset addresses to test
 * @param baseWrapperAddress Resolved address of the base wrapper
 * @param quoteWrapperAddress Resolved address of the quote wrapper
 * @param config The network configuration
 * @param groupName Display name for the aggregator group
 * @returns Promise that resolves when all sanity checks pass or rejects on failure
 */
async function performGroupSanityChecks(
  hre: HardhatRuntimeEnvironment,
  aggregator: any,
  groupConfig: {
    baseWrapperDeploymentId: string;
    quoteWrapperDeploymentId: string;
    baseCurrencyUnit: bigint;
    assets: string[];
  },
  baseWrapperAddress: string,
  quoteWrapperAddress: string,
  config: any,
  groupName: string
): Promise<void> {
  console.log(`    🔍 Performing comprehensive sanity checks for ${groupName}...`);

  // Test each asset in the group
  for (const assetAddress of groupConfig.assets) {
    const assetName = getAssetSymbol(assetAddress, config);
    console.log(`\n    🧪 Testing ${assetName} (${assetAddress}):`);

    try {
      // 1. Get aggregated result
      const { price: aggregatedPrice, isAlive } = await aggregator.getPriceInfo(assetAddress);
      const normalizedAggregatedPrice = Number(aggregatedPrice) / Number(groupConfig.baseCurrencyUnit);

      console.log(`       📊 Aggregated Result: ${aggregatedPrice} (${normalizedAggregatedPrice.toFixed(8)} USD)`);
      console.log(`       🟢 Is Alive: ${isAlive}`);

      if (!isAlive || aggregatedPrice === 0n) {
        throw new Error(`Aggregator returned invalid price (${aggregatedPrice}) or not alive (${isAlive})`);
      }

      // 2. Check base wrapper (e.g., Morpho wrapper providing asset/stablecoin price)
      console.log(`       🔍 Base Feed Check (${groupConfig.baseWrapperDeploymentId}):`);
      const WRAPPER_ABI = [
        "function getPriceInfo(address) view returns (uint256, bool)",
        "function BASE_CURRENCY() view returns (address)",
        "function BASE_CURRENCY_UNIT() view returns (uint256)",
      ];
      const baseWrapper = await hre.ethers.getContractAt(WRAPPER_ABI, baseWrapperAddress);

      const [basePrice, baseIsAlive] = await baseWrapper.getPriceInfo(assetAddress);
      const baseUnit = await baseWrapper.BASE_CURRENCY_UNIT();
      const baseCurrency = await baseWrapper.BASE_CURRENCY();
      const normalizedBasePrice = Number(basePrice) / Number(baseUnit);

      console.log(`         Raw Price: ${basePrice}`);
      console.log(`         Unit: ${baseUnit}`);
      console.log(`         Normalized: ${normalizedBasePrice.toFixed(8)} ${getAssetSymbol(baseCurrency, config)}`);
      console.log(`         Is Alive: ${baseIsAlive}`);

      if (!baseIsAlive || basePrice === 0n) {
        throw new Error(`Base wrapper returned invalid price or not alive`);
      }

      // 3. Check quote wrapper (e.g., Redstone wrapper providing stablecoin/USD price)
      console.log(`       🔍 Quote Feed Check (${groupConfig.quoteWrapperDeploymentId}):`);
      const quoteWrapper = await hre.ethers.getContractAt(WRAPPER_ABI, quoteWrapperAddress);

      // CRITICAL: Get the intermediate currency from the base wrapper's base currency
      // This is what we need to query the quote wrapper with
      // Example: yvvbUSDT/USDC base wrapper has BASE_CURRENCY = USDC
      // So we query quote wrapper with USDC to get USDC/USD
      const intermediateCurrency = await baseWrapper.BASE_CURRENCY();

      const [quotePrice, quoteIsAlive] = await quoteWrapper.getPriceInfo(intermediateCurrency);
      const quoteUnit = await quoteWrapper.BASE_CURRENCY_UNIT();
      const quoteCurrency = await quoteWrapper.BASE_CURRENCY();
      const normalizedQuotePrice = Number(quotePrice) / Number(quoteUnit);

      const intermediateCurrencySymbol = getAssetSymbol(intermediateCurrency, config);
      const quoteCurrencySymbol = getAssetSymbol(quoteCurrency, config);

      console.log(`         Asset Queried: ${intermediateCurrencySymbol} (${intermediateCurrency})`);
      console.log(`         Raw Price: ${quotePrice}`);
      console.log(`         Unit: ${quoteUnit}`);
      console.log(`         Normalized: ${normalizedQuotePrice.toFixed(8)} ${quoteCurrencySymbol}`);
      console.log(`         Is Alive: ${quoteIsAlive}`);
      console.log(`         Flow: ${intermediateCurrencySymbol} → ${quoteCurrencySymbol}`);

      if (!quoteIsAlive || quotePrice === 0n) {
        throw new Error(`Quote wrapper returned invalid price or not alive`);
      }

      // 4. Calculate expected result manually and compare with aggregator
      // Expected calculation: (basePrice / baseUnit) / (quotePrice / quoteUnit) * baseCurrencyUnit
      const manualCalculation =
        (Number(basePrice) / Number(baseUnit) / (Number(quotePrice) / Number(quoteUnit))) * Number(groupConfig.baseCurrencyUnit);
      const calculationDifference = Math.abs(normalizedAggregatedPrice - manualCalculation);
      const calculationPercentDiff = (calculationDifference / manualCalculation) * 100;

      console.log(`       🧮 Manual Calculation: ${manualCalculation.toFixed(8)} USD`);
      console.log(`       📊 Difference: ${calculationDifference.toFixed(8)} USD (${calculationPercentDiff.toFixed(6)}%)`);

      if (calculationPercentDiff > 0.01) {
        // 0.01% tolerance for calculation accuracy
        throw new Error(`Aggregator calculation mismatch: ${calculationPercentDiff.toFixed(6)}% difference (>0.01%)`);
      }

      // 5. USD price range sanity check
      let expectedMinPrice: number;
      let expectedMaxPrice: number;

      if (assetName.includes("USD") || assetName.includes("USDC") || assetName.includes("USDT")) {
        // Stablecoin-based vault should be close to 1.0 USD
        expectedMinPrice = 0.8;
        expectedMaxPrice = 1.5;
      } else if (assetName.includes("ETH")) {
        // ETH-based vault - wide range due to ETH volatility
        expectedMinPrice = 500;
        expectedMaxPrice = 10000;
      } else {
        // Conservative range for unknown assets
        expectedMinPrice = 0.01;
        expectedMaxPrice = 100000;
      }

      if (normalizedAggregatedPrice < expectedMinPrice || normalizedAggregatedPrice > expectedMaxPrice) {
        throw new Error(
          `USD price outside expected range: ${normalizedAggregatedPrice.toFixed(8)} not in [${expectedMinPrice}, ${expectedMaxPrice}]`
        );
      }

      console.log(
        `       ✅ ${assetName}: ${normalizedAggregatedPrice.toFixed(8)} USD (range: [${expectedMinPrice}, ${expectedMaxPrice}]) ✅`
      );
    } catch (error) {
      console.error(`       ❌ ${assetName} sanity check failed:`, error);
      throw new Error(`Sanity check failed for ${assetName}: ${(error as Error).message}`);
    }
  }
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment): Promise<boolean> {
  const { deployer } = await hre.getNamedAccounts();

  const config = await getConfig(hre);

  // Get USD oracle wrapper aggregator configurations
  const usdConfig = config.oracleAggregators.USD;

  if (!usdConfig?.oracleWrapperAggregators || Object.keys(usdConfig.oracleWrapperAggregators).length === 0) {
    console.log("No USD OracleWrapperAggregator configuration found, skipping deployment");
    return true;
  }

  const aggregatorConfigs = usdConfig.oracleWrapperAggregators;

  console.log(`Found ${Object.keys(aggregatorConfigs).length} OracleWrapperAggregator group(s) to deploy for USD`);

  // Deploy aggregator for each wrapper group
  for (const [groupKey, groupConfig] of Object.entries(aggregatorConfigs)) {
    const typedGroupConfig = groupConfig as {
      baseWrapperDeploymentId: string;
      quoteWrapperDeploymentId: string;
      baseCurrencyUnit: bigint;
      assets: string[];
    };

    // Derive display name from group key (e.g., "USDT" → "USDT_to_USD")
    const displayName = `${groupKey}_to_USD`;

    console.log(`\n🚀 Deploying group: ${groupKey} (${displayName})`);
    console.log(
      `   Assets: ${typedGroupConfig.assets.length} (${typedGroupConfig.assets.map((addr) => getAssetSymbol(addr, config)).join(", ")})`
    );

    // Resolve deployment IDs to actual addresses
    let baseWrapperAddress: string;
    let quoteWrapperAddress: string;

    try {
      const baseWrapperDeployment = await hre.deployments.get(typedGroupConfig.baseWrapperDeploymentId);
      baseWrapperAddress = baseWrapperDeployment.address;
      console.log(`   📍 Base Wrapper: ${typedGroupConfig.baseWrapperDeploymentId} → ${baseWrapperAddress}`);
    } catch {
      console.error(`❌ Base wrapper deployment not found: ${typedGroupConfig.baseWrapperDeploymentId}`);
      throw new Error(`Base wrapper deployment not found: ${typedGroupConfig.baseWrapperDeploymentId}`);
    }

    try {
      const quoteWrapperDeployment = await hre.deployments.get(typedGroupConfig.quoteWrapperDeploymentId);
      quoteWrapperAddress = quoteWrapperDeployment.address;
      console.log(`   📍 Quote Wrapper: ${typedGroupConfig.quoteWrapperDeploymentId} → ${quoteWrapperAddress}`);
    } catch {
      console.error(`❌ Quote wrapper deployment not found: ${typedGroupConfig.quoteWrapperDeploymentId}`);
      throw new Error(`Quote wrapper deployment not found: ${typedGroupConfig.quoteWrapperDeploymentId}`);
    }

    // Generate deployment ID for the aggregator
    const dynamicDeploymentId = `OracleWrapperAggregator_${displayName}`;

    console.log(`   📦 Deploying: ${dynamicDeploymentId}`);

    // Deploy OracleWrapperAggregator for this group
    const aggregatorDeployment = await hre.deployments.deploy(dynamicDeploymentId, {
      from: deployer,
      args: [
        baseWrapperAddress, // Base wrapper (resolved address)
        quoteWrapperAddress, // Quote wrapper (resolved address)
        usdConfig.baseCurrency, // Result currency (USD - zero address)
        typedGroupConfig.baseCurrencyUnit, // Base currency unit (1e18)
      ],
      contract: "OracleWrapperAggregator",
      autoMine: true,
      log: true,
    });

    const aggregator = await hre.ethers.getContractAt("OracleWrapperAggregator", aggregatorDeployment.address);

    console.log(`   ✅ Deployed at ${aggregatorDeployment.address}`);
    console.log(`   🔧 Configuration:`);
    console.log(`      Result: ${displayName} → USD`);
    console.log(`      Base Currency Unit: ${typedGroupConfig.baseCurrencyUnit}`);

    // Perform comprehensive sanity checks for the entire group
    await performGroupSanityChecks(hre, aggregator, typedGroupConfig, baseWrapperAddress, quoteWrapperAddress, config, displayName);

    console.log(`   🎯 ${displayName} OracleWrapperAggregator deployment completed successfully\n`);
  }

  console.log(`🔮 ${__filename.split("/").slice(-2).join("/")}: ✅`);
  return true;
};

func.tags = ["oracle-wrapper-aggregator", "usd-aggregator", "oracle-aggregator"];
func.dependencies = ["deploy-morpho-wrappers", "dusd-redstone-oracle-wrapper"];
func.id = "deploy-usd-oracle-wrapper-aggregators";

export default func;
