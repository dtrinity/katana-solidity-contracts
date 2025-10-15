import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  // Only deploy on local/test networks
  if (hre.network.name !== "localhost" && hre.network.name !== "hardhat") {
    console.log("Skipping mock URD deployment on non-test network");
    return;
  }

  // Deploy MockUniversalRewardsDistributor
  const mockURD = await deploy("MockUniversalRewardsDistributor", {
    from: deployer,
    args: [],
    log: true,
  });

  console.log(`Deployed MockUniversalRewardsDistributor at ${mockURD.address}`);
};

func.tags = ["mock-urd"];
func.dependencies = [];

export default func;
