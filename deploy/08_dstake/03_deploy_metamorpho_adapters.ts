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
      args: [
        dusd.address,
        mockMetaMorphoVaultdUSD.address,
        sdUSDCollateralVault.address,
      ],
      log: true,
    });

    // Register adapter with router
    const sdUSDRouterContract = await hre.ethers.getContractAt(
      "DStakeRouterDLend",
      sdUSDRouter.address
    );
    
    // Check if adapter is already registered
    const currentAdapter = await sdUSDRouterContract.vaultAssetToAdapter(mockMetaMorphoVaultdUSD.address);
    if (currentAdapter === hre.ethers.ZeroAddress) {
      await sdUSDRouterContract.addAdapter(
        mockMetaMorphoVaultdUSD.address,
        adapterDUSD.address
      );
      console.log(`Registered MetaMorpho adapter for dUSD with router`);
    }
    
    // Set default deposit vault asset for the router (needed for compounding)
    await sdUSDRouterContract.setDefaultDepositVaultAsset(mockMetaMorphoVaultdUSD.address);
    console.log(`Set default deposit vault asset for sdUSD router`);

    // Deploy for dETH
    const deth = await get("dETH");
    const sdETHCollateralVault = await get("DStakeCollateralVault_sdETH");
    const sdETHRouter = await get("DStakeRouter_sdETH");
    const mockMetaMorphoVaultdETH = await get("MockMetaMorphoVault_dETH");

    const adapterDETH = await deploy("MetaMorphoConversionAdapter_dETH", {
      from: deployer,
      contract: "MetaMorphoConversionAdapter",
      args: [
        deth.address,
        mockMetaMorphoVaultdETH.address,
        sdETHCollateralVault.address,
      ],
      log: true,
    });

    // Register adapter with router
    const sdETHRouterContract = await hre.ethers.getContractAt(
      "DStakeRouterDLend",
      sdETHRouter.address
    );
    
    const currentAdapterETH = await sdETHRouterContract.vaultAssetToAdapter(mockMetaMorphoVaultdETH.address);
    if (currentAdapterETH === hre.ethers.ZeroAddress) {
      await sdETHRouterContract.addAdapter(
        mockMetaMorphoVaultdETH.address,
        adapterDETH.address
      );
      console.log(`Registered MetaMorpho adapter for dETH with router`);
    }
    
    // Set default deposit vault asset for the router (needed for compounding)
    await sdETHRouterContract.setDefaultDepositVaultAsset(mockMetaMorphoVaultdETH.address);
    console.log(`Set default deposit vault asset for sdETH router`);
};

func.tags = ["metamorpho-adapters", "dStake"];
func.dependencies = [
  "mock-metamorpho-vaults"
];

export default func;