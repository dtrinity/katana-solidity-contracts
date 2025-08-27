import { Signer } from "ethers";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

import { getConfig } from "../../config/config";

/**
 * Grant new role-based access controls for DStakeRouterMorpho and DStakeRouter contracts.
 * This script adds the new granular roles introduced in the access control improvements:
 *
 * DStakeRouterMorpho:
 * - VAULT_MANAGER_ROLE for vault configuration functions
 * - CONFIG_MANAGER_ROLE for system parameters
 * - PAUSER_ROLE for emergency functions (already exists)
 *
 * DStakeRouter:
 * - ADAPTER_MANAGER_ROLE for adapter management
 * - CONFIG_MANAGER_ROLE for configuration
 *
 * @param hre Hardhat runtime environment
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, ethers } = hre;
  const { deployer } = await getNamedAccounts();
  const deployerSigner: Signer = await ethers.getSigner(deployer);

  // Load network configuration
  const config = await getConfig(hre);

  if (!config.dStake) {
    console.log("No dSTAKE instances configured – skipping role setup");
    return true;
  }

  for (const instanceKey of Object.keys(config.dStake)) {
    const instanceConfig = config.dStake[instanceKey];
    console.log(`\n🔐 Setting up new roles for dSTAKE instance ${instanceKey}…`);

    // --- DStakeRouter roles ---
    try {
      const routerDeployment = await deployments.getOrNull(`DStakeRouter_${instanceKey}`);

      if (routerDeployment) {
        console.log(`  📄 ROUTER ROLES: DStakeRouter_${instanceKey}`);
        const routerContract = await ethers.getContractAt("DStakeRouter", routerDeployment.address, deployerSigner);

        const ADAPTER_MANAGER_ROLE = await routerContract.ADAPTER_MANAGER_ROLE();
        const CONFIG_MANAGER_ROLE = await routerContract.CONFIG_MANAGER_ROLE();

        // Grant new roles to the configured admin
        if (!(await routerContract.hasRole(ADAPTER_MANAGER_ROLE, instanceConfig.initialAdmin))) {
          await routerContract.grantRole(ADAPTER_MANAGER_ROLE, instanceConfig.initialAdmin);
          console.log(`    ➕ Granted ADAPTER_MANAGER_ROLE to ${instanceConfig.initialAdmin}`);
        }

        if (!(await routerContract.hasRole(CONFIG_MANAGER_ROLE, instanceConfig.initialAdmin))) {
          await routerContract.grantRole(CONFIG_MANAGER_ROLE, instanceConfig.initialAdmin);
          console.log(`    ➕ Granted CONFIG_MANAGER_ROLE to ${instanceConfig.initialAdmin}`);
        }

        // Also grant to deployer temporarily for testing/configuration
        if (!(await routerContract.hasRole(ADAPTER_MANAGER_ROLE, deployer))) {
          await routerContract.grantRole(ADAPTER_MANAGER_ROLE, deployer);
          console.log(`    ➕ Granted ADAPTER_MANAGER_ROLE to deployer (temporary)`);
        }

        if (!(await routerContract.hasRole(CONFIG_MANAGER_ROLE, deployer))) {
          await routerContract.grantRole(CONFIG_MANAGER_ROLE, deployer);
          console.log(`    ➕ Granted CONFIG_MANAGER_ROLE to deployer (temporary)`);
        }
      } else {
        console.log(`  ⚠️ DStakeRouter_${instanceKey} not deployed, skipping router role setup`);
      }
    } catch (error) {
      console.error(`  ❌ Failed to setup DStakeRouter_${instanceKey} roles: ${error}`);
    }

    // --- DStakeRouterMorpho roles ---
    try {
      const morphoRouterDeployment = await deployments.getOrNull(`DStakeRouterMorpho_${instanceKey}`);

      if (morphoRouterDeployment) {
        console.log(`  📄 MORPHO ROUTER ROLES: DStakeRouterMorpho_${instanceKey}`);
        const morphoRouterContract = await ethers.getContractAt("DStakeRouterMorpho", morphoRouterDeployment.address, deployerSigner);

        const VAULT_MANAGER_ROLE = await morphoRouterContract.VAULT_MANAGER_ROLE();
        const CONFIG_MANAGER_ROLE = await morphoRouterContract.CONFIG_MANAGER_ROLE();
        const PAUSER_ROLE = await morphoRouterContract.PAUSER_ROLE();

        // Grant new roles to the configured admin
        if (!(await morphoRouterContract.hasRole(VAULT_MANAGER_ROLE, instanceConfig.initialAdmin))) {
          await morphoRouterContract.grantRole(VAULT_MANAGER_ROLE, instanceConfig.initialAdmin);
          console.log(`    ➕ Granted VAULT_MANAGER_ROLE to ${instanceConfig.initialAdmin}`);
        }

        if (!(await morphoRouterContract.hasRole(CONFIG_MANAGER_ROLE, instanceConfig.initialAdmin))) {
          await morphoRouterContract.grantRole(CONFIG_MANAGER_ROLE, instanceConfig.initialAdmin);
          console.log(`    ➕ Granted CONFIG_MANAGER_ROLE to ${instanceConfig.initialAdmin}`);
        }

        if (!(await morphoRouterContract.hasRole(PAUSER_ROLE, instanceConfig.initialAdmin))) {
          await morphoRouterContract.grantRole(PAUSER_ROLE, instanceConfig.initialAdmin);
          console.log(`    ➕ Granted PAUSER_ROLE to ${instanceConfig.initialAdmin}`);
        }

        // Also grant to deployer temporarily for testing/configuration
        if (!(await morphoRouterContract.hasRole(VAULT_MANAGER_ROLE, deployer))) {
          await morphoRouterContract.grantRole(VAULT_MANAGER_ROLE, deployer);
          console.log(`    ➕ Granted VAULT_MANAGER_ROLE to deployer (temporary)`);
        }

        if (!(await morphoRouterContract.hasRole(CONFIG_MANAGER_ROLE, deployer))) {
          await morphoRouterContract.grantRole(CONFIG_MANAGER_ROLE, deployer);
          console.log(`    ➕ Granted CONFIG_MANAGER_ROLE to deployer (temporary)`);
        }

        if (!(await morphoRouterContract.hasRole(PAUSER_ROLE, deployer))) {
          await morphoRouterContract.grantRole(PAUSER_ROLE, deployer);
          console.log(`    ➕ Granted PAUSER_ROLE to deployer (temporary)`);
        }
      } else {
        console.log(`  ⚠️ DStakeRouterMorpho_${instanceKey} not deployed, skipping morpho router role setup`);
      }
    } catch (error) {
      console.error(`  ❌ Failed to setup DStakeRouterMorpho_${instanceKey} roles: ${error}`);
    }

    // --- DStakeRewardManagerMetaMorpho roles ---
    // Note: This contract may not be deployed yet as it's not part of the current deployment scripts
    try {
      const rewardManagerDeployment = await deployments.getOrNull(`DStakeRewardManagerMetaMorpho_${instanceKey}`);

      if (rewardManagerDeployment) {
        console.log(`  📄 REWARD MANAGER ROLES: DStakeRewardManagerMetaMorpho_${instanceKey}`);
        const rewardManagerContract = await ethers.getContractAt(
          "DStakeRewardManagerMetaMorpho",
          rewardManagerDeployment.address,
          deployerSigner
        );

        const REWARDS_MANAGER_ROLE = await rewardManagerContract.REWARDS_MANAGER_ROLE();

        // Grant REWARDS_MANAGER_ROLE to configured admin
        if (!(await rewardManagerContract.hasRole(REWARDS_MANAGER_ROLE, instanceConfig.initialAdmin))) {
          await rewardManagerContract.grantRole(REWARDS_MANAGER_ROLE, instanceConfig.initialAdmin);
          console.log(`    ➕ Granted REWARDS_MANAGER_ROLE to ${instanceConfig.initialAdmin}`);
        }

        // Also grant to deployer temporarily for testing/configuration
        if (!(await rewardManagerContract.hasRole(REWARDS_MANAGER_ROLE, deployer))) {
          await rewardManagerContract.grantRole(REWARDS_MANAGER_ROLE, deployer);
          console.log(`    ➕ Granted REWARDS_MANAGER_ROLE to deployer (temporary)`);
        }
      } else {
        console.log(`  ⚠️ DStakeRewardManagerMetaMorpho_${instanceKey} not deployed, skipping reward manager role setup`);
      }
    } catch (error) {
      console.error(`  ❌ Failed to setup DStakeRewardManagerMetaMorpho_${instanceKey} roles: ${error}`);
      // Don't throw - this is optional since the contract may not be deployed
    }

    console.log(`  ✅ Completed role setup for ${instanceKey}`);
  }

  console.log(`\n🔑 ${__filename.split("/").slice(-2).join("/")}: ✅ Done\n`);
  return true;
};

export default func;
func.tags = ["dStakeNewRoles", "postDStake"];
func.dependencies = ["dStakeMorphoConfigure"];
func.runAtTheEnd = false;

// Unique identifier so Hardhat Deploy knows this script has executed when it
// returns `true` (skip behaviour).
func.id = "update_morpho_router_roles";
