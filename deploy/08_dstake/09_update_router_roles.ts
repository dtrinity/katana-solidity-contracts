import { Signer } from "ethers";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

import { getConfig } from "../../config/config";

/**
 * Grant new role-based access controls for DStakeRouterV2 and DStakeRouter contracts.
 * This script adds the new granular roles introduced in the access control improvements:
 *
 * DStakeRouterV2:
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

    // --- DStakeRouterV2 roles ---
    try {
      const routerV2Deployment = await deployments.getOrNull(`DStakeRouterV2_${instanceKey}`);

      if (routerV2Deployment) {
        console.log(`  📄 ROUTER ROLES: DStakeRouterV2_${instanceKey}`);
        const routerV2Contract = await ethers.getContractAt("DStakeRouterV2", routerV2Deployment.address, deployerSigner);

        const VAULT_MANAGER_ROLE = await routerV2Contract.VAULT_MANAGER_ROLE();
        const CONFIG_MANAGER_ROLE = await routerV2Contract.CONFIG_MANAGER_ROLE();
        const PAUSER_ROLE = await routerV2Contract.PAUSER_ROLE();

        // Grant new roles to the configured admin
        if (!(await routerV2Contract.hasRole(VAULT_MANAGER_ROLE, instanceConfig.initialAdmin))) {
          await routerV2Contract.grantRole(VAULT_MANAGER_ROLE, instanceConfig.initialAdmin);
          console.log(`    ➕ Granted VAULT_MANAGER_ROLE to ${instanceConfig.initialAdmin}`);
        }

        if (!(await routerV2Contract.hasRole(CONFIG_MANAGER_ROLE, instanceConfig.initialAdmin))) {
          await routerV2Contract.grantRole(CONFIG_MANAGER_ROLE, instanceConfig.initialAdmin);
          console.log(`    ➕ Granted CONFIG_MANAGER_ROLE to ${instanceConfig.initialAdmin}`);
        }

        if (!(await routerV2Contract.hasRole(PAUSER_ROLE, instanceConfig.initialAdmin))) {
          await routerV2Contract.grantRole(PAUSER_ROLE, instanceConfig.initialAdmin);
          console.log(`    ➕ Granted PAUSER_ROLE to ${instanceConfig.initialAdmin}`);
        }

        // Also grant to deployer temporarily for testing/configuration
        if (!(await routerV2Contract.hasRole(VAULT_MANAGER_ROLE, deployer))) {
          await routerV2Contract.grantRole(VAULT_MANAGER_ROLE, deployer);
          console.log(`    ➕ Granted VAULT_MANAGER_ROLE to deployer (temporary)`);
        }

        if (!(await routerV2Contract.hasRole(CONFIG_MANAGER_ROLE, deployer))) {
          await routerV2Contract.grantRole(CONFIG_MANAGER_ROLE, deployer);
          console.log(`    ➕ Granted CONFIG_MANAGER_ROLE to deployer (temporary)`);
        }

        if (!(await routerV2Contract.hasRole(PAUSER_ROLE, deployer))) {
          await routerV2Contract.grantRole(PAUSER_ROLE, deployer);
          console.log(`    ➕ Granted PAUSER_ROLE to deployer (temporary)`);
        }
      } else {
        console.log(`  ⚠️ DStakeRouterV2_${instanceKey} not deployed, skipping router role setup`);
      }
    } catch (error) {
      console.error(`  ❌ Failed to setup DStakeRouterV2_${instanceKey} roles: ${error}`);
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
          deployerSigner,
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
func.dependencies = ["dStakeRouterV2Configure"];
func.runAtTheEnd = false;

// Unique identifier so Hardhat Deploy knows this script has executed when it
// returns `true` (skip behaviour).
func.id = "update_dstake_router_roles";
