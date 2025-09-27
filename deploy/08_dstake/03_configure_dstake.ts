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
  // designated admin and fee manager addresses will be handled in a separate
  // script executed after configuration.
  const deployerSigner = await ethers.getSigner(deployer);

  const config = await getConfig(hre);

  if (!config.dStake) {
    console.log("No dSTAKE configuration found for this network. Skipping configuration.");
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

    // Note: defaultDepositStrategyShare might not be available if dLend is not deployed
    // In test environments, MetaMorpho adapters will set this up separately

    if (!instanceConfig.collateralExchangers || !Array.isArray(instanceConfig.collateralExchangers)) {
      throw new Error(`Missing collateralExchangers array for dSTAKE instance ${instanceKey}`);
    }

    validInstances.push(instanceKey);
  }

  // All configs are valid, proceed with configuration
  for (const instanceKey of validInstances) {
    const instanceConfig = config.dStake[instanceKey] as DStakeInstanceConfig;
    const DStakeTokenV2DeploymentName = `DStakeTokenV2_${instanceKey}`;
    const collateralVaultDeploymentName = `DStakeCollateralVaultV2_${instanceKey}`;
    const routerDeploymentName = `DStakeRouterV2_${instanceKey}`;

    const collateralVaultDeployment = await get(collateralVaultDeploymentName);
    const routerDeployment = await get(routerDeploymentName);
    const dstakeTokenDeployment = await get(DStakeTokenV2DeploymentName);

    // (Permissions remain with the deployer; role migration happens later.)
    // Get Typechain instances
    const dstakeToken = await ethers.getContractAt(
      "DStakeTokenV2",
      dstakeTokenDeployment.address,
      await ethers.getSigner(deployer) // Use deployer as signer for read calls
    );
    const collateralVault = await ethers.getContractAt(
      "DStakeCollateralVaultV2",
      collateralVaultDeployment.address,
      await ethers.getSigner(deployer) // Use deployer as signer for read calls
    );

    // --- Ensure collateral vault trusts the configured router before migration ---
    const vaultRouter = await collateralVault.router();
    const vaultRouterRole = await collateralVault.ROUTER_ROLE();
    const isRouterRoleGranted = await collateralVault.hasRole(vaultRouterRole, routerDeployment.address);

    if (vaultRouter !== routerDeployment.address || !isRouterRoleGranted) {
      console.log(`    ⚙️ Setting router for ${collateralVaultDeploymentName} to ${routerDeployment.address}`);
      await collateralVault.connect(deployerSigner).setRouter(routerDeployment.address);
    }

    // --- Configure DStakeTokenV2 ---
    const currentRouter = await dstakeToken.router();
    const currentVault = await dstakeToken.collateralVault();

    if (currentRouter !== routerDeployment.address || currentVault !== collateralVaultDeployment.address) {
      console.log(
        `    ⚙️ Aligning router + collateral vault for ${DStakeTokenV2DeploymentName} to (${routerDeployment.address}, ${collateralVaultDeployment.address})`
      );
      await dstakeToken
        .connect(deployerSigner)
        .migrateCore(routerDeployment.address, collateralVaultDeployment.address);
    }
    const currentFee = await dstakeToken.withdrawalFeeBps();

    if (currentFee.toString() !== instanceConfig.initialWithdrawalFeeBps.toString()) {
      console.log(`    ⚙️ Setting withdrawal fee for ${DStakeTokenV2DeploymentName} to ${instanceConfig.initialWithdrawalFeeBps}`);
      await dstakeToken.connect(deployerSigner).setWithdrawalFee(instanceConfig.initialWithdrawalFeeBps);
    }

    // --- Configure DStakeCollateralVaultV2 ---
    const routerContract = await ethers.getContractAt("DStakeRouterV2", routerDeployment.address, deployerSigner);

    // --- Configure DStakeCollateralVaultV2 Adapters ---
    for (const adapterConfig of instanceConfig.adapters) {
      const adapterDeploymentName = `${adapterConfig.adapterContract}_${instanceConfig.symbol}`;

      // Skip if adapter is not deployed (e.g., dLend adapters when dLend is not available)
      const adapterDeploymentExists = await deployments.getOrNull(adapterDeploymentName);

      if (!adapterDeploymentExists) {
        console.log(`    ⚠️  Skipping adapter ${adapterDeploymentName} - not deployed yet`);
        continue;
      }

      const adapterDeployment = await get(adapterDeploymentName);
      const strategyShareAddress = adapterConfig.strategyShare;

      // Skip if strategy share is not valid
      if (!strategyShareAddress || strategyShareAddress === ethers.ZeroAddress) {
        console.log(`    ⚠️  Skipping adapter ${adapterDeploymentName} - strategy share not available`);
        continue;
      }

      const existingAdapter = await routerContract.strategyShareToAdapter(strategyShareAddress);

      if (existingAdapter === ethers.ZeroAddress) {
        await routerContract.connect(deployerSigner).addAdapter(strategyShareAddress, adapterDeployment.address);
        console.log(`    ➕ Added adapter ${adapterDeploymentName} for strategy share ${strategyShareAddress} to ${routerDeploymentName}`);
      } else if (existingAdapter !== adapterDeployment.address) {
        throw new Error(
          `⚠️ Adapter for strategy share ${strategyShareAddress} in router is already set to ${existingAdapter} but config expects ${adapterDeployment.address}. Manual intervention may be required.`
        );
      } else {
        console.log(
          `    👍 Adapter ${adapterDeploymentName} for strategy share ${strategyShareAddress} already configured correctly in ${routerDeploymentName}`
        );
      }
    }

    // --- Configure DStakeRouter --- // This part already uses Typechain
    const collateralExchangerRole = await routerContract.STRATEGY_REBALANCER_ROLE();

    for (const exchanger of instanceConfig.collateralExchangers) {
      const hasRole = await routerContract.hasRole(collateralExchangerRole, exchanger);

      if (!hasRole) {
        await routerContract.grantRole(collateralExchangerRole, exchanger);
        console.log(`    ➕ Granted STRATEGY_REBALANCER_ROLE to ${exchanger} for ${routerDeploymentName}`);
      }
    }

    // Adapters have already been configured above

    // Set default deposit strategy share if configured
    if (instanceConfig.defaultDepositStrategyShare && instanceConfig.defaultDepositStrategyShare !== ethers.ZeroAddress) {
      const currentDefaultAsset = await routerContract.defaultDepositStrategyShare();

      if (currentDefaultAsset !== instanceConfig.defaultDepositStrategyShare) {
        await routerContract.setDefaultDepositStrategyShare(instanceConfig.defaultDepositStrategyShare);
        console.log(`    ⚙️ Set default deposit strategy share for ${routerDeploymentName}`);
      }
    } else {
      console.log(`    ⚠️  No defaultDepositStrategyShare configured for ${instanceKey}, will be set by adapter deployment script`);
    }
  }

  console.log(`🥩 ${__filename.split("/").slice(-2).join("/")}: ✅`);
};

export default func;
func.tags = ["dStakeConfigure", "dStake"];
func.dependencies = ["dStakeCore", "dStakeAdapters", "dStakeRouterV2", "metamorpho-adapters"];
func.runAtTheEnd = true;

// Prevent re-execution after successful run.
func.id = "configure_dstake";
