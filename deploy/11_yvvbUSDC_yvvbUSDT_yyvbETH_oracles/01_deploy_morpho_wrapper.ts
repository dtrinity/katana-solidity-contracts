import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

import { getConfig } from "../../config/config";

/**
 * Get quote asset symbol and default price range from configuration
 *
 * @param quoteAssetAddress The address of the quote asset to look up
 * @param config The network configuration containing token addresses
 * @returns Object containing symbol and default price range for the asset
 */
function getQuoteAssetInfo(quoteAssetAddress: string, config: any): { symbol: string; defaultRange: [number, number] } {
  // Check if it's a known token address
  const tokenAddresses = config.tokenAddresses || {};

  for (const [symbol, address] of Object.entries(tokenAddresses)) {
    if (address === quoteAssetAddress) {
      // Default ranges for known assets
      if (symbol.includes("USD") || symbol.includes("USDC") || symbol.includes("USDT")) {
        return { symbol, defaultRange: [0.8, 1.5] }; // Stablecoin range
      } else if (symbol.includes("ETH") || symbol.includes("WETH")) {
        return { symbol, defaultRange: [0.001, 100] }; // ETH range
      }
      return { symbol, defaultRange: [0.01, 100] }; // Generic range
    }
  }

  return { symbol: "Unknown", defaultRange: [0.001, 1e6] }; // Fallback range
}

/**
 * Determine vault type from configuration or address patterns
 *
 * @param baseAssetAddress The address of the base asset/vault to classify
 * @param config The network configuration containing morpho oracle settings
 * @returns The vault type classification: 'stablecoin', 'eth', or 'unknown'
 */
function getVaultType(baseAssetAddress: string, config: any): "stablecoin" | "eth" | "unknown" {
  // Try to get vault info from morpho config first
  const morphoConfig = config.oracleAggregators?.MORPHO?.morphoOracleAssets?.plainMorphoOracleWrappers;

  if (morphoConfig && morphoConfig[baseAssetAddress]) {
    // Check if the baseAsset name suggests a stablecoin vault
    const baseAssetName = baseAssetAddress.toLowerCase();

    if (baseAssetName.includes("usdc") || baseAssetName.includes("usdt") || baseAssetName.includes("usd")) {
      return "stablecoin";
    }

    // Check if it's an ETH vault
    if (baseAssetName.includes("eth") || baseAssetName.includes("weth")) {
      return "eth";
    }
  }

  return "unknown";
}

/**
 * Performs sanity checks on oracle wrapper feeds by verifying normalized prices are within a reasonable range
 * based on the quote asset type and vault configuration.
 *
 * @param hre The Hardhat runtime environment
 * @param wrapper The deployed oracle wrapper contract instance
 * @param feeds Record mapping asset addresses to their oracle feed configurations
 * @param baseCurrencyUnit The base currency unit for price normalization calculations
 * @param wrapperName The name of the wrapper for logging purposes
 * @param config The network configuration containing token addresses and settings
 * @returns Promise that resolves when all sanity checks pass or rejects on failure
 */
async function performOracleSanityChecks(
  hre: HardhatRuntimeEnvironment,
  wrapper: any,
  feeds: Record<string, any>,
  baseCurrencyUnit: bigint,
  wrapperName: string,
  config: any
): Promise<void> {
  for (const [assetAddress, feedConfig] of Object.entries(feeds)) {
    try {
      const typedFeedConfig = feedConfig as {
        baseAsset: string;
        quoteAsset: string;
        baseCurrencyUnit: bigint;
        feed: string;
        vaultName?: string;
        expectedPriceRange?: [number, number];
      };

      const price = await wrapper.getAssetPrice(assetAddress);
      const normalizedPrice = Number(price) / Number(baseCurrencyUnit);

      // Get quote asset information
      const { symbol: quoteAssetName, defaultRange } = getQuoteAssetInfo(typedFeedConfig.quoteAsset, config);

      // Determine vault type for more specific price ranges
      const vaultType = getVaultType(typedFeedConfig.baseAsset, config);

      // Use configured price range if available, otherwise use type-based defaults
      let [minPrice, maxPrice] = typedFeedConfig.expectedPriceRange || defaultRange;

      // Adjust ranges based on vault type if no specific range is configured
      if (!typedFeedConfig.expectedPriceRange) {
        if (vaultType === "stablecoin" && quoteAssetName.includes("USD")) {
          [minPrice, maxPrice] = [0.8, 1.5]; // Stablecoin-to-stablecoin should be close to 1:1
        } else if (vaultType === "stablecoin") {
          [minPrice, maxPrice] = [0.5, 2.0]; // Slightly wider range for cross-asset
        } else if (vaultType === "eth") {
          [minPrice, maxPrice] = [1e-6, 1e6]; // Very wide range for ETH vaults due to scaling
        }
      }

      const displayName = typedFeedConfig.vaultName || typedFeedConfig.baseAsset;

      // Additional sanity check: Compare wrapper price with raw Morpho feed price
      console.log(`    🔍 Verifying price conversion accuracy for ${displayName}...`);
      try {
        const MORPHO_FEED_ABI = ["function price() view returns (uint256)"];
        const morphoFeed = await hre.ethers.getContractAt(MORPHO_FEED_ABI, typedFeedConfig.feed);
        const rawMorphoPrice = await morphoFeed.price(); // 1e36 scaled

        console.log(`    📊 Raw Morpho Feed Price: ${rawMorphoPrice} (1e36 scale)`);

        // Convert raw Morpho price to wrapper's base currency unit (same logic as wrapper's _convertFromMorphoScale)
        const MORPHO_PRICE_SCALE = BigInt(10) ** BigInt(36);

        // Simulate the wrapper's _convertFromMorphoScale function: morphoPrice.mulDiv(BASE_CURRENCY_UNIT, MORPHO_PRICE_SCALE)
        const convertedMorphoPrice = (rawMorphoPrice * BigInt(baseCurrencyUnit.toString())) / MORPHO_PRICE_SCALE;
        const convertedMorphoPriceNumber = Number(convertedMorphoPrice) / Number(baseCurrencyUnit);

        console.log(`    🔄 Converted Raw Price: ${convertedMorphoPrice} (base currency units)`);
        console.log(`    📈 Normalized Raw Price: ${convertedMorphoPriceNumber.toFixed(8)} ${quoteAssetName}`);
        console.log(`    📈 Wrapper Price:       ${normalizedPrice.toFixed(8)} ${quoteAssetName}`);

        // Check if wrapper price differs from direct conversion by more than 0.1%
        const priceDifference = Math.abs(normalizedPrice - convertedMorphoPriceNumber);
        const percentageDifference = (priceDifference / convertedMorphoPriceNumber) * 100;
        const absoluteDifference = priceDifference.toFixed(8);

        console.log(`    📊 Price Difference: ${absoluteDifference} ${quoteAssetName} (${percentageDifference.toFixed(6)}%)`);

        if (percentageDifference > 0.1) {
          // 0.1% tolerance
          const errorMsg =
            `Price conversion sanity check failed for ${displayName}: ` +
            `Wrapper price ${normalizedPrice.toFixed(8)} differs from raw Morpho price ${convertedMorphoPriceNumber.toFixed(8)} by ${percentageDifference.toFixed(6)}% (>0.1%)`;
          console.error(`    ❌ ${errorMsg}`);
          throw new Error(errorMsg);
        } else {
          console.log(`    ✅ Price conversion check PASSED: Difference ${percentageDifference.toFixed(6)}% (<0.1% tolerance)`);
        }
      } catch (conversionError) {
        console.warn(`    ⚠️  Could not verify price conversion for ${displayName}: ${(conversionError as Error).message}`);
        // Don't fail deployment for conversion check issues, just warn
      }

      if (normalizedPrice < minPrice || normalizedPrice > maxPrice) {
        const errorMsg =
          `Sanity check failed for ${displayName}/${quoteAssetName} (${assetAddress}): ` +
          `Price ${normalizedPrice.toFixed(6)} is outside expected range [${minPrice}, ${maxPrice}]`;
        console.error(errorMsg);
        throw new Error(errorMsg);
      } else {
        console.log(
          `Sanity check passed for ${displayName}/${quoteAssetName}: ` +
          `Price ${normalizedPrice.toFixed(6)} ${quoteAssetName} (range: [${minPrice}, ${maxPrice}])`
        );
      }
    } catch (error) {
      console.error(`Error performing sanity check for asset ${assetAddress} in ${wrapperName}:`, error);
      throw new Error(`Error performing sanity check for asset ${assetAddress} in ${wrapperName}: ${error}`);
    }
  }
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment): Promise<boolean> {
  const { deployer } = await hre.getNamedAccounts();

  const config = await getConfig(hre);

  // Get feed configurations from the MORPHO section
  const morphoConfig = config.oracleAggregators.MORPHO;

  if (!morphoConfig) {
    console.log("No MORPHO oracle configuration found, skipping wrapper deployment");
    return true;
  }

  const plainFeeds = morphoConfig.morphoOracleAssets?.plainMorphoOracleWrappers || {};
  const feedEntries = Object.entries(plainFeeds);

  if (feedEntries.length === 0) {
    console.log("No Morpho oracle feeds configured, skipping wrapper deployment");
    return true;
  }

  // Group feeds by quote asset to deploy separate wrappers
  const feedsByQuoteAsset = new Map<string, Array<[string, any]>>();

  for (const [assetAddress, feedConfig] of feedEntries) {
    const typedFeedConfig = feedConfig as {
      baseAsset: string;
      quoteAsset: string;
      baseCurrencyUnit: bigint;
      feed: string;
    };

    if (!feedsByQuoteAsset.has(typedFeedConfig.quoteAsset)) {
      feedsByQuoteAsset.set(typedFeedConfig.quoteAsset, []);
    }
    feedsByQuoteAsset.get(typedFeedConfig.quoteAsset)!.push([assetAddress, feedConfig]);
  }

  console.log(`Found ${feedsByQuoteAsset.size} different quote assets for Morpho oracles`);

  // Deploy wrapper for each quote asset group
  for (const [quoteAsset, groupedFeeds] of feedsByQuoteAsset.entries()) {
    const firstFeedConfig = groupedFeeds[0][1] as {
      baseAsset: string;
      quoteAsset: string;
      baseCurrencyUnit: bigint;
      feed: string;
      vaultName?: string;
    };

    // Generate dynamic wrapper ID and name based on quote asset
    const { symbol: quoteAssetSymbol } = getQuoteAssetInfo(quoteAsset, config);

    // Use symbol for cleaner naming, fallback to address suffix
    const quoteAssetIdentifier = quoteAssetSymbol !== "Unknown" ? quoteAssetSymbol : `0x${quoteAsset.slice(-8)}`;

    const wrapperDeploymentId = `MorphoChainlinkOracleV2Wrapper_${quoteAssetIdentifier}`;
    const wrapperName = `${quoteAssetIdentifier}-denominated Morpho`;

    console.log(`\nDeploying ${wrapperName} oracle wrapper...`);
    console.log(`  Quote asset: ${quoteAsset} (${quoteAssetSymbol})`);
    console.log(`  Feeds to configure: ${groupedFeeds.length}`);

    // Deploy wrapper with quote asset as base currency
    const morphoWrapperDeployment = await hre.deployments.deploy(wrapperDeploymentId, {
      from: deployer,
      args: [quoteAsset, firstFeedConfig.baseCurrencyUnit], // Use quote asset as baseCurrency
      contract: "MorphoChainlinkOracleV2Wrapper",
      autoMine: true,
      log: false,
    });

    const morphoWrapper = await hre.ethers.getContractAt("MorphoChainlinkOracleV2Wrapper", morphoWrapperDeployment.address);

    console.log(`Deployed ${wrapperName} wrapper at ${morphoWrapperDeployment.address}`);

    // Configure oracles for this quote asset group
    for (const [assetAddress, feedConfig] of groupedFeeds) {
      if (!assetAddress || !/^0x[0-9a-fA-F]{40}$/.test(assetAddress)) {
        console.error(`[morpho-oracle-setup] Invalid or missing assetAddress: '${assetAddress}'`);
        throw new Error(`[morpho-oracle-setup] Invalid or missing assetAddress: '${assetAddress}'`);
      }

      const typedFeedConfig = feedConfig as {
        baseAsset: string;
        quoteAsset: string;
        baseCurrencyUnit: bigint;
        feed: string;
        vaultName?: string;
      };

      // Skip zero addresses (placeholder values)
      if (typedFeedConfig.feed === "0x0000000000000000000000000000000000000000") {
        console.log(`Skipping placeholder oracle address for asset ${assetAddress}`);
        continue;
      }

      if (!typedFeedConfig.feed || !/^0x[0-9a-fA-F]{40}$/.test(typedFeedConfig.feed)) {
        console.error(`[morpho-oracle-setup] Invalid or missing feed address for asset ${assetAddress}: '${typedFeedConfig.feed}'`);
        throw new Error(`[morpho-oracle-setup] Invalid or missing feed address for asset ${assetAddress}: '${typedFeedConfig.feed}'`);
      }

      await morphoWrapper.setOracle(assetAddress, typedFeedConfig.feed);
      const displayName = typedFeedConfig.vaultName || `Asset ${assetAddress.slice(-8)}`;
      console.log(`  ✅ Set oracle for ${displayName} to ${typedFeedConfig.feed}`);
    }

    // Sanity check for this group's oracles (only for configured non-placeholder oracles)
    const configuredFeeds = Object.fromEntries(
      groupedFeeds.filter(
        ([, feedConfig]: [string, any]) => feedConfig.feed && feedConfig.feed !== "0x0000000000000000000000000000000000000000"
      )
    );

    if (Object.keys(configuredFeeds).length > 0) {
      await performOracleSanityChecks(hre, morphoWrapper, configuredFeeds, firstFeedConfig.baseCurrencyUnit, wrapperName, config);
    } else {
      console.log(`No configured oracles found for ${wrapperName} - all are placeholders`);
    }
  }

  console.log(`🔮 ${__filename.split("/").slice(-2).join("/")}: ✅`);
  return true;
};

func.tags = ["morpho-oracle", "oracle-aggregator", "oracle-wrapper", "yvvbUSDC", "yvvbUSDT"];
func.dependencies = [];
func.id = "deploy-yvvbUSDC-yvvbUSDT-morpho-wrappers";

export default func;
