import { ethers } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

import { getConfig } from "../../config/config";
import { DStakeInstanceConfig } from "../../config/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deploy, getOrNull } = deployments;
  const { deployer } = await getNamedAccounts();

  const config = await getConfig(hre);

  if (!config.dStake) {
    console.log("No dStake configuration found for this network. Skipping idle vault deployment.");
    return;
  }

  for (const instanceKey in config.dStake) {
    const instanceConfig = config.dStake[instanceKey] as DStakeInstanceConfig;
    const idleConfig = instanceConfig.idleVault;

    if (!idleConfig) {
      continue;
    }

    if (!instanceConfig.dStable || instanceConfig.dStable === ethers.ZeroAddress) {
      throw new Error(`Missing dStable address for dSTAKE instance ${instanceKey}`);
    }

    const deploymentName = `DStakeIdleVault_${instanceKey}`;
    const existingDeployment = await getOrNull(deploymentName);

    if (existingDeployment) {
      console.log(`DStakeIdleVault for ${instanceKey} already deployed at ${existingDeployment.address}. Skipping.`);
      continue;
    }

    const name = idleConfig.name ?? `${instanceConfig.name} Idle Vault`;
    const symbol = idleConfig.symbol ?? `idle${instanceConfig.symbol}`;
    const admin = idleConfig.admin ?? instanceConfig.initialAdmin ?? deployer;
    const rewardManager = idleConfig.rewardManager ?? admin;

    if (!admin || admin === ethers.ZeroAddress) {
      throw new Error(`Invalid admin for idle vault ${instanceKey}`);
    }

    if (!rewardManager || rewardManager === ethers.ZeroAddress) {
      throw new Error(`Invalid reward manager for idle vault ${instanceKey}`);
    }

    console.log(`🚀 Deploying DStakeIdleVault for ${instanceKey}...`);

    const deployment = await deploy(deploymentName, {
      from: deployer,
      contract: "DStakeIdleVault",
      args: [instanceConfig.dStable, name, symbol, admin, rewardManager],
      log: true,
    });

    console.log(`✅ DStakeIdleVault for ${instanceKey} deployed at ${deployment.address}`);

    if (
      idleConfig.emissionPerSecond !== undefined &&
      idleConfig.emissionStart !== undefined &&
      idleConfig.emissionEnd !== undefined &&
      rewardManager.toLowerCase() === deployer.toLowerCase()
    ) {
      const idleVault = await ethers.getContractAt("DStakeIdleVault", deployment.address, await ethers.getSigner(deployer));

      try {
        await idleVault.setEmissionSchedule(idleConfig.emissionStart, idleConfig.emissionEnd, BigInt(idleConfig.emissionPerSecond));
        console.log(`    ⚙️ Set initial emission schedule for ${instanceKey}`);
      } catch (error) {
        console.warn(`    ⚠️ Unable to set emission schedule for ${instanceKey}:`, error);
      }
    }
  }

  console.log(`🥩 ${__filename.split("/").slice(-2).join("/")}: ✅`);
};

export default func;
func.tags = ["dStakeIdleVaults", "dStake"];
func.dependencies = ["dStakeCore"];
func.id = "deploy_dstake_idle_vaults";
