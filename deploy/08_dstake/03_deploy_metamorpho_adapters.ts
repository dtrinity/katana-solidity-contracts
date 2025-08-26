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
    args: [dusd.address, mockMetaMorphoVaultdUSD.address, sdUSDCollateralVault.address],
    log: true,
  });

  // Register adapter with router
  const sdUSDRouterContract = await hre.ethers.getContractAt("DStakeRouter", sdUSDRouter.address);

  // Check if adapter is already registered
  const currentAdapter = await sdUSDRouterContract.vaultAssetToAdapter(mockMetaMorphoVaultdUSD.address);

  if (currentAdapter === hre.ethers.ZeroAddress) {
    await sdUSDRouterContract.addAdapter(mockMetaMorphoVaultdUSD.address, adapterDUSD.address);
    console.log(`Registered MetaMorpho adapter for dUSD with router`);
  }

  // Set default deposit vault asset for the router (needed for compounding)
  await sdUSDRouterContract.setDefaultDepositVaultAsset(mockMetaMorphoVaultdUSD.address);
  console.log(`Set default deposit vault asset for sdUSD router`);

  // Configure dStakeToken with collateralVault and router since configure script might skip
  const dStakeTokenDeployment = await get("DStakeToken_sdUSD");
  const collateralVaultDeployment = await get("DStakeCollateralVault_sdUSD");
  const dStakeToken = await hre.ethers.getContractAt("DStakeToken", dStakeTokenDeployment.address);

  const currentRouter = await dStakeToken.router();

  if (currentRouter === hre.ethers.ZeroAddress) {
    await dStakeToken.setRouter(sdUSDRouter.address);
    console.log(`Set router for sdUSD dStakeToken`);
  }

  const currentVault = await dStakeToken.collateralVault();

  if (currentVault === hre.ethers.ZeroAddress) {
    await dStakeToken.setCollateralVault(collateralVaultDeployment.address);
    console.log(`Set collateralVault for sdUSD dStakeToken`);
  }

  // Deploy for dETH
  const deth = await get("dETH");
  const sdETHCollateralVault = await get("DStakeCollateralVault_sdETH");
  const sdETHRouter = await get("DStakeRouter_sdETH");
  const mockMetaMorphoVaultdETH = await get("MockMetaMorphoVault_dETH");

  const adapterDETH = await deploy("MetaMorphoConversionAdapter_dETH", {
    from: deployer,
    contract: "MetaMorphoConversionAdapter",
    args: [deth.address, mockMetaMorphoVaultdETH.address, sdETHCollateralVault.address],
    log: true,
  });

  // Register adapter with router
  const sdETHRouterContract = await hre.ethers.getContractAt("DStakeRouter", sdETHRouter.address);

  const currentAdapterETH = await sdETHRouterContract.vaultAssetToAdapter(mockMetaMorphoVaultdETH.address);

  if (currentAdapterETH === hre.ethers.ZeroAddress) {
    await sdETHRouterContract.addAdapter(mockMetaMorphoVaultdETH.address, adapterDETH.address);
    console.log(`Registered MetaMorpho adapter for dETH with router`);
  }

  // Set default deposit vault asset for the router (needed for compounding)
  await sdETHRouterContract.setDefaultDepositVaultAsset(mockMetaMorphoVaultdETH.address);
  console.log(`Set default deposit vault asset for sdETH router`);

  // Configure dStakeToken with collateralVault and router since configure script might skip
  const dStakeTokenDeploymentETH = await get("DStakeToken_sdETH");
  const collateralVaultDeploymentETH = await get("DStakeCollateralVault_sdETH");
  const dStakeTokenETH = await hre.ethers.getContractAt("DStakeToken", dStakeTokenDeploymentETH.address);

  const currentRouterETH = await dStakeTokenETH.router();

  if (currentRouterETH === hre.ethers.ZeroAddress) {
    await dStakeTokenETH.setRouter(sdETHRouter.address);
    console.log(`Set router for sdETH dStakeToken`);
  }

  const currentVaultETH = await dStakeTokenETH.collateralVault();

  if (currentVaultETH === hre.ethers.ZeroAddress) {
    await dStakeTokenETH.setCollateralVault(collateralVaultDeploymentETH.address);
    console.log(`Set collateralVault for sdETH dStakeToken`);
  }
};

func.tags = ["metamorpho-adapters", "dStake"];
func.dependencies = ["mock-metamorpho-vaults"];

export default func;
