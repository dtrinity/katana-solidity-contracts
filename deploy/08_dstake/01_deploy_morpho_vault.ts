import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

import { getConfig } from "../../config/config";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const config = await getConfig(hre);

  if (!config.morpho) {
    console.log("No Morpho configuration found for this network. Skipping Morpho vault deployment.");
    return;
  }

  if (!config.dStake) {
    console.log("No dStake configuration found. Skipping Morpho vault deployment.");
    return;
  }

  // Deploy Morpho4626Vault for each configured market
  for (const marketKey in config.morpho.markets) {
    const marketConfig = config.morpho.markets[marketKey];
    const deploymentName = `Morpho4626Vault_${marketKey}`;

    // Check if already deployed
    const existingVault = await deployments.getOrNull(deploymentName);
    if (existingVault) {
      console.log(`    ${deploymentName} already exists at ${existingVault.address}. Skipping deployment.`);
      continue;
    }

    // Deploy the Morpho4626Vault
    const vaultName = `Morpho ${marketConfig.name} Vault`;
    const vaultSymbol = `mv${marketConfig.symbol}`;

    await deploy(deploymentName, {
      from: deployer,
      contract: "Morpho4626Vault",
      args: [
        config.morpho.morphoAddress,
        {
          loanToken: marketConfig.loanToken,
          collateralToken: marketConfig.collateralToken,
          oracle: marketConfig.oracle,
          irm: marketConfig.irm,
          lltv: marketConfig.lltv,
        },
        vaultName,
        vaultSymbol,
      ],
      log: true,
    });

    console.log(`✅ Deployed ${deploymentName}`);
  }

  console.log(`🥩 ${__filename.split("/").slice(-2).join("/")}: ✅`);
};

export default func;
func.tags = ["MorphoVault", "dStake"];
func.dependencies = ["dStableCore"];

// Ensure one-shot execution.
func.id = "deploy_morpho_vault";