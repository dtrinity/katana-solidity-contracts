import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  console.log("Running mock MetaMorpho vault deployment...");

  // Only deploy mocks on test networks
  const chainId = await hre.getChainId();
  const isTestNetwork = chainId === "31337" || chainId === "737373"; // localhost or Katana testnet

  if (!isTestNetwork) {
    console.log("Skipping mock MetaMorpho vault deployment on production network");
    return;
  }

  // Get deployed dStable tokens to use as underlying assets
  const dUSDDeployment = await deployments.getOrNull("dUSD");
  const dETHDeployment = await deployments.getOrNull("dETH");

  // Deploy MockMetaMorphoVault for dUSD
  if (dUSDDeployment?.address) {
    const deploymentName = "MockMetaMorphoVault_dUSD";
    const existingVault = await deployments.getOrNull(deploymentName);

    if (!existingVault) {
      await deploy(deploymentName, {
        from: deployer,
        contract: "MockMetaMorphoVault",
        args: [dUSDDeployment.address, "Mock MetaMorpho dUSD Vault", "mmvdUSD"],
        log: true,
      });
      console.log(`✅ Deployed ${deploymentName}`);
    } else {
      console.log(`${deploymentName} already deployed at ${existingVault.address}`);
    }
  }

  // Deploy MockMetaMorphoVault for dETH
  if (dETHDeployment?.address) {
    const deploymentName = "MockMetaMorphoVault_dETH";
    const existingVault = await deployments.getOrNull(deploymentName);

    if (!existingVault) {
      await deploy(deploymentName, {
        from: deployer,
        contract: "MockMetaMorphoVault",
        args: [dETHDeployment.address, "Mock MetaMorpho dETH Vault", "mmvdETH"],
        log: true,
      });
      console.log(`✅ Deployed ${deploymentName}`);
    } else {
      console.log(`${deploymentName} already deployed at ${existingVault.address}`);
    }
  }

  // Deploy a generic test vault if we have test tokens
  const testToken = await deployments.getOrNull("TestMintableERC20");
  if (testToken) {
    const deploymentName = "MockMetaMorphoVault_TEST";
    const existingVault = await deployments.getOrNull(deploymentName);

    if (!existingVault) {
      await deploy(deploymentName, {
        from: deployer,
        contract: "MockMetaMorphoVault",
        args: [testToken.address, "Mock MetaMorpho Test Vault", "mmvTEST"],
        log: true,
      });
      console.log(`✅ Deployed ${deploymentName}`);
    } else {
      console.log(`${deploymentName} already deployed at ${existingVault.address}`);
    }
  }

  console.log(`🥩 ${__filename.split("/").slice(-2).join("/")}: ✅`);
};

export default func;
func.tags = ["mock-metamorpho-vaults", "Mocks"];
func.dependencies = ["local-setup", "dusd", "deth"];

// Ensure one-shot execution
func.id = "deploy_mock_metamorpho_vaults";
