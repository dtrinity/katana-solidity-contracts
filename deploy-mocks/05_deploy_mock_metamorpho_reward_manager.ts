import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { SDUSD_COLLATERAL_VAULT_ID, SDETH_COLLATERAL_VAULT_ID, SDUSD_ROUTER_ID, SDETH_ROUTER_ID } from "../typescript/deploy-ids";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deploy, get } = deployments;
  const { deployer } = await getNamedAccounts();

  // Only deploy on local/test networks
  if (hre.network.name !== "localhost" && hre.network.name !== "hardhat") {
    console.log("Skipping mock MetaMorpho reward manager deployment on non-test network");
    return;
  }

  // Get dependencies
  const sdUSDCollateralVault = await get(SDUSD_COLLATERAL_VAULT_ID);
  const sdUSDRouter = await get(SDUSD_ROUTER_ID);
  const mockMetaMorphoVaultdUSD = await get("MockMetaMorphoVault_dUSD");
  const mockURD = await get("MockUniversalRewardsDistributor");

  // Deploy DStakeRewardManagerMetaMorpho for sdUSD
  const sdUSDRewardManager = await deploy("DStakeRewardManagerMetaMorpho_sdUSD", {
    from: deployer,
    contract: "DStakeRewardManagerMetaMorpho",
    args: [
      sdUSDCollateralVault.address,
      sdUSDRouter.address,
      mockMetaMorphoVaultdUSD.address,
      mockURD.address,
      deployer, // treasury
      300000, // max treasury fee (30%)
      50000, // initial treasury fee (5%)
      hre.ethers.parseEther("1"), // exchange threshold
    ],
    log: true,
  });

  // Get sdETH dependencies
  const sdETHCollateralVault = await get(SDETH_COLLATERAL_VAULT_ID);
  const sdETHRouter = await get(SDETH_ROUTER_ID);
  const mockMetaMorphoVaultdETH = await get("MockMetaMorphoVault_dETH");

  // Deploy DStakeRewardManagerMetaMorpho for sdETH
  const sdETHRewardManager = await deploy("DStakeRewardManagerMetaMorpho_sdETH", {
    from: deployer,
    contract: "DStakeRewardManagerMetaMorpho",
    args: [
      sdETHCollateralVault.address,
      sdETHRouter.address,
      mockMetaMorphoVaultdETH.address,
      mockURD.address,
      deployer, // treasury
      300000, // max treasury fee (30%)
      50000, // initial treasury fee (5%)
      hre.ethers.parseEther("0.01"), // exchange threshold
    ],
    log: true,
  });

  console.log(`Deployed MetaMorpho reward managers:
    - sdUSD: ${sdUSDRewardManager.address}
    - sdETH: ${sdETHRewardManager.address}`);
};

func.tags = ["mock-metamorpho-rewards"];
func.dependencies = [
  "mock-metamorpho-vaults",
  "mock-urd",
  "dStake", // Use real dStake deployment, not mock
];

export default func;
