import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deploy, get } = deployments;
  const { deployer } = await getNamedAccounts();

  // Only deploy MetaMorpho adapters on test networks or if MetaMorpho vaults exist
  const networkName = hre.network.name;
  const isTestNetwork = networkName === "localhost" || networkName === "hardhat";

  if (!isTestNetwork) {
    console.log("Skipping MetaMorpho adapter deployment on non-test network");
    return;
  }

  // Get dependencies
  const dusd = await get("dUSD");
  const sdUSDCollateralVault = await get("DStakeCollateralVault_sdUSD");
  const sdUSDRouter = await get("DStakeRouter_sdUSD");
  const mockMetaMorphoVaultdUSD = await get("MockMetaMorphoVault_dUSD");

  // Deploy MetaMorphoConversionAdapter for dUSD
  const adapterDUSD = await deploy("MetaMorphoConversionAdapter_dUSD", {
    from: deployer,
    contract: "MetaMorphoConversionAdapter",
    args: [dusd.address, mockMetaMorphoVaultdUSD.address, sdUSDCollateralVault.address, deployer],
    log: true,
  });

  // Register adapter with router
  const deployerSigner = await hre.ethers.getSigner(deployer);
  const sdUSDRouterContract = await hre.ethers.getContractAt("DStakeRouter", sdUSDRouter.address, deployerSigner);

  // Check if adapter is already registered
  const currentAdapter = await sdUSDRouterContract.vaultAssetToAdapter(mockMetaMorphoVaultdUSD.address);

  if (currentAdapter === hre.ethers.ZeroAddress) {
    await sdUSDRouterContract.addAdapter(mockMetaMorphoVaultdUSD.address, adapterDUSD.address);
    console.log(`Registered MetaMorpho adapter for dUSD with router`);
  }

  // Set default deposit vault asset for the router (needed for compounding)
  await sdUSDRouterContract.setDefaultDepositVaultAsset(mockMetaMorphoVaultdUSD.address);
  console.log(`Set default deposit vault asset for sdUSD router`);

  // These configurations should be handled by 03_configure_dstake.ts
  // We'll only do minimal checks here to ensure proper setup
  const dStakeTokenDeployment = await get("DStakeToken_sdUSD");
  const dStakeToken = await hre.ethers.getContractAt("DStakeToken", dStakeTokenDeployment.address);

  const currentRouter = await dStakeToken.router();

  if (currentRouter === hre.ethers.ZeroAddress) {
    console.log(`Warning: sdUSD dStakeToken router not configured. This should have been done by configure script.`);
  }

  // Deploy for dETH
  const deth = await get("dETH");
  const sdETHCollateralVault = await get("DStakeCollateralVault_sdETH");
  const sdETHRouter = await get("DStakeRouter_sdETH");
  const mockMetaMorphoVaultdETH = await get("MockMetaMorphoVault_dETH");

  const adapterDETH = await deploy("MetaMorphoConversionAdapter_dETH", {
    from: deployer,
    contract: "MetaMorphoConversionAdapter",
    args: [deth.address, mockMetaMorphoVaultdETH.address, sdETHCollateralVault.address, deployer],
    log: true,
  });

  // Register adapter with router
  const sdETHRouterContract = await hre.ethers.getContractAt("DStakeRouter", sdETHRouter.address, deployerSigner);

  const currentAdapterETH = await sdETHRouterContract.vaultAssetToAdapter(mockMetaMorphoVaultdETH.address);

  if (currentAdapterETH === hre.ethers.ZeroAddress) {
    await sdETHRouterContract.addAdapter(mockMetaMorphoVaultdETH.address, adapterDETH.address);
    console.log(`Registered MetaMorpho adapter for dETH with router`);
  }

  // Set default deposit vault asset for the router (needed for compounding)
  await sdETHRouterContract.setDefaultDepositVaultAsset(mockMetaMorphoVaultdETH.address);
  console.log(`Set default deposit vault asset for sdETH router`);

  // These configurations should be handled by 03_configure_dstake.ts
  // We'll only do minimal checks here to ensure proper setup
  const dStakeTokenDeploymentETH = await get("DStakeToken_sdETH");
  const dStakeTokenETH = await hre.ethers.getContractAt("DStakeToken", dStakeTokenDeploymentETH.address);

  const currentRouterETH = await dStakeTokenETH.router();

  if (currentRouterETH === hre.ethers.ZeroAddress) {
    console.log(`Warning: sdETH dStakeToken router not configured. This should have been done by configure script.`);
  }
};

func.tags = ["metamorpho-adapters", "dStake"];
func.dependencies = ["mock-metamorpho-vaults"];

export default func;
