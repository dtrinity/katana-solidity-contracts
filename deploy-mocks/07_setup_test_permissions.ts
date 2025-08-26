import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { DUSD_TOKEN_ID, DETH_TOKEN_ID } from "../typescript/deploy-ids";
import { getConfig } from "../config/config";

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

  // Setup DStakeRouter permissions if deployed
  const config = await getConfig(hre);
  
  if (config.dStake) {
    console.log("Setting up DStakeRouter test permissions...");
    
    // Get test signers (the first signer is typically the one used as 'owner' in tests)
    const signers = await hre.ethers.getSigners();
    const ownerSigner = signers[0]; // This is the test 'owner' - 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
    
    for (const instanceKey in config.dStake) {
      const routerDeploymentName = `DStakeRouter_${instanceKey}`;
      const routerDeployment = await deployments.getOrNull(routerDeploymentName);
      
      if (routerDeployment) {
        try {
          const routerContract = await hre.ethers.getContractAt("DStakeRouter", routerDeployment.address);
          const DEFAULT_ADMIN_ROLE = await routerContract.DEFAULT_ADMIN_ROLE();
          
          // Check if owner already has the role
          const ownerHasRole = await routerContract.hasRole(DEFAULT_ADMIN_ROLE, ownerSigner.address);
          
          if (!ownerHasRole) {
            // The deployer should have DEFAULT_ADMIN_ROLE from the router constructor
            const deployerSigner = await hre.ethers.getSigner(deployer);
            const deployerHasRole = await routerContract.hasRole(DEFAULT_ADMIN_ROLE, deployer);
            
            if (deployerHasRole) {
              await routerContract.connect(deployerSigner).grantRole(DEFAULT_ADMIN_ROLE, ownerSigner.address);
              console.log(`Granted DEFAULT_ADMIN_ROLE to test owner for ${routerDeploymentName}`);
            } else {
              console.log(`Warning: Deployer doesn't have DEFAULT_ADMIN_ROLE for ${routerDeploymentName}`);
            }
          } else {
            console.log(`Test owner already has DEFAULT_ADMIN_ROLE for ${routerDeploymentName}`);
          }
        } catch (error) {
          console.log(`Could not grant DEFAULT_ADMIN_ROLE for ${routerDeploymentName}:`, error);
        }
      }
    }
  }
};

func.tags = ["test-permissions"];
func.dependencies = ["dusd", "deth", "dStake"];

export default func;