import { ethers } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

import { getConfig } from "../../config/config";
import { DStakeInstanceConfig } from "../../config/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const config = await getConfig(hre);

  if (!config.dStake) {
    console.log("No dStake configuration found for this network. Skipping DStakeRouterMorpho deployment.");
    return;
  }

  if (!config.morpho) {
    console.log("No Morpho configuration found for this network. Skipping DStakeRouterMorpho deployment.");
    return;
  }

  // First, deploy the libraries that DStakeRouterMorpho depends on
  console.log("📚 Deploying DStakeRouterMorpho libraries...");

  // Deploy DeterministicVaultSelector library
  const deterministicVaultSelectorDeployment = await deploy("DeterministicVaultSelector", {
    from: deployer,
    contract: "DeterministicVaultSelector",
    log: true,
  });

  // Deploy AllocationCalculator library
  const allocationCalculatorDeployment = await deploy("AllocationCalculator", {
    from: deployer,
    contract: "AllocationCalculator",
    log: true,
  });

  // Validate all configs before deploying anything
  for (const instanceKey in config.dStake) {
    const instanceConfig = config.dStake[instanceKey] as DStakeInstanceConfig;

    if (!instanceConfig.dStable || instanceConfig.dStable === ethers.ZeroAddress) {
      throw new Error(`Missing dStable address for dSTAKE instance ${instanceKey}`);
    }

    if (!instanceConfig.symbol) {
      throw new Error(`Missing symbol for dSTAKE instance ${instanceKey}`);
    }

    if (!instanceConfig.name) {
      throw new Error(`Missing name for dSTAKE instance ${instanceKey}`);
    }

    if (!instanceConfig.initialAdmin || instanceConfig.initialAdmin === ethers.ZeroAddress) {
      throw new Error(`Missing initialAdmin for dSTAKE instance ${instanceKey}`);
    }

    if (!instanceConfig.initialFeeManager || instanceConfig.initialFeeManager === ethers.ZeroAddress) {
      throw new Error(`Missing initialFeeManager for dSTAKE instance ${instanceKey}`);
    }

    if (typeof instanceConfig.initialWithdrawalFeeBps !== "number") {
      throw new Error(`Missing initialWithdrawalFeeBps for dSTAKE instance ${instanceKey}`);
    }

    if (!instanceConfig.adapters || !Array.isArray(instanceConfig.adapters)) {
      throw new Error(`Missing adapters array for dSTAKE instance ${instanceKey}`);
    }

    if (!instanceConfig.collateralExchangers || !Array.isArray(instanceConfig.collateralExchangers)) {
      throw new Error(`Missing collateralExchangers array for dSTAKE instance ${instanceKey}`);
    }
  }

  // Deploy DStakeRouterMorpho for each dSTAKE instance
  for (const instanceKey in config.dStake) {
    const _instanceConfig = config.dStake[instanceKey] as DStakeInstanceConfig;
    const morphoRouterDeploymentName = `DStakeRouterMorpho_${instanceKey}`;

    // Check if already deployed to avoid redeployment on mainnet
    const existingMorphoRouter = await deployments.getOrNull(morphoRouterDeploymentName);

    if (existingMorphoRouter) {
      console.log(`DStakeRouterMorpho for ${instanceKey} already deployed at ${existingMorphoRouter.address}. Skipping deployment.`);
      continue;
    }

    // Get required deployed contracts
    const dstakeTokenDeployment = await deployments.get(`DStakeToken_${instanceKey}`);
    const collateralVaultDeployment = await deployments.get(`DStakeCollateralVault_${instanceKey}`);

    console.log(`🚀 Deploying DStakeRouterMorpho for ${instanceKey}...`);

    const morphoRouterDeployment = await deploy(morphoRouterDeploymentName, {
      from: deployer,
      contract: "DStakeRouterMorpho",
      args: [dstakeTokenDeployment.address, collateralVaultDeployment.address],
      libraries: {
        DeterministicVaultSelector: deterministicVaultSelectorDeployment.address,
        AllocationCalculator: allocationCalculatorDeployment.address,
      },
      log: true,
    });

    // Grant necessary roles to deployer for configuration scripts to work
    const deployerSigner = await ethers.getSigner(deployer);
    const morphoRouterContract = await ethers.getContractAt("DStakeRouterMorpho", morphoRouterDeployment.address, deployerSigner);

    // Grant VAULT_MANAGER_ROLE, CONFIG_MANAGER_ROLE, and PAUSER_ROLE to deployer
    const VAULT_MANAGER_ROLE = await morphoRouterContract.VAULT_MANAGER_ROLE();
    const CONFIG_MANAGER_ROLE = await morphoRouterContract.CONFIG_MANAGER_ROLE();
    const PAUSER_ROLE = await morphoRouterContract.PAUSER_ROLE();

    const hasVaultRole = await morphoRouterContract.hasRole(VAULT_MANAGER_ROLE, deployer);
    const hasConfigRole = await morphoRouterContract.hasRole(CONFIG_MANAGER_ROLE, deployer);
    const hasPauserRole = await morphoRouterContract.hasRole(PAUSER_ROLE, deployer);

    if (!hasVaultRole) {
      await morphoRouterContract.grantRole(VAULT_MANAGER_ROLE, deployer);
    }

    if (!hasConfigRole) {
      await morphoRouterContract.grantRole(CONFIG_MANAGER_ROLE, deployer);
    }

    if (!hasPauserRole) {
      await morphoRouterContract.grantRole(PAUSER_ROLE, deployer);
    }

    console.log(`✅ Deployed DStakeRouterMorpho for ${instanceKey} at ${morphoRouterDeployment.address}`);
  }

  console.log(`🥩 ${__filename.split("/").slice(-2).join("/")}: ✅`);
};

export default func;
func.tags = ["dStakeMorphoRouter", "dStake", "morpho"];
func.dependencies = ["dStakeCore", "dStakeAdapters", "metamorpho-adapters"];

// Mark script as executed so it won't run again
func.id = "deploy_morpho_router";

// Skip if already deployed (safety for mainnet)
func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const { deployments } = hre;
  const config = await getConfig(hre);

  if (!config.dStake || !config.morpho) return true;

  // Check if all DStakeRouterMorpho instances are deployed
  for (const instanceKey in config.dStake) {
    const morphoRouterDeploymentName = `DStakeRouterMorpho_${instanceKey}`;
    const existingRouter = await deployments.getOrNull(morphoRouterDeploymentName);

    if (!existingRouter) {
      return false; // At least one router is missing, allow script to run
    }
  }

  // All routers deployed, skip script
  return true;
};
