import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

import { getConfig } from "../../config/config";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment): Promise<boolean> {
  const { deployer } = await hre.getNamedAccounts();

  const config = await getConfig(hre);

  // Get ERC4626 oracle wrapper configurations for ETH
  const ethConfig = config.oracleAggregators.ETH;

  if (!ethConfig?.erc4626OracleWrapper || Object.keys(ethConfig.erc4626OracleWrapper).length === 0) {
    console.log("No ETH ERC4626 oracle wrapper configuration found, skipping wrapper deployment");
    return true;
  }

  const wrapperConfigs = ethConfig.erc4626OracleWrapper;

  console.log(`Found ${Object.keys(wrapperConfigs).length} ERC4626 vaults to deploy individual oracle wrappers for`);

  // Deploy and configure each vault individually
  for (const [vaultAddress, vaultConfig] of Object.entries(wrapperConfigs)) {
    if (!vaultAddress || !/^0x[0-9a-fA-F]{40}$/.test(vaultAddress)) {
      console.error(`[erc4626-wrapper-setup] Invalid or missing vaultAddress: '${vaultAddress}'`);
      throw new Error(`[erc4626-wrapper-setup] Invalid or missing vaultAddress: '${vaultAddress}'`);
    }

    const typedVaultConfig = vaultConfig as {
      vaultAddress: string;
      vaultName: string;
      initialMaxDeviation: number;
      minShareSupply: bigint;
      underlyingAsset: string;
      baseCurrencyUnit: bigint;
    };

    // Generate deployment ID using vault name
    const dynamicDeploymentId = `ERC4626OracleWrapper_${typedVaultConfig.vaultName}_ETH`;

    console.log(`\nDeploying ERC4626OracleWrapper for ${typedVaultConfig.vaultName}...`);

    // Deploy ERC4626OracleWrapper for this specific vault
    const erc4626WrapperDeployment = await hre.deployments.deploy(dynamicDeploymentId, {
      from: deployer,
      args: [
        ethConfig.baseCurrency, // WETH address for ETH-denominated pricing
        typedVaultConfig.baseCurrencyUnit, // Vault-specific base currency unit
      ],
      contract: "ERC4626OracleWrapper",
      autoMine: true,
      log: true,
    });

    const erc4626Wrapper = await hre.ethers.getContractAt("ERC4626OracleWrapper", erc4626WrapperDeployment.address);

    console.log(`  Deployed at ${erc4626WrapperDeployment.address}`);
    console.log(`  Base currency: ${ethConfig.baseCurrency} (WETH)`);
    console.log(`  Base currency unit: ${typedVaultConfig.baseCurrencyUnit}`);

    // Add vault to its dedicated oracle wrapper
    await erc4626Wrapper.addVault(vaultAddress, typedVaultConfig.minShareSupply, typedVaultConfig.underlyingAsset);

    console.log(`  ✅ Added vault ${typedVaultConfig.vaultName} (${vaultAddress})`);
    console.log(`    - Min share supply: ${typedVaultConfig.minShareSupply}`);
    console.log(`    - Underlying asset: ${typedVaultConfig.underlyingAsset}`);

    // Set max deviation if different from default
    if (typedVaultConfig.initialMaxDeviation !== 500) {
      // 500 = 5% default
      await erc4626Wrapper.setMaxDeviation(typedVaultConfig.initialMaxDeviation);
      console.log(`    - Set max deviation: ${typedVaultConfig.initialMaxDeviation / 100}%`);
    }

    // Perform sanity check on the vault
    try {
      const { price, isAlive } = await erc4626Wrapper.getPriceInfo(vaultAddress);

      if (!isAlive || price === 0n) {
        console.warn(`    - ⚠️  WARNING: ${typedVaultConfig.vaultName} not providing valid price (price: ${price}, isAlive: ${isAlive})`);
      } else {
        // Convert price to human-readable format using vault-specific base currency unit
        const normalizedPrice = Number(price) / Number(typedVaultConfig.baseCurrencyUnit);
        console.log(`    - ✅ Sanity check passed: ${normalizedPrice.toFixed(6)} ETH per vault share`);
      }
    } catch (error) {
      console.error(`    - ❌ Error performing sanity check for ${typedVaultConfig.vaultName}:`, error);
      return false;
    }
  }

  console.log(`🔮 ${__filename.split("/").slice(-2).join("/")}: ✅`);
  return true;
};

func.tags = ["erc4626-oracle", "oracle-aggregator", "oracle-wrapper", "yvvbETH"];
func.dependencies = [];
func.id = "deploy-yvvbETH-erc4626-wrappers";

export default func;
