import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

import { getConfig } from "../../config/config";
import { MORPHO_USDC_ORACLE_WRAPPER_ID, MORPHO_USDT_ORACLE_WRAPPER_ID } from "../../typescript/deploy-ids";

/**
 * Performs sanity checks on oracle wrapper feeds by verifying normalized prices are within a reasonable range
 * based on the quote asset type.
 *
 * @param wrapper The oracle wrapper contract instance.
 * @param feeds A record mapping asset addresses to oracle configurations.
 * @param baseCurrencyUnit The base currency unit for price calculations.
 * @param wrapperName The name of the wrapper for logging purposes.
 * @param config Network configuration to get quote asset information.
 */
async function performOracleSanityChecks(
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
      };

      const price = await wrapper.getAssetPrice(assetAddress);
      const normalizedPrice = Number(price) / Number(baseCurrencyUnit);

      // Determine expected price range based on quote asset and base asset type
      let minPrice: number;
      let maxPrice: number;
      let quoteAssetName: string;

      // Map quote asset addresses to names and expected ranges
      if (typedFeedConfig.quoteAsset === config.tokenAddresses.USDT) {
        quoteAssetName = "USDT";
        // Stablecoin yield vaults should be close to 1.0 in their quote stablecoin
        minPrice = 0.8; // Allow 20% deviation below
        maxPrice = 1.5; // Allow 50% deviation above
      } else if (typedFeedConfig.quoteAsset === config.tokenAddresses.USDC) {
        quoteAssetName = "USDC";

        // Determine asset type by checking addresses
        const yvvbUSDCAddress = "0x80c34BD3A3569E126e7055831036aa7b212cB159";
        const yvvbUSDTAddress = "0x9A6bd7B6Fd5C4F87eb66356441502fc7dCdd185B";

        const isStablecoinVault = typedFeedConfig.baseAsset === yvvbUSDTAddress || typedFeedConfig.baseAsset === yvvbUSDCAddress;

        if (isStablecoinVault) {
          // Stablecoin yield vaults should be close to 1.0 in their quote asset
          minPrice = 0.8; // Allow 20% deviation below
          maxPrice = 1.5; // Allow 50% deviation above
        } else {
          // Unknown vault type - use conservative range
          minPrice = 0.1;
          maxPrice = 10000;
        }
      } else {
        // Fallback for unknown quote assets
        quoteAssetName = "Unknown";
        minPrice = 0.001;
        maxPrice = 1e6;
      }

      if (normalizedPrice < minPrice || normalizedPrice > maxPrice) {
        console.error(
          `Sanity check failed for ${typedFeedConfig.baseAsset}/${quoteAssetName} (${assetAddress}): ` +
            `Price ${normalizedPrice} is outside expected range [${minPrice}, ${maxPrice}]`
        );
        throw new Error(
          `Sanity check failed for ${typedFeedConfig.baseAsset}/${quoteAssetName}: ` +
            `Price ${normalizedPrice} outside range [${minPrice}, ${maxPrice}]`
        );
      } else {
        console.log(
          `Sanity check passed for ${typedFeedConfig.baseAsset}/${quoteAssetName}: ` +
            `Price ${normalizedPrice} ${quoteAssetName} (expected range: [${minPrice}, ${maxPrice}])`
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
    };

    // Determine wrapper ID based on quote asset
    let wrapperDeploymentId: string;
    let wrapperName: string;

    if (quoteAsset === config.tokenAddresses.USDC) {
      wrapperDeploymentId = MORPHO_USDC_ORACLE_WRAPPER_ID;
      wrapperName = "USDC-denominated Morpho";
    } else if (quoteAsset === config.tokenAddresses.USDT) {
      wrapperDeploymentId = MORPHO_USDT_ORACLE_WRAPPER_ID;
      wrapperName = "USDT-denominated Morpho";
    } else {
      console.error(`Unsupported quote asset: ${quoteAsset}`);
      throw new Error(`Unsupported quote asset: ${quoteAsset}`);
    }

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
      console.log(`  Set oracle for ${typedFeedConfig.baseAsset} to ${typedFeedConfig.feed}`);
    }

    // Sanity check for this group's oracles (only for configured non-placeholder oracles)
    const configuredFeeds = Object.fromEntries(
      groupedFeeds.filter(
        ([, feedConfig]: [string, any]) => feedConfig.feed && feedConfig.feed !== "0x0000000000000000000000000000000000000000"
      )
    );

    if (Object.keys(configuredFeeds).length > 0) {
      await performOracleSanityChecks(morphoWrapper, configuredFeeds, firstFeedConfig.baseCurrencyUnit, wrapperName, config);
    } else {
      console.log(`No configured oracles found for ${wrapperName} - all are placeholders`);
    }
  }

  console.log(`🔮 ${__filename.split("/").slice(-2).join("/")}: ✅`);
  return true;
};

func.tags = ["morpho-oracle", "oracle-aggregator", "oracle-wrapper"];
func.dependencies = [];
func.id = "deploy-morpho-wrappers";

export default func;
