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
  console.log(`  🔍 Sanity checking ${groupName}...`);

  // Test each asset in the group
  for (const assetAddress of groupConfig.assets) {
    const assetName = getAssetSymbol(assetAddress, config);

    try {
      // Check prerequisites
      const WRAPPER_ABI = [
        "function getPriceInfo(address) view returns (uint256, bool)",
        "function BASE_CURRENCY() view returns (address)",
        "function BASE_CURRENCY_UNIT() view returns (uint256)",
        "function assetToOracle(address) view returns (address)",
      ];

      const baseWrapper = await hre.ethers.getContractAt(WRAPPER_ABI, baseWrapperAddress);

      // Verify asset is configured in base wrapper
      const configuredOracle = await baseWrapper.assetToOracle(assetAddress).catch(() => hre.ethers.ZeroAddress);

      if (configuredOracle === hre.ethers.ZeroAddress) {
        throw new Error(
          `Asset ${assetName} not configured in base wrapper ${groupConfig.baseWrapperDeploymentId}. Run Morpho oracle deployment first.`
        );
      }

      // Verify quote wrapper can price the intermediate currency
      const baseWrapperBaseCurrency = await baseWrapper.BASE_CURRENCY();
      const quoteWrapperTest = await hre.ethers.getContractAt(WRAPPER_ABI, quoteWrapperAddress);

      try {
        await quoteWrapperTest.getPriceInfo(baseWrapperBaseCurrency);
      } catch {
        const intermediateCurrencySymbol = getAssetSymbol(baseWrapperBaseCurrency, config);
        throw new Error(
          `Quote wrapper ${groupConfig.quoteWrapperDeploymentId} cannot price intermediate currency ${intermediateCurrencySymbol}. Run USD Redstone wrapper setup first.`
        );
      }

      // Get aggregated result
      const { price: aggregatedPrice, isAlive } = await aggregator.getPriceInfo(assetAddress);
      const normalizedAggregatedPrice = Number(aggregatedPrice) / Number(groupConfig.baseCurrencyUnit);

      if (!isAlive || aggregatedPrice === 0n) {
        throw new Error(`Aggregator returned invalid price (${aggregatedPrice}) or not alive (${isAlive})`);
      }

      // Validate source feeds and calculate expected result
      const [basePrice, baseIsAlive] = await baseWrapper.getPriceInfo(assetAddress);
      const baseUnit = await baseWrapper.BASE_CURRENCY_UNIT();

      if (!baseIsAlive || basePrice === 0n) {
        throw new Error(`Base wrapper returned invalid price or not alive`);
      }

      const intermediateCurrency = await baseWrapper.BASE_CURRENCY();
      const quoteWrapperDetailed = await hre.ethers.getContractAt(WRAPPER_ABI, quoteWrapperAddress);
      const [quotePrice, quoteIsAlive] = await quoteWrapperDetailed.getPriceInfo(intermediateCurrency);
      const quoteUnit = await quoteWrapperDetailed.BASE_CURRENCY_UNIT();

      if (!quoteIsAlive || quotePrice === 0n) {
        throw new Error(`Quote wrapper returned invalid price or not alive`);
      }

      // Calculate expected result and verify accuracy
      const manualCalculation =
        (Number(basePrice) / Number(baseUnit) / (Number(quotePrice) / Number(quoteUnit))) * Number(groupConfig.baseCurrencyUnit);
      const calculationDifference = Math.abs(normalizedAggregatedPrice - manualCalculation);
      const calculationPercentDiff = (calculationDifference / manualCalculation) * 100;

      if (calculationPercentDiff > 0.01) {
        throw new Error(`Aggregator calculation mismatch: ${calculationPercentDiff.toFixed(6)}% difference (>0.01%)`);
      }

      // Price range sanity check
      let expectedMinPrice: number;
      let expectedMaxPrice: number;

      if (assetName.includes("USD") || assetName.includes("USDC") || assetName.includes("USDT")) {
        expectedMinPrice = 0.8;
        expectedMaxPrice = 1.5;
      } else if (assetName.includes("ETH")) {
        expectedMinPrice = 500;
        expectedMaxPrice = 10000;
      } else {
        expectedMinPrice = 0.01;
        expectedMaxPrice = 100000;
      }

      if (normalizedAggregatedPrice < expectedMinPrice || normalizedAggregatedPrice > expectedMaxPrice) {
        throw new Error(
          `USD price outside expected range: ${normalizedAggregatedPrice.toFixed(8)} not in [${expectedMinPrice}, ${expectedMaxPrice}]`
        );
      }

      console.log(`    ✅ ${assetName}: ${normalizedAggregatedPrice.toFixed(6)} USD (±${calculationPercentDiff.toFixed(4)}%)`);
    } catch (error) {
      console.error(`    ❌ ${assetName} failed: ${(error as Error).message}`);
      throw error;
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

    console.log(`\nDeploying OracleWrapperAggregator: ${displayName}`);
    console.log(`  Assets: ${typedGroupConfig.assets.map((addr) => getAssetSymbol(addr, config)).join(", ")}`);

    // Resolve deployment IDs to actual addresses
    let baseWrapperAddress: string;
    let quoteWrapperAddress: string;

    try {
      const baseWrapperDeployment = await hre.deployments.get(typedGroupConfig.baseWrapperDeploymentId);
      baseWrapperAddress = baseWrapperDeployment.address;
    } catch {
      throw new Error(`Base wrapper deployment not found: ${typedGroupConfig.baseWrapperDeploymentId}`);
    }

    try {
      const quoteWrapperDeployment = await hre.deployments.get(typedGroupConfig.quoteWrapperDeploymentId);
      quoteWrapperAddress = quoteWrapperDeployment.address;
    } catch {
      throw new Error(`Quote wrapper deployment not found: ${typedGroupConfig.quoteWrapperDeploymentId}`);
    }

    // Deploy the aggregator
    const dynamicDeploymentId = `OracleWrapperAggregator_${displayName}`;

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

    console.log(`  ✅ Deployed at ${aggregatorDeployment.address}`);

    // Perform sanity checks
    await performGroupSanityChecks(hre, aggregator, typedGroupConfig, baseWrapperAddress, quoteWrapperAddress, config, displayName);

    console.log(`  🎯 ${displayName} deployment completed successfully`);
  }

  console.log(`🔮 ${__filename.split("/").slice(-2).join("/")}: ✅`);
  return true;
};

func.tags = ["oracle-wrapper-aggregator", "usd-aggregator", "oracle-aggregator"];
func.dependencies = ["deploy-yvvbUSDC-yvvbUSDT-morpho-wrappers", "setup-usd-redstone-oracle-wrappers"];
func.id = "deploy-usd-oracle-wrapper-aggregators";

export default func;
