import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { 
  SDUSD_DSTAKE_TOKEN_ID, 
  SDETH_DSTAKE_TOKEN_ID,
  SDUSD_COLLATERAL_VAULT_ID,
  SDETH_COLLATERAL_VAULT_ID,
  SDUSD_ROUTER_ID,
  SDETH_ROUTER_ID,
  DUSD_TOKEN_ID,
  DETH_TOKEN_ID
} from "../typescript/deploy-ids";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer, user1 } = await getNamedAccounts();

  // Only deploy on test networks
  if (hre.network.name !== "localhost" && hre.network.name !== "hardhat") {
    console.log("Skipping mock dStake deployment on non-test network");
    return;
  }

  // Try to deploy sdUSD components if dUSD exists
  const dUSDDeployment = await deployments.getOrNull(DUSD_TOKEN_ID);
  if (dUSDDeployment) {
    // Grant MINTER_ROLE to deployer for testing
    const dUSDContract = await hre.ethers.getContractAt("ERC20StablecoinUpgradeable", dUSDDeployment.address);
    const MINTER_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("MINTER_ROLE"));
    const DEFAULT_ADMIN_ROLE = hre.ethers.ZeroHash;
    
    // Check if deployer has admin role to grant minter role
    const hasAdminRole = await dUSDContract.hasRole(DEFAULT_ADMIN_ROLE, deployer);
    if (hasAdminRole) {
      await dUSDContract.grantRole(MINTER_ROLE, deployer);
      console.log("Granted MINTER_ROLE to deployer for dUSD");
    }
    // Deploy sdUSD token (upgradeable)
    const sdUSD = await deploy(SDUSD_DSTAKE_TOKEN_ID, {
      from: deployer,
      contract: "DStakeToken",
      proxy: {
        execute: {
          init: {
            methodName: "initialize",
            args: [
              dUSDDeployment.address, 
              "Staked dUSD", 
              "sdUSD",
              deployer,  // initialAdmin (needs to be deployer to grant roles)
              user1      // initialFeeManager
            ],
          },
        },
        proxyContract: "OpenZeppelinTransparentProxy",
      },
      log: true,
    });

    // Deploy sdUSD collateral vault
    const sdUSDVault = await deploy(SDUSD_COLLATERAL_VAULT_ID, {
      from: deployer,
      contract: "DStakeCollateralVault",
      args: [sdUSD.address, dUSDDeployment.address],
      log: true,
    });

    // Deploy sdUSD router
    const sdUSDRouter = await deploy(SDUSD_ROUTER_ID, {
      from: deployer,
      contract: "DStakeRouterDLend",
      args: [
        sdUSD.address,
        sdUSDVault.address,
      ],
      log: true,
    });

    // Configure router
    const sdUSDRouterContract = await hre.ethers.getContractAt("DStakeRouterDLend", sdUSDRouter.address);
    // Note: withdrawal fee is set on DStakeToken during initialization, not on router
    // dStable is automatically set from collateral vault
    // Default deposit vault asset will be set after adapter is registered
    
    // Configure DStakeToken with router and collateral vault references
    const sdUSDContract = await hre.ethers.getContractAt("DStakeToken", sdUSD.address);
    await sdUSDContract.setRouter(sdUSDRouter.address);
    await sdUSDContract.setCollateralVault(sdUSDVault.address);

    // Configure CollateralVault with router (grants ROUTER_ROLE automatically)
    const sdUSDVaultContract = await hre.ethers.getContractAt("DStakeCollateralVault", sdUSDVault.address);
    await sdUSDVaultContract.setRouter(sdUSDRouter.address);

    // Grant roles
    const DSTAKE_MINTER_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("MINTER_ROLE"));
    await sdUSDContract.grantRole(DSTAKE_MINTER_ROLE, sdUSDRouter.address);

    const COLLATERAL_EXCHANGER_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("COLLATERAL_EXCHANGER_ROLE"));
    await sdUSDVaultContract.grantRole(COLLATERAL_EXCHANGER_ROLE, sdUSDRouter.address);
    await sdUSDVaultContract.grantRole(COLLATERAL_EXCHANGER_ROLE, user1);

    console.log(`Deployed mock sdUSD dStake components`);
  }

  // Try to deploy sdETH components if dETH exists
  const dETHDeployment = await deployments.getOrNull(DETH_TOKEN_ID);
  if (dETHDeployment) {
    // Grant MINTER_ROLE to deployer for testing
    const dETHContract = await hre.ethers.getContractAt("ERC20StablecoinUpgradeable", dETHDeployment.address);
    const MINTER_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("MINTER_ROLE"));
    const DEFAULT_ADMIN_ROLE = hre.ethers.ZeroHash;
    
    // Check if deployer has admin role to grant minter role
    const hasAdminRole = await dETHContract.hasRole(DEFAULT_ADMIN_ROLE, deployer);
    if (hasAdminRole) {
      await dETHContract.grantRole(MINTER_ROLE, deployer);
      console.log("Granted MINTER_ROLE to deployer for dETH");
    }
    // Deploy sdETH token (upgradeable)
    const sdETH = await deploy(SDETH_DSTAKE_TOKEN_ID, {
      from: deployer,
      contract: "DStakeToken",
      proxy: {
        execute: {
          init: {
            methodName: "initialize",
            args: [
              dETHDeployment.address, 
              "Staked dETH", 
              "sdETH",
              deployer,  // initialAdmin (needs to be deployer to grant roles)
              user1      // initialFeeManager
            ],
          },
        },
        proxyContract: "OpenZeppelinTransparentProxy",
      },
      log: true,
    });

    // Deploy sdETH collateral vault
    const sdETHVault = await deploy(SDETH_COLLATERAL_VAULT_ID, {
      from: deployer,
      contract: "DStakeCollateralVault",
      args: [sdETH.address, dETHDeployment.address],
      log: true,
    });

    // Deploy sdETH router
    const sdETHRouter = await deploy(SDETH_ROUTER_ID, {
      from: deployer,
      contract: "DStakeRouterDLend",
      args: [
        sdETH.address,
        sdETHVault.address,
      ],
      log: true,
    });

    // Configure router
    const sdETHRouterContract = await hre.ethers.getContractAt("DStakeRouterDLend", sdETHRouter.address);
    // Note: withdrawal fee is set on DStakeToken during initialization, not on router
    // dStable is automatically set from collateral vault
    // Default deposit vault asset will be set after adapter is registered
    
    // Configure DStakeToken with router and collateral vault references
    const sdETHContract = await hre.ethers.getContractAt("DStakeToken", sdETH.address);
    await sdETHContract.setRouter(sdETHRouter.address);
    await sdETHContract.setCollateralVault(sdETHVault.address);

    // Configure CollateralVault with router (grants ROUTER_ROLE automatically)
    const sdETHVaultContract = await hre.ethers.getContractAt("DStakeCollateralVault", sdETHVault.address);
    await sdETHVaultContract.setRouter(sdETHRouter.address);

    // Grant roles
    const DSTAKE_MINTER_ROLE_ETH = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("MINTER_ROLE"));
    await sdETHContract.grantRole(DSTAKE_MINTER_ROLE_ETH, sdETHRouter.address);

    const COLLATERAL_EXCHANGER_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("COLLATERAL_EXCHANGER_ROLE"));
    await sdETHVaultContract.grantRole(COLLATERAL_EXCHANGER_ROLE, sdETHRouter.address);
    await sdETHVaultContract.grantRole(COLLATERAL_EXCHANGER_ROLE, user1);

    console.log(`Deployed mock sdETH dStake components`);
  }
};

func.tags = ["mock-dstake"];
func.dependencies = ["dusd", "deth"];

export default func;