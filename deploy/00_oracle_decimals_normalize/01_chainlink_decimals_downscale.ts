import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

import { getConfig } from "../../config/networks/katana_mainnet";

const deployChainlinkDecimalDownscaler: DeployFunction = async function (hre: HardhatRuntimeEnvironment): Promise<boolean> {
  const { deployments, getNamedAccounts, ethers } = hre;
  const { deploy, getOrNull } = deployments;
  const { deployer } = await getNamedAccounts();

  console.log("🚀 Deploying ChainlinkDecimalDownscaler for yUSD feed...");

  // Get network configuration
  const config = await getConfig(hre);

  // Get yUSD feed address from config
  const yUSDAddress = config.tokenAddresses.yUSD;
  const yUSDFeedAddress = config.oracleAggregators.USD.redstoneOracleAssets.plainRedstoneOracleWrappers[yUSDAddress];

  if (!yUSDFeedAddress) {
    throw new Error("yUSD Chainlink feed not found in configuration");
  }

  console.log(`📍 yUSD Token: ${yUSDAddress}`);
  console.log(`📍 yUSD Feed (18 decimals): ${yUSDFeedAddress}`);

  // Deploy ChainlinkDecimalDownscaler to convert 18 -> 8 decimals
  const TARGET_DECIMALS = 8;

  // If the source feed already has the desired decimals, skip deployment entirely
  try {
    const sourceFeed = await ethers.getContractAt("AggregatorV3Interface", yUSDFeedAddress);
    const sourceDecimals = await sourceFeed.decimals();
    if (Number(sourceDecimals) === TARGET_DECIMALS) {
      console.log(`♻️  Source feed already at target decimals (${TARGET_DECIMALS}). Skipping downscaler deployment.`);
      return true;
    }
  } catch (e) {
    console.log(`⚠️  Could not read source feed decimals at ${yUSDFeedAddress}, continuing with deployment: ${e}`);
  }

  // If already deployed, reuse and exit
  const existing = await getOrNull("ChainlinkDecimalDownscaler_yUSD");
  if (existing?.address) {
    console.log(`♻️  Reusing existing ChainlinkDecimalDownscaler at: ${existing.address}`);
    return true;
  }

  const chainlinkDecimalDownscaler = await deploy("ChainlinkDecimalDownscaler_yUSD", {
    contract: "ChainlinkDecimalDownscaler",
    from: deployer,
    args: [
      yUSDFeedAddress, // source feed (18 decimals)
      TARGET_DECIMALS, // target decimals (8 decimals)
    ],
    log: true,
    skipIfAlreadyDeployed: true,
    deterministicDeployment: false,
  });

  console.log(`✅ ChainlinkDecimalDownscaler deployed at: ${chainlinkDecimalDownscaler.address}`);

  // Verify the deployment by checking the decimals
  const downscalerContract = await ethers.getContractAt("ChainlinkDecimalDownscaler", chainlinkDecimalDownscaler.address);

  const sourceDecimals = await downscalerContract.sourceDecimals();
  const targetDecimals = await downscalerContract.decimals();

  console.log(`📊 Source feed decimals: ${sourceDecimals}`);
  console.log(`📊 Target feed decimals: ${targetDecimals}`);

  // Test the conversion by getting latest price
  try {
    const [, answer, , updatedAt] = await downscalerContract.latestRoundData();
    const formattedPrice = ethers.formatUnits(answer, targetDecimals);
    const lastUpdate = new Date(Number(updatedAt) * 1000);

    console.log(`💲 Converted Price: ${formattedPrice}`);
    console.log(`🕐 Last Update: ${lastUpdate.toISOString()}`);
    console.log(`🔢 Raw Price (${targetDecimals} decimals): ${answer.toString()}`);
  } catch (error) {
    console.log(`⚠️  Could not fetch price from downscaler: ${error}`);
  }

  console.log("🎉 ChainlinkDecimalDownscaler deployment completed!");

  // Log instructions for using this downscaler
  console.log("\n💡 Usage Instructions:");
  console.log(`   • Replace yUSD feed address in config with: ${chainlinkDecimalDownscaler.address}`);
  console.log(`   • This downscaler converts 18 decimals -> 8 decimals automatically`);
  console.log(`   • Original feed: ${yUSDFeedAddress} (18 decimals)`);
  console.log(`   • Downscaled feed: ${chainlinkDecimalDownscaler.address} (8 decimals)`);
  return true;
};

export default deployChainlinkDecimalDownscaler;
deployChainlinkDecimalDownscaler.tags = ["ChainlinkDecimalDownscaler", "yUSD", "Oracle", "Decimals"];
deployChainlinkDecimalDownscaler.dependencies = [];
deployChainlinkDecimalDownscaler.id = "usd_yusd_chainlink_decimal_downscaler";
