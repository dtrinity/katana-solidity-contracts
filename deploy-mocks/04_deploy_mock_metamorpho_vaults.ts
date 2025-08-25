import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  // Only deploy mocks on test networks
  const chainId = await hre.getChainId();
  const isTestNetwork = chainId === "31337" || chainId === "737373"; // localhost or Katana testnet

  if (!isTestNetwork) {
    console.log("Skipping mock MetaMorpho vault deployment on production network");
    return;
  }

  // Get deployed mock tokens to use as underlying assets
  const dUSDDeployment = await deployments.getOrNull("DUSD_TOKEN_ID");
  const dETHDeployment = await deployments.getOrNull("DETH_TOKEN_ID");

  // If no dStable tokens, try to get mock tokens
  let mockUSDCAddress = dUSDDeployment?.address;
  let mockWETHAddress = dETHDeployment?.address;

  if (!mockUSDCAddress) {
    const mockUSDC = await deployments.getOrNull("MockUSDC");
    mockUSDCAddress = mockUSDC?.address;
  }

  if (!mockWETHAddress) {
    const mockWETH = await deployments.getOrNull("MockWETH");
    mockWETHAddress = mockWETH?.address;
  }

  // Deploy MockMetaMorphoVault for USDC/dUSD
  if (mockUSDCAddress) {
    const deploymentName = "MockMetaMorphoVault_USDC";
    const existingVault = await deployments.getOrNull(deploymentName);

    if (!existingVault) {
      await deploy(deploymentName, {
        from: deployer,
        contract: "MockMetaMorphoVault",
        args: [
          mockUSDCAddress,
          "Mock MetaMorpho USDC Vault",
          "mmvUSDC"
        ],
        log: true,
      });
      console.log(`✅ Deployed ${deploymentName}`);
    } else {
      console.log(`${deploymentName} already deployed at ${existingVault.address}`);
    }
  }

  // Deploy MockMetaMorphoVault for WETH/dETH
  if (mockWETHAddress) {
    const deploymentName = "MockMetaMorphoVault_WETH";
    const existingVault = await deployments.getOrNull(deploymentName);

    if (!existingVault) {
      await deploy(deploymentName, {
        from: deployer,
        contract: "MockMetaMorphoVault",
        args: [
          mockWETHAddress,
          "Mock MetaMorpho WETH Vault",
          "mmvWETH"
        ],
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
        args: [
          testToken.address,
          "Mock MetaMorpho Test Vault",
          "mmvTEST"
        ],
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
func.tags = ["MockMetaMorphoVaults", "Mocks"];
func.dependencies = ["MockTokens", "dStableCore"];

// Ensure one-shot execution
func.id = "deploy_mock_metamorpho_vaults";