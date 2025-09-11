import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

import { getConfig } from "../../config/config";
import { ETH_ORACLE_AGGREGATOR_ID } from "../../typescript/deploy-ids";
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

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment): Promise<boolean> {
  const { deployer } = await hre.getNamedAccounts();
  const deployerSigner = await hre.ethers.getSigner(deployer);

  const config = await getConfig(hre);
  const executor = new GovernanceExecutor(hre, deployerSigner, config.safeConfig);
  await executor.initialize();

  console.log(`\n🎯 Pointing ETH OracleAggregator to ERC4626OracleWrappers`);
  console.log("============================================================");

  // Get ETH OracleAggregator contract
  const oracleAggregatorDeployment = await hre.deployments.get(ETH_ORACLE_AGGREGATOR_ID);
  const oracleAggregator = await hre.ethers.getContractAt("OracleAggregator", oracleAggregatorDeployment.address);

  console.log(`📍 ETH OracleAggregator: ${oracleAggregatorDeployment.address}`);

  // Get ETH ERC4626 oracle wrapper configurations
  const ethConfig = config.oracleAggregators.ETH;
  const erc4626Configs = ethConfig?.erc4626OracleWrapper || {};

  if (Object.keys(erc4626Configs).length === 0) {
    console.log("No ERC4626OracleWrapper configurations found, skipping pointing");
    return true;
  }

  let allComplete = true;

  // Point each vault to its corresponding ERC4626OracleWrapper
  for (const [vaultAddress, vaultConfig] of Object.entries(erc4626Configs)) {
    const typedVaultConfig = vaultConfig as {
      vaultAddress: string;
      vaultName: string;
      initialMaxDeviation: number;
      minShareSupply: bigint;
      underlyingAsset: string;
      baseCurrencyUnit: bigint;
    };

    const deploymentId = `ERC4626OracleWrapper_${typedVaultConfig.vaultName}_ETH`;

    console.log(`\n🔗 Setting up ${typedVaultConfig.vaultName}:`);

    // Get the deployed ERC4626OracleWrapper address
    let wrapperAddress: string;

    try {
      const wrapperDeployment = await hre.deployments.get(deploymentId);
      wrapperAddress = wrapperDeployment.address;
      console.log(`  📍 ${deploymentId}: ${wrapperAddress}`);
    } catch {
      console.warn(`  ⚠️  ${deploymentId} not deployed, skipping`);
      continue;
    }

    const assetName = typedVaultConfig.vaultName;

    console.log(`  🔗 Pointing ${assetName} (${vaultAddress}) to ${deploymentId}...`);

    const complete = await executor.tryOrQueue(
      async () => {
        await oracleAggregator.setOracle(vaultAddress, wrapperAddress);
        console.log(`    ✅ Set oracle for ${assetName} to ${wrapperAddress}`);
      },
      () => createSetOracleTransaction(oracleAggregatorDeployment.address, vaultAddress, wrapperAddress, oracleAggregator.interface)
    );

    if (!complete) {
      console.log(`    🔄 Pending governance approval for ${assetName} oracle setting`);
      allComplete = false;
    }

    // Verify the setting (if completed immediately)
    if (complete) {
      try {
        const currentOracle = await oracleAggregator.assetOracles(vaultAddress);

        if (currentOracle === wrapperAddress) {
          console.log(`    ✅ Verified: ${assetName} oracle correctly set`);
        } else {
          console.warn(`    ⚠️  ${assetName} oracle not set correctly (expected: ${wrapperAddress}, got: ${currentOracle})`);
        }
      } catch {
        console.warn(`    ⚠️  Could not verify ${assetName} oracle setting`);
      }
    }
  }

  // Flush any queued Safe transactions
  if (!allComplete && executor.useSafe) {
    const flushed = await executor.flush(`ETH Oracle Aggregator ERC4626 Pointing - ${new Date().toISOString()}`);

    if (flushed) {
      console.log(`\n🔄 Safe transaction batch queued for governance approval`);
      console.log(`   Review and approve in the Safe UI to complete oracle pointing`);
    }
  }

  if (allComplete) {
    console.log(`\n✅ All ERC4626 vaults successfully pointed to their oracle wrappers`);
  } else {
    console.log(`\n🔄 Some oracle pointings are pending governance approval`);
  }

  console.log(`🔮 ${__filename.split("/").slice(-2).join("/")}: ✅`);
  return true;
};

func.tags = ["oracle-governance", "eth-oracle-aggregator", "erc4626-pointing"];
func.dependencies = ["deploy-yvvbETH-erc4626-wrappers"];
func.id = "point-eth-aggregator-to-erc4626-wrappers";

export default func;
