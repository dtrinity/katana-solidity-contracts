import hre from "hardhat";
const { ethers } = hre;
import path from "path";

/**
 * Utility script: prints latest prices for all on-chain oracle deployments on a given Hardhat network,
 * with automatic discovery of MorphoChainlinkOracleV2Wrapper contracts and their configured assets.
 *
 * Usage examples:
 *   # Show all oracle prices on network (including auto-discovered Morpho wrappers)
 *   yarn hardhat run --network katana_mainnet scripts/oracle/show_oracle_prices.ts
 *   
 *   # Query specific MorphoChainlinkOracleV2Wrapper (manual mode)
 *   yarn hardhat run --network katana_mainnet scripts/oracle/show_oracle_prices.ts -- <wrapperAddress> <assetAddress>
 *   
 *   # Query only Morpho wrappers automatically
 *   yarn hardhat run --network katana_mainnet scripts/oracle/show_oracle_prices.ts -- --morpho-only
 *
 * The script walks the hardhat-deploy deployments directory for the selected network, tries to
 * attach the minimal Chainlink AggregatorV3 interface and prints {name, description, price, updatedAt}.
 * 
 * For MorphoWrapper contracts, it automatically discovers configured assets from the config and queries them.
 */

/**
 * Query a specific MorphoChainlinkOracleV2Wrapper contract
 * @param wrapperAddress Address of the MorphoChainlinkOracleV2Wrapper contract
 * @param assetAddress Address of the asset to get price for
 */
async function queryMorphoWrapper(wrapperAddress: string, assetAddress: string): Promise<void> {
  console.log(`\n🔍 Querying MorphoChainlinkOracleV2Wrapper`);
  console.log("============================================================");
  console.log(`Wrapper Address: ${wrapperAddress}`);
  console.log(`Asset Address: ${assetAddress}`);
  console.log("------------------------------------------------------------");

  try {
    // Create contract instance with MorphoChainlinkOracleV2Wrapper ABI
    const MORPHO_WRAPPER_ABI = [
      "function getAssetPrice(address asset) view returns (uint256)",
      "function getPriceInfo(address asset) view returns (uint256 price, bool isAlive)",
      "function BASE_CURRENCY() view returns (address)",
      "function BASE_CURRENCY_UNIT() view returns (uint256)",
      "function assetToOracle(address asset) view returns (address)",
    ];

    const morphoWrapper = await ethers.getContractAt(MORPHO_WRAPPER_ABI, wrapperAddress);

    // Get all the information
    const [rawPrice, priceInfo, baseCurrency, baseCurrencyUnit, oracleAddress] = await Promise.all([
      morphoWrapper.getAssetPrice(assetAddress).catch((e: Error) => `Error: ${e.message}`),
      morphoWrapper.getPriceInfo(assetAddress).catch((e: Error) => `Error: ${e.message}`),
      morphoWrapper.BASE_CURRENCY(),
      morphoWrapper.BASE_CURRENCY_UNIT(),
      morphoWrapper.assetToOracle(assetAddress).catch((e: Error) => ethers.ZeroAddress),
    ]);

    // Load config to find quote asset information
    const config = await loadNetworkConfig();
    let quoteAssetSymbol = "Unknown";
    let baseAssetSymbol = "Unknown";

    if (config) {
      // Create reverse lookup map for token addresses
      const addressToSymbol: Record<string, string> = {};
      for (const [symbol, address] of Object.entries(config.tokenAddresses)) {
        if (typeof address === 'string' && address) {
          addressToSymbol[address.toLowerCase()] = symbol;
        }
      }

      // Find quote asset from Morpho config
      const morphoConfig = config.oracleAggregators?.MORPHO?.morphoOracleAssets?.plainMorphoOracleWrappers;
      if (morphoConfig) {
        for (const [configAsset, feedConfig] of Object.entries(morphoConfig)) {
          if (configAsset.toLowerCase() === assetAddress.toLowerCase()) {
            const typedConfig = feedConfig as { baseAsset: string; quoteAsset: string; baseCurrencyUnit: bigint; feed: string; };
            quoteAssetSymbol = addressToSymbol[typedConfig.quoteAsset.toLowerCase()] || typedConfig.quoteAsset;
            baseAssetSymbol = addressToSymbol[typedConfig.baseAsset.toLowerCase()] || typedConfig.baseAsset;
            break;
          }
        }
      }

      // Also check if base currency matches known tokens
      if (!quoteAssetSymbol || quoteAssetSymbol === "Unknown") {
        quoteAssetSymbol = addressToSymbol[baseCurrency.toLowerCase()] || baseCurrency;
      }
    }

    // Format base currency unit for display
    const baseCurrencyUnitBig = BigInt(baseCurrencyUnit.toString());
    let scalingInfo = "";
    if (baseCurrencyUnitBig === BigInt(10) ** BigInt(36)) {
      scalingInfo = " (1e36 - Morpho scale)";
    } else if (baseCurrencyUnitBig === BigInt(10) ** BigInt(18)) {
      scalingInfo = " (1e18 - Standard 18 decimals)";
    } else if (baseCurrencyUnitBig === BigInt(10) ** BigInt(8)) {
      scalingInfo = " (1e8 - Standard 8 decimals)";
    }

    // Display results
    console.log(`📊 Results:`);
    console.log(`  Base Asset       : ${baseAssetSymbol}`);
    console.log(`  Quote Asset      : ${quoteAssetSymbol}`);
    console.log(`  Oracle Address   : ${oracleAddress}`);
    console.log(`  Base Currency    : ${baseCurrency}`);
    console.log(`  Base Currency Unit: ${baseCurrencyUnit}${scalingInfo}`);

    if (typeof rawPrice === 'string') {
      console.log(`  Raw Price        : ${rawPrice}`);
    } else {
      const priceFormatted = ethers.formatUnits(rawPrice, 36); // Assume Morpho 36 decimal scaling
      console.log(`  Raw Price        : ${rawPrice} (${priceFormatted} normalized)`);
    }

    if (typeof priceInfo === 'string') {
      console.log(`  Price Info       : ${priceInfo}`);
    } else {
      const [price, isAlive] = priceInfo as [bigint, boolean];
      const priceFormatted = ethers.formatUnits(price, 36);
      console.log(`  Price Info       : ${price} (${priceFormatted} normalized), isAlive: ${isAlive}`);
    }

    console.log("============================================================\n");

  } catch (error) {
    console.error(`❌ Error querying MorphoWrapper:`, error);
  }
}

/**
 * Automatically discover and query all MorphoChainlinkOracleV2Wrapper deployments
 */
async function queryAllMorphoWrappers(): Promise<void> {
  console.log(`\n🔍 Auto-Discovering MorphoChainlinkOracleV2Wrapper Deployments`);
  console.log("============================================================\n");

  try {
    // Get all deployments
    const deployments = await hre.deployments.all();

    // Find Morpho wrapper deployments
    const morphoWrappers: Array<{ name: string; address: string }> = [];
    for (const [name, deployment] of Object.entries(deployments)) {
      const typedDeployment = deployment as { address?: string };
      if (name.includes("MorphoChainlinkOracleV2Wrapper") && typedDeployment.address) {
        morphoWrappers.push({ name, address: typedDeployment.address });
      }
    }

    if (morphoWrappers.length === 0) {
      console.log("❌ No MorphoChainlinkOracleV2Wrapper deployments found");
      return;
    }

    console.log(`Found ${morphoWrappers.length} MorphoWrapper deployment(s):`);
    for (const wrapper of morphoWrappers) {
      console.log(`  ${wrapper.name}: ${wrapper.address}`);
    }
    console.log("");

    // Load config to get asset configurations
    const config = await loadNetworkConfig();
    if (!config?.oracleAggregators?.MORPHO?.morphoOracleAssets?.plainMorphoOracleWrappers) {
      console.log("❌ No MORPHO oracle configuration found in config");
      return;
    }

    const morphoAssets = config.oracleAggregators.MORPHO.morphoOracleAssets.plainMorphoOracleWrappers;
    const assetEntries = Object.entries(morphoAssets);

    if (assetEntries.length === 0) {
      console.log("❌ No Morpho assets configured");
      return;
    }

    console.log(`Found ${assetEntries.length} configured Morpho asset(s):`);
    for (const [assetAddress, feedConfig] of assetEntries) {
      const typedConfig = feedConfig as { baseAsset: string; quoteAsset: string; baseCurrencyUnit: bigint; feed: string; };
      console.log(`  ${assetAddress} (${typedConfig.baseAsset}/${typedConfig.quoteAsset})`);
    }
    console.log("");

    // Query each wrapper with each configured asset
    for (const wrapper of morphoWrappers) {
      console.log(`\n🔧 Testing ${wrapper.name} (${wrapper.address})`);
      console.log("============================================================");

      for (const [assetAddress, feedConfig] of assetEntries) {
        const typedConfig = feedConfig as { baseAsset: string; quoteAsset: string; baseCurrencyUnit: bigint; feed: string; };

        console.log(`\n📊 Asset: ${typedConfig.baseAsset} (${assetAddress})`);
        console.log("------------------------------------------------------------");

        try {
          // Create contract instance
          const MORPHO_WRAPPER_ABI = [
            "function getAssetPrice(address asset) view returns (uint256)",
            "function getPriceInfo(address asset) view returns (uint256 price, bool isAlive)",
            "function BASE_CURRENCY() view returns (address)",
            "function BASE_CURRENCY_UNIT() view returns (uint256)",
            "function assetToOracle(address asset) view returns (address)",
          ];

          const morphoWrapper = await ethers.getContractAt(MORPHO_WRAPPER_ABI, wrapper.address);

          // Check if oracle is configured for this asset
          const configuredOracle = await morphoWrapper.assetToOracle(assetAddress);
          if (configuredOracle === ethers.ZeroAddress) {
            console.log(`  ⚠️  No oracle configured for this asset in wrapper ${wrapper.name}`);
            continue;
          }

          // Get price information
          const [rawPrice, priceInfo, baseCurrency, baseCurrencyUnit] = await Promise.all([
            morphoWrapper.getAssetPrice(assetAddress).catch((e: Error) => `Error: ${e.message}`),
            morphoWrapper.getPriceInfo(assetAddress).catch((e: Error) => `Error: ${e.message}`),
            morphoWrapper.BASE_CURRENCY(),
            morphoWrapper.BASE_CURRENCY_UNIT(),
          ]);

          // Create reverse lookup for token symbols
          const addressToSymbol: Record<string, string> = {};
          for (const [symbol, address] of Object.entries(config.tokenAddresses)) {
            if (typeof address === 'string' && address) {
              addressToSymbol[address.toLowerCase()] = symbol;
            }
          }

          const quoteAssetSymbol = addressToSymbol[typedConfig.quoteAsset.toLowerCase()] || typedConfig.quoteAsset;
          const baseCurrencySymbol = addressToSymbol[baseCurrency.toLowerCase()] || baseCurrency;

          // Format base currency unit for display
          const baseCurrencyUnitBig = BigInt(baseCurrencyUnit.toString());
          let scalingInfo = "";
          if (baseCurrencyUnitBig === BigInt(10) ** BigInt(36)) {
            scalingInfo = " (1e36 - Morpho scale)";
          } else if (baseCurrencyUnitBig === BigInt(10) ** BigInt(18)) {
            scalingInfo = " (1e18 - Standard 18 decimals)";
          } else if (baseCurrencyUnitBig === BigInt(10) ** BigInt(8)) {
            scalingInfo = " (1e8 - Standard 8 decimals)";
          }

          console.log(`  Quote Asset      : ${quoteAssetSymbol}`);
          console.log(`  Oracle Address   : ${configuredOracle}`);
          console.log(`  Base Currency    : ${baseCurrencySymbol}`);
          console.log(`  Base Currency Unit: ${baseCurrencyUnit}${scalingInfo}`);

          if (typeof rawPrice === 'string') {
            console.log(`  Raw Price        : ${rawPrice}`);
          } else {
            const priceFormatted = ethers.formatUnits(rawPrice, 36);
            console.log(`  Raw Price        : ${rawPrice} (${priceFormatted} normalized)`);
          }

          if (typeof priceInfo === 'string') {
            console.log(`  Price Info       : ${priceInfo}`);
          } else {
            const [price, isAlive] = priceInfo as [bigint, boolean];
            const priceFormatted = ethers.formatUnits(price, 36);
            console.log(`  Price Info       : ${price} (${priceFormatted} normalized), isAlive: ${isAlive}`);
          }

        } catch (error) {
          console.log(`  ❌ Error querying asset ${typedConfig.baseAsset}: ${(error as Error).message}`);
        }
      }
    }

  } catch (error) {
    console.error(`❌ Error in auto-discovery:`, error);
  }
}

/** Helper: dynamically import the network config and build Config object */
async function loadNetworkConfig() {
  const networkName = hre.network.name;

  try {
    // Example path: ../../config/networks/katana_mainnet.ts (relative to this script file)
    const configPath = path.resolve(
      __dirname,
      "../../config/networks",
      `${networkName}.ts`,
    );

    const configModule = await import(configPath);

    if (typeof configModule.getConfig !== "function") {
      console.warn(
        `Config module for ${networkName} does not export getConfig – skipping aggregator section`,
      );
      return undefined;
    }
    const config = await configModule.getConfig(hre);
    return config;
  } catch (err) {
    console.warn(
      `⚠️  Could not load network config for ${networkName}: ${(err as Error).message}`,
    );
    return undefined;
  }
}

/**
 * Retrieve aggregator deployment by conventional name (e.g., USD_OracleAggregator)
 *
 * @param key
 */
async function getAggregatorContract(key: string) {
  const deploymentName = `${key}_OracleAggregator`;

  try {
    const dep = await hre.deployments.get(deploymentName);
    const AGGREGATOR_ABI = [
      "function getAssetPrice(address) view returns (uint256)",
    ];
    return await ethers.getContractAt(AGGREGATOR_ABI, dep.address);
  } catch {
    return undefined;
  }
}

/** Utility: pretty print aggregator prices */
async function dumpAggregatorPrices(): Promise<void> {
  const config = await loadNetworkConfig();
  if (!config) return;

  const aggregatorEntries = Object.entries(
    (config.oracleAggregators ?? {}) as Record<string, any>,
  );
  if (aggregatorEntries.length === 0) return;

  console.log("\n📊 Aggregator Prices");
  console.log("============================================================\n");

  for (const [aggKey, aggConfig] of aggregatorEntries) {
    const contract = await getAggregatorContract(aggKey);

    if (!contract) {
      console.log(`❌ No deployment found for ${aggKey}_OracleAggregator`);
      continue;
    }

    // Collect asset addresses from the various config buckets
    const assetSet = new Set<string>();

    const addKeys = (obj?: Record<string, any>) => {
      if (!obj) return;

      for (const k of Object.keys(obj)) {
        const keyStr = k as string;
        if (keyStr && keyStr !== "") assetSet.add(keyStr.toLowerCase());
      }
    };

    // API3
    addKeys(aggConfig.api3OracleAssets?.plainApi3OracleWrappers);
    addKeys(aggConfig.api3OracleAssets?.api3OracleWrappersWithThresholding);
    addKeys(
      aggConfig.api3OracleAssets?.compositeApi3OracleWrappersWithThresholding,
    );

    // Redstone
    addKeys(aggConfig.redstoneOracleAssets?.plainRedstoneOracleWrappers);
    addKeys(
      aggConfig.redstoneOracleAssets?.redstoneOracleWrappersWithThresholding,
    );
    addKeys(
      aggConfig.redstoneOracleAssets
        ?.compositeRedstoneOracleWrappersWithThresholding,
    );


    // Chainlink composite wrappers (simple map asset->config)
    addKeys(aggConfig.chainlinkCompositeWrapperAggregator);

    const tokenAddressMap: Record<string, string> = Object.entries(
      (config.tokenAddresses ?? {}) as Record<string, any>,
    ).reduce(
      (acc, [symbol, addr]) => {
        if (addr) acc[(addr as string).toLowerCase()] = symbol;
        return acc;
      },
      {} as Record<string, string>,
    );

    const decimals = aggConfig.priceDecimals ?? 18;

    console.log(`▶ Aggregator: ${aggKey}`);

    for (const assetAddrLower of assetSet) {
      try {
        const rawPrice = await contract.getAssetPrice(assetAddrLower);
        const priceHuman = ethers.formatUnits(rawPrice, decimals);
        const symbol = tokenAddressMap[assetAddrLower] || assetAddrLower;
        console.log(`  ${symbol.padEnd(15)} : ${priceHuman}`);
      } catch (err) {
        console.warn(
          `  ⚠️  Could not fetch price for ${assetAddrLower}: ${(err as Error).message}`,
        );
      }
    }
    console.log("------------------------------------------------------------");
  }
}

/**
 * Main function that handles multiple modes: regular oracle scanning, auto-discovery, and manual MorphoWrapper queries
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  console.log(`\n🌐 Network: ${hre.network.name}`);

  // Handle different modes based on arguments
  if (args.length === 1 && args[0] === '--morpho-only') {
    // Morpho-only auto-discovery mode
    console.log("🎯 Morpho-Only Auto-Discovery Mode");
    await queryAllMorphoWrappers();
    return;
  } else if (args.length === 2) {
    // Manual MorphoWrapper query mode
    const [wrapperAddress, assetAddress] = args;
    if (wrapperAddress && assetAddress) {
      console.log(`🎯 Manual MorphoWrapper Query Mode`);
      await queryMorphoWrapper(wrapperAddress, assetAddress);
      return;
    }
  } else if (args.length === 1) {
    console.error("❌ Error: Invalid arguments");
    console.error("Usage:");
    console.error("  Show all oracles: yarn hardhat run scripts/oracle/show_oracle_prices.ts");
    console.error("  Morpho only: yarn hardhat run scripts/oracle/show_oracle_prices.ts -- --morpho-only");
    console.error("  Manual query: yarn hardhat run scripts/oracle/show_oracle_prices.ts -- <wrapperAddress> <assetAddress>");
    process.exit(1);
  }

  // Default mode: run the regular oracle price scanning + auto-discover Morpho wrappers
  // 1. Load all deployments for the current network via hardhat-deploy
  const deployments = await hre.deployments.all();
  const networkName = hre.network.name;

  console.log(`\n🔍 Custom Oracle Prices for ${networkName}`);
  console.log("============================================================\n");

  // Minimal ABI for Chainlink-style aggregator or our wrappers (they follow the same interface)
  const AGGREGATOR_ABI = [
    "function decimals() view returns (uint8)",
    "function description() view returns (string)",
    "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  ];

  const entries = Object.entries(deployments);

  // Helper to decide whether a deployment looks like an oracle (naive pattern match)
  const looksLikeOracle = (name: string): boolean =>
    /Oracle|Wrapper|Converter|HardPegOracle|Aggregator/i.test(name);

  for (const [name, deployment] of entries) {
    if (!looksLikeOracle(name)) {
      continue; // skip non-oracle contracts early
    }

    const typedDeployment = deployment as { address?: string };
    const { address } = typedDeployment;

    if (!address || address === ethers.ZeroAddress) {
      continue;
    }

    try {
      const aggregator = await ethers.getContractAt(AGGREGATOR_ABI, address);

      // These calls are read-only and inexpensive
      const [decimals, description] = await Promise.all([
        aggregator.decimals(),
        aggregator.description().catch(() => ""),
      ]);

      // latestRoundData returns (uint80,int256,uint256,uint256,uint80)
      const [, answer, , updatedAt] = await aggregator.latestRoundData();

      const priceHuman = ethers.formatUnits(answer, decimals);
      const updatedIso = new Date(Number(updatedAt) * 1000).toISOString();

      console.log(`${name} @ ${address}`);
      console.log(`  description : ${description}`);
      console.log(`  decimals    : ${decimals}`);
      console.log(`  price       : ${priceHuman}`);
      console.log(`  updatedAt   : ${updatedIso}`);
      console.log(
        "------------------------------------------------------------",
      );
    } catch (err) {
      // The contract might not conform to the interface – skip quietly.
      // Uncomment next line for troubleshooting.
      // console.warn(`Skipping ${name}: ${(err as Error).message}`);
    }
  }

  // After raw oracle printout, show aggregator prices
  await dumpAggregatorPrices();

  // Also auto-discover and query Morpho wrappers
  await queryAllMorphoWrappers();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
