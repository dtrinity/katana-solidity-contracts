import { deployments, getNamedAccounts } from "hardhat";
import hre from "hardhat";

import { getConfig } from "../../config/config";
import {
  API3CompositeWrapperWithThresholding,
  API3Wrapper,
  API3WrapperWithThresholding,
  RedstoneChainlinkCompositeWrapperWithThresholding,
  RedstoneChainlinkWrapper,
  RedstoneChainlinkWrapperWithThresholding,
} from "../../typechain-types";
import {
  ETH_API3_COMPOSITE_WRAPPER_WITH_THRESHOLDING_ID,
  ETH_API3_ORACLE_WRAPPER_ID,
  ETH_API3_WRAPPER_WITH_THRESHOLDING_ID,
  ETH_REDSTONE_COMPOSITE_WRAPPER_WITH_THRESHOLDING_ID,
  ETH_REDSTONE_ORACLE_WRAPPER_ID,
  ETH_REDSTONE_WRAPPER_WITH_THRESHOLDING_ID,
  USD_API3_COMPOSITE_WRAPPER_WITH_THRESHOLDING_ID,
  USD_API3_ORACLE_WRAPPER_ID,
  USD_API3_WRAPPER_WITH_THRESHOLDING_ID,
  USD_REDSTONE_COMPOSITE_WRAPPER_WITH_THRESHOLDING_ID,
  USD_REDSTONE_ORACLE_WRAPPER_ID,
  USD_REDSTONE_WRAPPER_WITH_THRESHOLDING_ID,
} from "../../typescript/deploy-ids";

/**
 * Result interface for oracle aggregator fixtures
 */
export interface OracleAggregatorFixtureResult {
  contracts: {
    redstoneChainlinkWrapper: RedstoneChainlinkWrapper;
    redstoneChainlinkWrapperWithThresholding: RedstoneChainlinkWrapperWithThresholding;
    redstoneChainlinkCompositeWrapperWithThresholding: RedstoneChainlinkCompositeWrapperWithThresholding;
    api3Wrapper: API3Wrapper;
    api3WrapperWithThresholding: API3WrapperWithThresholding;
    api3CompositeWrapperWithThresholding: API3CompositeWrapperWithThresholding;
  };
  assets: {
    redstonePlainAssets: { [address: string]: { feed: string } };
    redstoneThresholdAssets: {
      [address: string]: {
        feed: string;
        lowerThreshold: bigint;
        fixedPrice: bigint;
      };
    };
    redstoneCompositeAssets: {
      [address: string]: {
        feedAsset: string;
        feed1: string;
        feed2: string;
        lowerThresholdInBase1: bigint;
        fixedPriceInBase1: bigint;
        lowerThresholdInBase2: bigint;
        fixedPriceInBase2: bigint;
      };
    };
    api3PlainAssets: { [address: string]: { proxy: string } };
    api3ThresholdAssets: {
      [address: string]: {
        proxy: string;
        lowerThreshold: bigint;
        fixedPrice: bigint;
      };
    };
    api3CompositeAssets: {
      [address: string]: {
        feedAsset: string;
        proxy1: string;
        proxy2: string;
        lowerThresholdInBase1: bigint;
        fixedPriceInBase1: bigint;
        lowerThresholdInBase2: bigint;
        fixedPriceInBase2: bigint;
      };
    };
  };
  config: {
    priceDecimals: number;
    hardDStablePeg: bigint;
    baseCurrency: string;
  };
}

/**
 * Get oracle aggregator fixture for a specific currency
 * @param currency - The currency to get fixtures for (e.g., "USD", "S")
 * @returns A fixture function that deploys and configures oracle aggregator contracts
 */
export async function getOracleAggregatorFixture(currency: string) {
  return deployments.createFixture(
    async ({ deployments }): Promise<OracleAggregatorFixtureResult> => {
      // Run deployments to ensure oracle aggregators and wrappers are deployed
      await deployments.fixture(["oracle-aggregator"]);
      
      // Get the current network configuration
      const config = await getConfig(hre);
      const oracleConfig = config.oracleAggregators[currency];
      
      if (!oracleConfig) {
        throw new Error(`Oracle aggregator config not found for currency: ${currency}`);
      }

      // Get contract instances based on currency
      let wrapperIds: {
        wrapper: string;
        wrapperWithThresholding: string;
        compositeWrapperWithThresholding: string;
        api3Wrapper: string;
        api3WrapperWithThresholding: string;
        api3CompositeWrapperWithThresholding: string;
      };

      if (currency === "USD") {
        wrapperIds = {
          wrapper: USD_REDSTONE_ORACLE_WRAPPER_ID,
          wrapperWithThresholding: USD_REDSTONE_WRAPPER_WITH_THRESHOLDING_ID,
          compositeWrapperWithThresholding: USD_REDSTONE_COMPOSITE_WRAPPER_WITH_THRESHOLDING_ID,
          api3Wrapper: USD_API3_ORACLE_WRAPPER_ID,
          api3WrapperWithThresholding: USD_API3_WRAPPER_WITH_THRESHOLDING_ID,
          api3CompositeWrapperWithThresholding: USD_API3_COMPOSITE_WRAPPER_WITH_THRESHOLDING_ID,
        };
      } else if (currency === "S" || currency === "ETH") {
        // Use ETH oracle wrappers (S is legacy, kept for compatibility)
        wrapperIds = {
          wrapper: ETH_REDSTONE_ORACLE_WRAPPER_ID,
          wrapperWithThresholding: ETH_REDSTONE_WRAPPER_WITH_THRESHOLDING_ID,
          compositeWrapperWithThresholding: ETH_REDSTONE_COMPOSITE_WRAPPER_WITH_THRESHOLDING_ID,
          api3Wrapper: ETH_API3_ORACLE_WRAPPER_ID,
          api3WrapperWithThresholding: ETH_API3_WRAPPER_WITH_THRESHOLDING_ID,
          api3CompositeWrapperWithThresholding: ETH_API3_COMPOSITE_WRAPPER_WITH_THRESHOLDING_ID,
        };
      } else {
        throw new Error(`Unsupported currency: ${currency}. Only USD, S, and ETH are supported.`);
      }

      // Get deployments - they should exist now after running fixture
      let wrapperDeployment, wrapperWithThresholdingDeployment, compositeWrapperWithThresholdingDeployment;
      let api3WrapperDeployment, api3WrapperWithThresholdingDeployment, api3CompositeWrapperWithThresholdingDeployment;
      
      try {
        wrapperDeployment = await hre.deployments.get(wrapperIds.wrapper);
        wrapperWithThresholdingDeployment = await hre.deployments.get(
          wrapperIds.wrapperWithThresholding,
        );
        compositeWrapperWithThresholdingDeployment = await hre.deployments.get(
          wrapperIds.compositeWrapperWithThresholding,
        );
        api3WrapperDeployment = await hre.deployments.get(wrapperIds.api3Wrapper);
        api3WrapperWithThresholdingDeployment = await hre.deployments.get(
          wrapperIds.api3WrapperWithThresholding,
        );
        api3CompositeWrapperWithThresholdingDeployment = await hre.deployments.get(
          wrapperIds.api3CompositeWrapperWithThresholding,
        );
      } catch (error) {
        throw new Error(
          `Oracle aggregator integration tests require deployed oracle wrappers. ` +
          `Please run deployment scripts first or use a network with pre-deployed contracts. ` +
          `Missing deployment: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      const redstoneChainlinkWrapper = await hre.ethers.getContractAt(
        "RedstoneChainlinkWrapper",
        wrapperDeployment.address,
      ) as RedstoneChainlinkWrapper;

      const redstoneChainlinkWrapperWithThresholding = await hre.ethers.getContractAt(
        "RedstoneChainlinkWrapperWithThresholding",
        wrapperWithThresholdingDeployment.address,
      ) as RedstoneChainlinkWrapperWithThresholding;

      const redstoneChainlinkCompositeWrapperWithThresholding = await hre.ethers.getContractAt(
        "RedstoneChainlinkCompositeWrapperWithThresholding",
        compositeWrapperWithThresholdingDeployment.address,
      ) as RedstoneChainlinkCompositeWrapperWithThresholding;

      const api3Wrapper = await hre.ethers.getContractAt(
        "API3Wrapper",
        api3WrapperDeployment.address,
      ) as API3Wrapper;

      const api3WrapperWithThresholding = await hre.ethers.getContractAt(
        "API3WrapperWithThresholding",
        api3WrapperWithThresholdingDeployment.address,
      ) as API3WrapperWithThresholding;

      const api3CompositeWrapperWithThresholding = await hre.ethers.getContractAt(
        "API3CompositeWrapperWithThresholding",
        api3CompositeWrapperWithThresholdingDeployment.address,
      ) as API3CompositeWrapperWithThresholding;

      // Build assets from config
      const redstonePlainAssets: { [address: string]: { feed: string } } = {};
      const redstoneThresholdAssets: {
        [address: string]: {
          feed: string;
          lowerThreshold: bigint;
          fixedPrice: bigint;
        };
      } = {};
      const redstoneCompositeAssets: {
        [address: string]: {
          feedAsset: string;
          feed1: string;
          feed2: string;
          lowerThresholdInBase1: bigint;
          fixedPriceInBase1: bigint;
          lowerThresholdInBase2: bigint;
          fixedPriceInBase2: bigint;
        };
      } = {};
      
      const api3PlainAssets: { [address: string]: { proxy: string } } = {};
      const api3ThresholdAssets: {
        [address: string]: {
          proxy: string;
          lowerThreshold: bigint;
          fixedPrice: bigint;
        };
      } = {};
      const api3CompositeAssets: {
        [address: string]: {
          feedAsset: string;
          proxy1: string;
          proxy2: string;
          lowerThresholdInBase1: bigint;
          fixedPriceInBase1: bigint;
          lowerThresholdInBase2: bigint;
          fixedPriceInBase2: bigint;
        };
      } = {};

      // Extract plain redstone assets
      for (const [assetAddress, feedAddress] of Object.entries(
        oracleConfig.redstoneOracleAssets.plainRedstoneOracleWrappers,
      )) {
        if (assetAddress && feedAddress) {
          redstonePlainAssets[assetAddress] = { feed: feedAddress };
        }
      }

      // Extract threshold assets
      for (const [assetAddress, assetConfig] of Object.entries(
        oracleConfig.redstoneOracleAssets.redstoneOracleWrappersWithThresholding,
      )) {
        if (assetAddress && assetConfig.feed) {
          redstoneThresholdAssets[assetAddress] = {
            feed: assetConfig.feed,
            lowerThreshold: assetConfig.lowerThreshold,
            fixedPrice: assetConfig.fixedPrice,
          };
        }
      }

      // Extract composite assets
      for (const [assetAddress, assetConfig] of Object.entries(
        oracleConfig.redstoneOracleAssets.compositeRedstoneOracleWrappersWithThresholding,
      )) {
        if (assetAddress && assetConfig.feed1 && assetConfig.feed2) {
          redstoneCompositeAssets[assetAddress] = {
            feedAsset: assetConfig.feedAsset,
            feed1: assetConfig.feed1,
            feed2: assetConfig.feed2,
            lowerThresholdInBase1: assetConfig.lowerThresholdInBase1,
            fixedPriceInBase1: assetConfig.fixedPriceInBase1,
            lowerThresholdInBase2: assetConfig.lowerThresholdInBase2,
            fixedPriceInBase2: assetConfig.fixedPriceInBase2,
          };
        }
      }

      // Extract plain API3 assets
      for (const [assetAddress, proxyAddress] of Object.entries(
        oracleConfig.api3OracleAssets.plainApi3OracleWrappers,
      )) {
        if (assetAddress && proxyAddress) {
          api3PlainAssets[assetAddress] = { proxy: proxyAddress };
        }
      }

      // Extract API3 threshold assets
      for (const [assetAddress, assetConfig] of Object.entries(
        oracleConfig.api3OracleAssets.api3OracleWrappersWithThresholding,
      )) {
        if (assetAddress && assetConfig.proxy) {
          api3ThresholdAssets[assetAddress] = {
            proxy: assetConfig.proxy,
            lowerThreshold: assetConfig.lowerThreshold,
            fixedPrice: assetConfig.fixedPrice,
          };
        }
      }

      // Extract API3 composite assets
      for (const [assetAddress, assetConfig] of Object.entries(
        oracleConfig.api3OracleAssets.compositeApi3OracleWrappersWithThresholding,
      )) {
        if (assetAddress && assetConfig.proxy1 && assetConfig.proxy2) {
          api3CompositeAssets[assetAddress] = {
            feedAsset: assetConfig.feedAsset,
            proxy1: assetConfig.proxy1,
            proxy2: assetConfig.proxy2,
            lowerThresholdInBase1: assetConfig.lowerThresholdInBase1,
            fixedPriceInBase1: assetConfig.fixedPriceInBase1,
            lowerThresholdInBase2: assetConfig.lowerThresholdInBase2,
            fixedPriceInBase2: assetConfig.fixedPriceInBase2,
          };
        }
      }

      return {
        contracts: {
          redstoneChainlinkWrapper,
          redstoneChainlinkWrapperWithThresholding,
          redstoneChainlinkCompositeWrapperWithThresholding,
          api3Wrapper,
          api3WrapperWithThresholding,
          api3CompositeWrapperWithThresholding,
        },
        assets: {
          redstonePlainAssets,
          redstoneThresholdAssets,
          redstoneCompositeAssets,
          api3PlainAssets,
          api3ThresholdAssets,
          api3CompositeAssets,
        },
        config: {
          priceDecimals: oracleConfig.priceDecimals,
          hardDStablePeg: oracleConfig.hardDStablePeg,
          baseCurrency: oracleConfig.baseCurrency,
        },
      };
    },
  );
}

/**
 * Utility function to get a random item from a list
 * @param items - Array of items to choose from
 * @returns A random item from the array
 */
export function getRandomItemFromList<T>(items: T[]): T {
  if (items.length === 0) {
    throw new Error("Cannot get random item from empty list");
  }
  const randomIndex = Math.floor(Math.random() * items.length);
  return items[randomIndex];
}