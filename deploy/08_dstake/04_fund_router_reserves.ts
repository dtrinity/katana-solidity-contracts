import { ethers } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

/**
 * Funds DStakeRouter reserves for operational stability
 *
 * This script funds the router with initial reserves to handle vault withdrawal fees
 * and operational costs. In production, routers need reserves to ensure users always
 * receive exactly what DStakeToken promises them, even when underlying vaults charge fees.
 *
 * @param hre Hardhat runtime environment
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deployer } = await getNamedAccounts();
  const deployerSigner = await ethers.getSigner(deployer);

  console.log("\n🏦 Funding DStakeRouter Reserves...");

  // Configuration for reserve funding
  const reserveConfigs = [
    {
      routerName: "DStakeRouter_sdUSD",
      dStableName: "dUSD",
      reserveAmount: "1000", // 1000 dUSD reserves
    },
    {
      routerName: "DStakeRouter_sdETH",
      dStableName: "dETH",
      reserveAmount: "0.5", // 0.5 dETH reserves
    },
  ];

  for (const config of reserveConfigs) {
    try {
      // Get router deployment
      const routerDeployment = await deployments.getOrNull(config.routerName);

      if (!routerDeployment) {
        console.log(`  ⚠️ ${config.routerName} not found, skipping reserve funding`);
        continue;
      }

      const router = await ethers.getContractAt("DStakeRouter", routerDeployment.address, deployerSigner);

      // Get dStable contract
      const dStableDeployment = await deployments.getOrNull(config.dStableName);

      if (!dStableDeployment) {
        console.log(`  ⚠️ ${config.dStableName} not found, skipping reserve funding for ${config.routerName}`);
        continue;
      }

      const dStable = await ethers.getContractAt("IERC20", dStableDeployment.address, deployerSigner);
      const reserveAmount = ethers.parseEther(config.reserveAmount);

      // Check current reserves
      const currentReserves = await router.reserveBalance();
      console.log(`  📊 ${config.routerName} current reserves: ${ethers.formatEther(currentReserves)} ${config.dStableName}`);

      if (currentReserves >= reserveAmount) {
        console.log(`  ✓ ${config.routerName} already has sufficient reserves`);
        continue;
      }

      // Check deployer balance
      const deployerBalance = await dStable.balanceOf(deployer);

      if (deployerBalance < reserveAmount) {
        console.log(
          `  ⚠️ Deployer has insufficient ${config.dStableName} balance (${ethers.formatEther(deployerBalance)}) to fund reserves`
        );
        console.log(`  📋 Manual action required: Fund ${config.routerName} with ${config.reserveAmount} ${config.dStableName}`);
        console.log(`  📋 Command: router.fundReserves("${reserveAmount}")`);
        continue;
      }

      // Fund reserves
      console.log(`  💰 Funding ${config.routerName} with ${config.reserveAmount} ${config.dStableName}...`);

      // Approve router to spend dStable
      await dStable.approve(router.target, reserveAmount);

      // Fund reserves
      await router.fundReserves(reserveAmount);

      const newReserveBalance = await router.reserveBalance();
      console.log(`  ✅ ${config.routerName} reserves funded: ${ethers.formatEther(newReserveBalance)} ${config.dStableName}`);
    } catch (error) {
      console.error(`  ❌ Failed to fund reserves for ${config.routerName}: ${error}`);
      console.log(`  📋 Manual action required: Fund ${config.routerName} reserves with ${config.reserveAmount} ${config.dStableName}`);
    }
  }

  console.log("🏦 DStakeRouter reserve funding completed\n");
};

func.id = "fund_router_reserves";
func.tags = ["dstake", "router-reserves"];
func.dependencies = ["dstake-core", "metamorpho-adapters"];

export default func;
