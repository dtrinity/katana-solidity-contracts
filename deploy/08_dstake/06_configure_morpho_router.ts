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
    console.log("No dStake configuration found for this network. Skipping DStakeRouterMorpho configuration.");
    return;
  }

  if (!config.morpho) {
    console.log("No Morpho configuration found for this network. Skipping DStakeRouterMorpho configuration.");
    return;
  }

  // Validate all configs before configuring anything
  const validInstances: string[] = [];

  for (const instanceKey in config.dStake) {
    const instanceConfig = config.dStake[instanceKey] as DStakeInstanceConfig;

    if (!instanceConfig.dStable || instanceConfig.dStable === ethers.ZeroAddress) {
      throw new Error(`Missing dStable address for dSTAKE instance ${instanceKey}`);
    }

    if (!instanceConfig.symbol) {
      throw new Error(`Missing symbol for dSTAKE instance ${instanceKey}`);
    }

    if (!instanceConfig.collateralExchangers || !Array.isArray(instanceConfig.collateralExchangers)) {
      throw new Error(`Missing collateralExchangers array for dSTAKE instance ${instanceKey}`);
    }

    // Check if DStakeRouterMorpho is deployed for this instance
    const morphoRouterDeploymentExists = await deployments.getOrNull(`DStakeRouterMorpho_${instanceKey}`);

    if (!morphoRouterDeploymentExists) {
      console.log(`⚠️  Skipping ${instanceKey}: DStakeRouterMorpho not deployed yet`);
      continue;
    }

    validInstances.push(instanceKey);
  }

  // Configure DStakeRouterMorpho for each valid instance
  for (const instanceKey of validInstances) {
    const instanceConfig = config.dStake[instanceKey] as DStakeInstanceConfig;
    const morphoRouterDeploymentName = `DStakeRouterMorpho_${instanceKey}`;

    console.log(`⚙️ Configuring DStakeRouterMorpho for ${instanceKey}...`);

    const morphoRouterDeployment = await get(morphoRouterDeploymentName);
    const morphoRouter = await ethers.getContractAt("DStakeRouterMorpho", morphoRouterDeployment.address, deployerSigner);

    // --- Configure Collateral Exchangers ---
    const collateralExchangerRole = await morphoRouter.COLLATERAL_EXCHANGER_ROLE();

    for (const exchanger of instanceConfig.collateralExchangers) {
      const hasRole = await morphoRouter.hasRole(collateralExchangerRole, exchanger);

      if (!hasRole) {
        await morphoRouter.grantRole(collateralExchangerRole, exchanger);
        console.log(`    ➕ Granted COLLATERAL_EXCHANGER_ROLE to ${exchanger} for ${morphoRouterDeploymentName}`);
      } else {
        console.log(`    👍 ${exchanger} already has COLLATERAL_EXCHANGER_ROLE for ${morphoRouterDeploymentName}`);
      }
    }

    // --- Configure MetaMorpho Vault Adapters ---
    const vaultConfigs = [];
    let totalTargetBps = 0;

    // Process MetaMorpho adapters and create vault configurations
    for (const adapterConfig of instanceConfig.adapters) {
      if (adapterConfig.adapterContract === "MetaMorphoConversionAdapter") {
        const adapterDeploymentName = `${adapterConfig.adapterContract}_${instanceConfig.symbol}`;

        // Check if adapter is deployed
        const adapterDeploymentExists = await deployments.getOrNull(adapterDeploymentName);

        if (!adapterDeploymentExists) {
          console.log(`    ⚠️  Skipping vault config for ${adapterDeploymentName} - adapter not deployed yet`);
          continue;
        }

        const adapterDeployment = await get(adapterDeploymentName);
        const vaultAssetAddress = adapterConfig.vaultAsset;

        // Skip if vault asset is not valid
        if (!vaultAssetAddress || vaultAssetAddress === ethers.ZeroAddress) {
          console.log(`    ⚠️  Skipping vault config for ${adapterDeploymentName} - vault asset not available`);
          continue;
        }

        // Use configured target BPS if available, otherwise use equal distribution
        let targetBps: number;

        if (adapterConfig.targetBps && typeof adapterConfig.targetBps === "number") {
          targetBps = adapterConfig.targetBps;
        } else {
          // Fallback to equal distribution for initial deployment
          if (vaultConfigs.length === 0) {
            targetBps = 5000; // 50% for first vault
          } else if (vaultConfigs.length === 1) {
            targetBps = 3000; // 30% for second vault
          } else {
            targetBps = 2000; // 20% for third vault
          }
        }

        vaultConfigs.push({
          vault: vaultAssetAddress,
          adapter: adapterDeployment.address,
          targetBps: targetBps,
          isActive: true,
        });

        totalTargetBps += targetBps;

        // Add adapter to the router (base functionality)
        const existingAdapter = await morphoRouter.vaultAssetToAdapter(vaultAssetAddress);

        if (existingAdapter === ethers.ZeroAddress) {
          await morphoRouter.addAdapter(vaultAssetAddress, adapterDeployment.address);
          console.log(`    ➕ Added adapter ${adapterDeploymentName} for vault ${vaultAssetAddress}`);
        } else if (existingAdapter !== adapterDeployment.address) {
          console.log(
            `    ⚠️  Adapter for vault ${vaultAssetAddress} is already set to ${existingAdapter}, expected ${adapterDeployment.address}`
          );
        } else {
          console.log(`    👍 Adapter ${adapterDeploymentName} for vault ${vaultAssetAddress} already configured`);
        }
      }
    }

    // Validate total allocations before setting vault configurations
    if (vaultConfigs.length > 0) {
      // Adjust the last vault to ensure total is exactly 10000 BPS
      if (totalTargetBps !== 10000) {
        const adjustment = 10000 - totalTargetBps;
        vaultConfigs[vaultConfigs.length - 1].targetBps += adjustment;
        console.log(`    ⚙️ Adjusted last vault target BPS by ${adjustment} to reach 10000 total`);
      }

      // Set vault configurations
      try {
        const currentVaultCount = await morphoRouter.getVaultCount();

        if (currentVaultCount.toString() === "0") {
          console.log(`    ⚙️ Setting vault configurations for ${morphoRouterDeploymentName}...`);
          await morphoRouter.setVaultConfigs(vaultConfigs);
          console.log(`    ✅ Configured ${vaultConfigs.length} vaults with target allocations`);

          // Log the configuration
          for (let i = 0; i < vaultConfigs.length; i++) {
            const config = vaultConfigs[i];
            console.log(`      Vault ${i + 1}: ${config.vault} -> ${config.targetBps / 100}% (Adapter: ${config.adapter})`);
          }
        } else {
          console.log(`    👍 Vault configurations already set for ${morphoRouterDeploymentName} (${currentVaultCount} vaults)`);
        }
      } catch (error) {
        console.error(`    ❌ Failed to set vault configurations for ${morphoRouterDeploymentName}:`, error);
        throw error;
      }
    } else {
      console.log(`    ⚠️  No MetaMorpho vault configurations to set for ${instanceKey}`);
    }

    // --- Configure Default Deposit Vault Asset ---
    // Use the first configured vault as the default
    if (vaultConfigs.length > 0) {
      const currentDefaultAsset = await morphoRouter.defaultDepositVaultAsset();
      const firstVaultAsset = vaultConfigs[0].vault;

      if (currentDefaultAsset !== firstVaultAsset) {
        await morphoRouter.setDefaultDepositVaultAsset(firstVaultAsset);
        console.log(`    ⚙️ Set default deposit vault asset to ${firstVaultAsset} for ${morphoRouterDeploymentName}`);
      } else {
        console.log(`    👍 Default deposit vault asset already set for ${morphoRouterDeploymentName}`);
      }
    }

    console.log(`✅ Completed configuration for DStakeRouterMorpho ${instanceKey}`);
  }

  console.log(`🥩 ${__filename.split("/").slice(-2).join("/")}: ✅`);
};

export default func;
func.tags = ["dStakeMorphoConfigure", "dStake", "morpho"];
func.dependencies = ["dStakeMorphoRouter", "metamorpho-adapters"];
func.runAtTheEnd = false;

// Mark script as executed so it won't run again
func.id = "configure_morpho_router";
