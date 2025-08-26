import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { DUSD_TOKEN_ID, DETH_TOKEN_ID } from "../typescript/deploy-ids";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deployer, user1 } = await getNamedAccounts();

  // Only setup test permissions on test networks
  if (hre.network.name !== "localhost" && hre.network.name !== "hardhat") {
    console.log("Skipping test permission setup on non-test network");
    return;
  }

  console.log("Setting up test permissions...");

  // Grant MINTER_ROLE to deployer for testing
  const MINTER_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("MINTER_ROLE"));

  // Setup dUSD permissions if deployed
  const dUSDDeployment = await deployments.getOrNull(DUSD_TOKEN_ID);
  if (dUSDDeployment) {
    const dUSDContract = await hre.ethers.getContractAt("ERC20StablecoinUpgradeable", dUSDDeployment.address);
    
    try {
      const hasRole = await dUSDContract.hasRole(MINTER_ROLE, deployer);
      if (!hasRole) {
        // The dUSD contract is controlled by the issuer, not directly by governance
        // We need to use the issuer to mint, or grant role directly if we have admin rights
        const DEFAULT_ADMIN_ROLE = await dUSDContract.DEFAULT_ADMIN_ROLE();
        const hasAdminRole = await dUSDContract.hasRole(DEFAULT_ADMIN_ROLE, deployer);
        
        if (hasAdminRole) {
          await dUSDContract.grantRole(MINTER_ROLE, deployer);
          console.log("Granted MINTER_ROLE to deployer for dUSD testing");
        } else {
          // Use user1 (governance) to grant the role
          const signers = await hre.ethers.getSigners();
          const user1Signer = signers[1]; // user1 is the second signer
          await dUSDContract.connect(user1Signer).grantRole(MINTER_ROLE, deployer);
          console.log("Granted MINTER_ROLE to deployer for dUSD testing (via governance)");
        }
      } else {
        console.log("Deployer already has MINTER_ROLE for dUSD");
      }
    } catch (error) {
      console.log("Could not grant MINTER_ROLE for dUSD:", error);
    }
  }

  // Setup dETH permissions if deployed
  const dETHDeployment = await deployments.getOrNull(DETH_TOKEN_ID);
  if (dETHDeployment) {
    const dETHContract = await hre.ethers.getContractAt("ERC20StablecoinUpgradeable", dETHDeployment.address);
    
    try {
      const hasRole = await dETHContract.hasRole(MINTER_ROLE, deployer);
      if (!hasRole) {
        // Similar logic for dETH
        const DEFAULT_ADMIN_ROLE = await dETHContract.DEFAULT_ADMIN_ROLE();
        const hasAdminRole = await dETHContract.hasRole(DEFAULT_ADMIN_ROLE, deployer);
        
        if (hasAdminRole) {
          await dETHContract.grantRole(MINTER_ROLE, deployer);
          console.log("Granted MINTER_ROLE to deployer for dETH testing");
        } else {
          // Use user1 (governance) to grant the role
          const signers = await hre.ethers.getSigners();
          const user1Signer = signers[1]; // user1 is the second signer
          await dETHContract.connect(user1Signer).grantRole(MINTER_ROLE, deployer);
          console.log("Granted MINTER_ROLE to deployer for dETH testing (via governance)");
        }
      } else {
        console.log("Deployer already has MINTER_ROLE for dETH");
      }
    } catch (error) {
      console.log("Could not grant MINTER_ROLE for dETH:", error);
    }
  }

  console.log("Test permissions setup completed for dUSD and dETH tokens");
  
  // Note: DStakeRouter permissions are now handled in dSTAKE-specific test fixtures
  // to avoid global side effects that don't reflect reality
};

func.tags = ["test-permissions"];
func.dependencies = ["dusd", "deth"];

export default func;