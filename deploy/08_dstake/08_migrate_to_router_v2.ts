import { ethers } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

import { getConfig } from "../../config/config";
import { DStakeInstanceConfig } from "../../config/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { get } = deployments;
  const { deployer } = await getNamedAccounts();

  // Use deployer for all state-changing transactions. Permission migrations to the
  // designated admin and fee manager addresses will be handled in separate scripts.
  const deployerSigner = await ethers.getSigner(deployer);

  const config = await getConfig(hre);

  if (!config.dStake) {
    console.log("No dStake configuration found for this network. Skipping migration to DStakeRouterV2.");
    return;
  }

  // Validate all configs and check if migration is needed
  const migrateInstances: string[] = [];

  for (const instanceKey in config.dStake) {
    const instanceConfig = config.dStake[instanceKey] as DStakeInstanceConfig;

    if (!instanceConfig.dStable || instanceConfig.dStable === ethers.ZeroAddress) {
      throw new Error(`Missing dStable address for dSTAKE instance ${instanceKey}`);
    }

    // Check if both old and new routers exist
    const oldRouterExists = await deployments.getOrNull(`DStakeRouter_${instanceKey}`);
    const newRouterExists = await deployments.getOrNull(`DStakeRouterV2_${instanceKey}`);

    if (!oldRouterExists) {
      console.log(`⚠️  Skipping ${instanceKey}: Original DStakeRouter not found`);
      continue;
    }

    if (!newRouterExists) {
      console.log(`⚠️  Skipping ${instanceKey}: DStakeRouterV2 not deployed yet`);
      continue;
    }

    // Check if migration is already complete by checking which router the DStakeTokenV2 is using
    const dstakeTokenDeployment = await get(`DStakeTokenV2_${instanceKey}`);
    const dstakeToken = await ethers.getContractAt("DStakeTokenV2", dstakeTokenDeployment.address, deployerSigner);
    const currentRouter = await dstakeToken.router();

    if (currentRouter === newRouterExists.address) {
      console.log(`👍 ${instanceKey} already migrated to DStakeRouterV2`);
      continue;
    }

    migrateInstances.push(instanceKey);
  }

  if (migrateInstances.length === 0) {
    console.log("No instances require migration to DStakeRouterV2.");
    return;
  }

  console.log(`🔄 Migrating ${migrateInstances.length} instances to DStakeRouterV2...`);

  // Perform migration for each instance
  for (const instanceKey of migrateInstances) {
    console.log(`🔄 Migrating ${instanceKey} to DStakeRouterV2...`);

    // Get contract instances
    const dstakeTokenDeployment = await get(`DStakeTokenV2_${instanceKey}`);
    const collateralVaultDeployment = await get(`DStakeCollateralVaultV2_${instanceKey}`);
    const oldRouterDeployment = await get(`DStakeRouter_${instanceKey}`);
    const newRouterDeployment = await get(`DStakeRouterV2_${instanceKey}`);

    const dstakeToken = await ethers.getContractAt("DStakeTokenV2", dstakeTokenDeployment.address, deployerSigner);
    const collateralVault = await ethers.getContractAt("DStakeCollateralVaultV2", collateralVaultDeployment.address, deployerSigner);
    const newRouter = await ethers.getContractAt("DStakeRouterV2", newRouterDeployment.address, deployerSigner);

    // --- Step 1: Safety Checks ---
    console.log(`    🔍 Performing safety checks for ${instanceKey}...`);

    // Check that the new router is properly configured
    const newRouterVaultCount = await newRouter.getVaultCount();

    if (newRouterVaultCount.toString() === "0") {
      throw new Error(`DStakeRouterV2 for ${instanceKey} is not configured with any vaults. Run configuration script first.`);
    }

    // Verify router role permissions
    const routerRole = await collateralVault.ROUTER_ROLE();
    const hasOldRouterRole = await collateralVault.hasRole(routerRole, oldRouterDeployment.address);
    const hasNewRouterRole = await collateralVault.hasRole(routerRole, newRouterDeployment.address);

    if (!hasOldRouterRole) {
      console.log(`    ⚠️  Warning: Old router doesn't have ROUTER_ROLE for ${instanceKey}. This might be expected if already migrated.`);
    }

    // --- Step 2: Grant Router Role to New Router ---
    if (!hasNewRouterRole) {
      console.log(`    ➕ Granting ROUTER_ROLE to new DStakeRouterV2 for ${instanceKey}...`);
      await collateralVault.grantRole(routerRole, newRouterDeployment.address);
    } else {
      console.log(`    👍 New DStakeRouterV2 already has ROUTER_ROLE for ${instanceKey}`);
    }

    // --- Step 3: Check for Active Deposits/Withdrawals ---
    // In production, you might want to pause operations before migration
    const currentTotalSupply = await dstakeToken.totalSupply();
    const currentVaultBalance = await collateralVault.totalAssets();

    console.log(`    📊 Current state for ${instanceKey}:`);
    console.log(`      Total Supply: ${ethers.formatEther(currentTotalSupply)}`);
    console.log(`      Vault Balance: ${ethers.formatEther(currentVaultBalance)}`);

    // --- Step 4: Update DStakeTokenV2 Router Reference ---
    console.log(`    🔗 Updating DStakeTokenV2 router reference for ${instanceKey}...`);
    await dstakeToken.setRouter(newRouterDeployment.address);

    // Verify the change
    const updatedRouter = await dstakeToken.router();

    if (updatedRouter !== newRouterDeployment.address) {
      throw new Error(`Failed to update router for ${instanceKey}. Expected ${newRouterDeployment.address}, got ${updatedRouter}`);
    }

    // --- Step 5: Update Collateral Vault Router Reference ---
    console.log(`    🔗 Updating DStakeCollateralVaultV2 router reference for ${instanceKey}...`);
    const currentVaultRouter = await collateralVault.router();

    if (currentVaultRouter !== newRouterDeployment.address) {
      await collateralVault.setRouter(newRouterDeployment.address);

      // Verify the change
      const updatedVaultRouter = await collateralVault.router();

      if (updatedVaultRouter !== newRouterDeployment.address) {
        throw new Error(
          `Failed to update collateral vault router for ${instanceKey}. Expected ${newRouterDeployment.address}, got ${updatedVaultRouter}`,
        );
      }
    } else {
      console.log(`    👍 Collateral vault router already set for ${instanceKey}`);
    }

    // --- Step 6: Revoke Router Role from Old Router (Optional - for security) ---
    if (hasOldRouterRole) {
      console.log(`    🔒 Revoking ROUTER_ROLE from old router for ${instanceKey}...`);
      await collateralVault.revokeRole(routerRole, oldRouterDeployment.address);
      console.log(`    ✅ Revoked ROUTER_ROLE from old router for ${instanceKey}`);
    }

    // --- Step 7: Verification ---
    console.log(`    ✅ Verifying migration for ${instanceKey}...`);

    // Verify all references are updated
    const finalTokenRouter = await dstakeToken.router();
    const finalVaultRouter = await collateralVault.router();
    const finalHasNewRouterRole = await collateralVault.hasRole(routerRole, newRouterDeployment.address);
    const finalHasOldRouterRole = await collateralVault.hasRole(routerRole, oldRouterDeployment.address);

    if (finalTokenRouter !== newRouterDeployment.address) {
      throw new Error(`Migration verification failed: DStakeTokenV2 router not updated for ${instanceKey}`);
    }

    if (finalVaultRouter !== newRouterDeployment.address) {
      throw new Error(`Migration verification failed: CollateralVault router not updated for ${instanceKey}`);
    }

    if (!finalHasNewRouterRole) {
      throw new Error(`Migration verification failed: New router doesn't have ROUTER_ROLE for ${instanceKey}`);
    }

    console.log(`    ✅ Migration completed successfully for ${instanceKey}`);
    console.log(`      - DStakeTokenV2 router: ${finalTokenRouter}`);
    console.log(`      - CollateralVault router: ${finalVaultRouter}`);
    console.log(`      - New router has ROUTER_ROLE: ${finalHasNewRouterRole}`);
    console.log(`      - Old router has ROUTER_ROLE: ${finalHasOldRouterRole}`);
  }

  console.log(`✅ Migration to DStakeRouterV2 completed for all ${migrateInstances.length} instances`);
  console.log(`🥩 ${__filename.split("/").slice(-2).join("/")}: ✅`);
};

export default func;
func.tags = ["dStakeRouterV2Migrate", "dStake", "migration"];
func.dependencies = ["dStakeRouterV2Configure"];
func.runAtTheEnd = true;

// Mark script as executed so it won't run again
func.id = "migrate_to_dstake_router_v2";

// Skip if migration is not needed or already completed
func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const { deployments } = hre;
  const config = await getConfig(hre);

  if (!config.dStake) return true;

  // Check if migration is needed for any instance
  for (const instanceKey in config.dStake) {
    const oldRouterExists = await deployments.getOrNull(`DStakeRouter_${instanceKey}`);
    const newRouterExists = await deployments.getOrNull(`DStakeRouterV2_${instanceKey}`);

    if (!oldRouterExists || !newRouterExists) {
      continue; // Skip if routers don't exist
    }

    // Check if migration is needed
    try {
      const dstakeTokenDeployment = await deployments.get(`DStakeTokenV2_${instanceKey}`);
      const dstakeToken = await hre.ethers.getContractAt("DStakeTokenV2", dstakeTokenDeployment.address);
      const currentRouter = await dstakeToken.router();

      if (currentRouter !== newRouterExists.address) {
        return false; // Migration needed
      }
    } catch (error) {
      console.warn(`Unable to check migration status for ${instanceKey}: ${error}`);
      return false; // Unable to check, allow migration to run
    }
  }

  // No migration needed for any instance
  return true;
};
