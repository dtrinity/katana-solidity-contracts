import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

import { getConfig } from "../../config/config";
import { USD_ORACLE_AGGREGATOR_ID } from "../../typescript/deploy-ids";
import { GovernanceExecutor } from "../../typescript/hardhat/governance";

/**
 * Helper function to create setOracle transaction data for Safe
 *
 * @param contractAddress The address of the OracleAggregator contract
 * @param assetAddress The asset address to set oracle for
 * @param oracleAddress The oracle wrapper address to set
 * @param contractInterface The contract interface for encoding function data
 * @returns Transaction data object for Safe
 */
function createSetOracleTransaction(
  contractAddress: string,
  assetAddress: string,
  oracleAddress: string,
  contractInterface: any
): { to: string; value: string; data: string } {
  return {
    to: contractAddress,
    value: "0",
    data: contractInterface.encodeFunctionData("setOracle", [assetAddress, oracleAddress]),
  };
}

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

  return `0x${assetAddress.slice(-8)}`;
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment): Promise<boolean> {
  const { deployer } = await hre.getNamedAccounts();
  const deployerSigner = await hre.ethers.getSigner(deployer);

  const config = await getConfig(hre);
  const executor = new GovernanceExecutor(hre, deployerSigner, config.safeConfig);
  await executor.initialize();

  console.log(`\n🎯 Pointing USD OracleAggregator to OracleWrapperAggregators`);
  console.log("============================================================");

  // Get USD OracleAggregator contract
  const oracleAggregatorDeployment = await hre.deployments.get(USD_ORACLE_AGGREGATOR_ID);
  const oracleAggregator = await hre.ethers.getContractAt("OracleAggregator", oracleAggregatorDeployment.address);

  console.log(`📍 USD OracleAggregator: ${oracleAggregatorDeployment.address}`);

  // Get USD oracle wrapper aggregator configurations
  const usdConfig = config.oracleAggregators.USD;
  const aggregatorConfigs = usdConfig?.oracleWrapperAggregators || {};

  if (Object.keys(aggregatorConfigs).length === 0) {
    console.log("No OracleWrapperAggregator configurations found, skipping pointing");
    return true;
  }

  let allComplete = true;

  // Point each asset to its corresponding OracleWrapperAggregator
  for (const [groupKey, groupConfig] of Object.entries(aggregatorConfigs)) {
    const typedGroupConfig = groupConfig as {
      baseWrapperDeploymentId: string;
      quoteWrapperDeploymentId: string;
      baseCurrencyUnit: bigint;
      assets: string[];
    };

    const displayName = `${groupKey}_to_USD`;
    const deploymentId = `OracleWrapperAggregator_${displayName}`;

    console.log(`\n🔗 Setting up ${displayName} group:`);

    // Get the deployed aggregator address
    let aggregatorAddress: string;

    try {
      const aggregatorDeployment = await hre.deployments.get(deploymentId);
      aggregatorAddress = aggregatorDeployment.address;
      console.log(`  📍 ${deploymentId}: ${aggregatorAddress}`);
    } catch {
      console.warn(`  ⚠️  ${deploymentId} not deployed, skipping`);
      continue;
    }

    // Point each asset in this group to the aggregator
    for (const assetAddress of typedGroupConfig.assets) {
      const assetName = getAssetSymbol(assetAddress, config);

      console.log(`  🔗 Pointing ${assetName} (${assetAddress}) to ${deploymentId}...`);

      const complete = await executor.tryOrQueue(
        async () => {
          await oracleAggregator.setOracle(assetAddress, aggregatorAddress);
          console.log(`    ✅ Set oracle for ${assetName} to ${aggregatorAddress}`);
        },
        () => createSetOracleTransaction(oracleAggregatorDeployment.address, assetAddress, aggregatorAddress, oracleAggregator.interface)
      );

      if (!complete) {
        console.log(`    🔄 Pending governance approval for ${assetName} oracle setting`);
        allComplete = false;
      }

      // Verify the setting (if completed immediately)
      if (complete) {
        try {
          const currentOracle = await oracleAggregator.assetOracles(assetAddress);

          if (currentOracle === aggregatorAddress) {
            console.log(`    ✅ Verified: ${assetName} oracle correctly set`);
          } else {
            console.warn(`    ⚠️  ${assetName} oracle not set correctly (expected: ${aggregatorAddress}, got: ${currentOracle})`);
          }
        } catch {
          console.warn(`    ⚠️  Could not verify ${assetName} oracle setting`);
        }
      }
    }
  }

  // Flush any queued Safe transactions
  if (!allComplete && executor.useSafe) {
    const flushed = await executor.flush(`Oracle Aggregator Asset Pointing - ${new Date().toISOString()}`);

    if (flushed) {
      console.log(`\n🔄 Safe transaction batch queued for governance approval`);
      console.log(`   Review and approve in the Safe UI to complete oracle pointing`);
    }
  }

  if (allComplete) {
    console.log(`\n✅ All assets successfully pointed to their OracleWrapperAggregators`);
  } else {
    console.log(`\n🔄 Some oracle pointings are pending governance approval`);
  }

  console.log(`🔮 ${__filename.split("/").slice(-2).join("/")}: ✅`);
  return true;
};

func.tags = ["oracle-governance", "oracle-aggregator", "oracle-pointing"];
func.dependencies = ["deploy-usd-oracle-wrapper-aggregators"];
func.id = "point-usd-aggregator-to-oracle-wrapper-aggregators";

export default func;
