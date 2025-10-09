import { ethers } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

import { getConfig } from "../../config/config";
import { DStakeInstanceConfig } from "../../config/types";
import { POOL_ADDRESSES_PROVIDER_ID } from "../../typescript/deploy-ids";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deploy, getOrNull } = deployments;
  const { deployer } = await getNamedAccounts();

  const config = await getConfig(hre);

  if (!config.dStake) {
    console.log("No dStake configuration found for this network. Skipping adapters.");
    return;
  }

  // Fetch dLend PoolAddressesProvider address if needed by any adapter
  let dLendAddressesProviderAddress = "";
  const dLendProvider = await deployments.getOrNull(POOL_ADDRESSES_PROVIDER_ID);

  if (dLendProvider) {
    dLendAddressesProviderAddress = dLendProvider.address;
  }

  // Validate all configs before deploying anything
  const validInstances: string[] = [];

  for (const instanceKey in config.dStake) {
    const instanceConfig = config.dStake[instanceKey] as DStakeInstanceConfig;

    if (!instanceConfig.dStable || instanceConfig.dStable === ethers.ZeroAddress) {
      throw new Error(`Missing dStable address for dSTAKE instance ${instanceKey}`);
    }

    if (!instanceConfig.symbol) {
      throw new Error(`Missing symbol for dSTAKE instance ${instanceKey}`);
    }

    let hasDeployableAdapter = false;

    for (const adapterConfig of instanceConfig.adapters) {
      if (!adapterConfig.adapterContract) {
        throw new Error(`Missing adapterContract for adapter in dSTAKE instance ${instanceKey}`);
      }

      if (!adapterConfig.strategyShare || adapterConfig.strategyShare === ethers.ZeroAddress) {
        console.log(
          `⚠️  Strategy share missing for adapter ${adapterConfig.adapterContract} in ${instanceKey} (deployment will be skipped for this adapter)`
        );
        continue;
      }

      // dLendConversionAdapter requires dLendAddressesProvider
      if (adapterConfig.adapterContract === "dLendConversionAdapter" && !dLendAddressesProviderAddress) {
        console.log(
          `⚠️  Skipping dSTAKE instance ${instanceKey}: dLend PoolAddressesProvider not found for ${adapterConfig.adapterContract}`
        );
        continue;
      }

      hasDeployableAdapter = true;
    }

    if (hasDeployableAdapter) {
      validInstances.push(instanceKey);
    }
  }

  // All configs are valid, proceed with adapter deployment
  for (const instanceKey of validInstances) {
    const instanceConfig = config.dStake[instanceKey] as DStakeInstanceConfig;
    const dStableSymbol = instanceConfig.symbol;

    // We need references to the router and collateral vault
    const collateralVaultDeploymentName = `DStakeCollateralVaultV2_${instanceKey}`;

    // Get the collateral vault address from deployment
    const collateralVault = await deployments.getOrNull(collateralVaultDeploymentName);

    if (!collateralVault) {
      console.log(`    Error: ${collateralVaultDeploymentName} not found. Make sure dStakeCore is deployed first.`);
      continue;
    }

    for (const adapterConfig of instanceConfig.adapters) {
      const { adapterContract } = adapterConfig;
      let { strategyShare } = adapterConfig;

      if (!strategyShare || strategyShare === ethers.ZeroAddress) {
        if (adapterContract === "GenericERC4626ConversionAdapter") {
          const idleVaultDeployment = await getOrNull(`DStakeIdleVault_${instanceKey}`);

          if (idleVaultDeployment) {
            strategyShare = idleVaultDeployment.address;
          }
        }
      }

      if (!strategyShare || strategyShare === ethers.ZeroAddress) {
        console.log(
          `    ⚠️  Skipping ${instanceKey}: Missing strategyShare for adapter ${adapterContract} (likely due to prerequisite deployments not being available)`
        );
        continue;
      }

      const deploymentName = `${adapterContract}_${dStableSymbol}`;
      const existingAdapter = await getOrNull(deploymentName);

      if (existingAdapter) {
        console.log(`    ${deploymentName} already exists at ${existingAdapter.address}. Skipping deployment.`);
        continue;
      }

      if (adapterContract === "MetaMorphoConversionAdapter") {
        await deploy(deploymentName, {
          from: deployer,
          contract: adapterContract,
          args: [instanceConfig.dStable, strategyShare, collateralVault.address, deployer],
          log: true,
        });
        continue;
      }

      if (adapterContract === "GenericERC4626ConversionAdapter") {
        await deploy(deploymentName, {
          from: deployer,
          contract: adapterContract,
          args: [instanceConfig.dStable, strategyShare, collateralVault.address],
          log: true,
        });
        continue;
      }

      if (adapterContract === "WrappedDLendConversionAdapter") {
        await deploy(deploymentName, {
          from: deployer,
          contract: adapterContract,
          args: [instanceConfig.dStable, strategyShare, collateralVault.address],
          log: true,
        });
        continue;
      }

      console.log(`    ⚠️  Adapter ${adapterContract} is not recognised by the deployment script. Skipping.`);
    }
  }

  console.log(`🥩 ${__filename.split("/").slice(-2).join("/")}: ✅`);
};

export default func;
func.tags = ["dStakeAdapters", "dStake"];
func.dependencies = ["dStakeCore", "dStakeIdleVaults", "dLendCore", "dUSD-aTokenWrapper", "dS-aTokenWrapper"];

// Ensure one-shot execution.
func.id = "deploy_dstake_adapters";
