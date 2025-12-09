import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

import { getConfig } from "../../config/config";
import {
  DUSD_COLLATERAL_VAULT_CONTRACT_ID,
  DUSD_ISSUER_V2_CONTRACT_ID,
  DUSD_REDEEMER_CONTRACT_ID,
  DUSD_TOKEN_ID,
} from "../../typescript/deploy-ids";
import { GovernanceExecutor } from "../../typescript/hardhat/governance";

/**
 *
 * @param contractAddress
 * @param role
 * @param grantee
 * @param contractInterface
 */
/**
 * Build a Safe-friendly grantRole transaction payload.
 *
 * @param contractAddress Address of the target contract
 * @param role Role hash to grant
 * @param grantee Address to receive the role
 * @param contractInterface ABI interface for encoding data
 */
function createGrantRoleTransaction(
  contractAddress: string,
  role: string,
  grantee: string,
  contractInterface: any,
): { to: string; value: string; data: string } {
  return {
    to: contractAddress,
    value: "0",
    data: contractInterface.encodeFunctionData("grantRole", [role, grantee]),
  };
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, ethers, getNamedAccounts } = hre;
  const { deploy } = deployments;

  const { deployer } = await getNamedAccounts();
  const deployerSigner = await ethers.getSigner(deployer);
  const config = await getConfig(hre);
  const executor = new GovernanceExecutor(hre, deployerSigner, config.safeConfig);
  await executor.initialize();

  const lifiRouter = config.lifi?.diamond;

  if (!lifiRouter) {
    console.log("Skipping FlashMintCollateralExchanger deployment: no LiFi router configured in config.lifi.diamond");
    return true;
  }

  const dstableAddress = (await deployments.get(DUSD_TOKEN_ID)).address;
  const redeemerDeployment = await deployments.get(DUSD_REDEEMER_CONTRACT_ID);
  const issuerDeployment = await deployments.get(DUSD_ISSUER_V2_CONTRACT_ID);
  const vaultDeployment = await deployments.get(DUSD_COLLATERAL_VAULT_CONTRACT_ID);

  console.log("Deploying FlashMintCollateralExchanger (dUSD)...");
  const deployment = await deploy("FlashMintCollateralExchanger", {
    from: deployer,
    args: [
      dstableAddress,
      dstableAddress,
      redeemerDeployment.address,
      issuerDeployment.address,
      vaultDeployment.address,
      config.walletAddresses.governanceMultisig,
    ],
    log: true,
    autoMine: true,
  });

  const exchanger = await ethers.getContractAt("FlashMintCollateralExchanger", deployment.address, deployerSigner);
  const redeemer = await ethers.getContractAt("RedeemerV2", redeemerDeployment.address, deployerSigner);
  const governance = config.walletAddresses.governanceMultisig;
  const DEFAULT_ADMIN_ROLE = await exchanger.DEFAULT_ADMIN_ROLE();

  if (lifiRouter) {
    const currentRouter = await exchanger.swapRouter();

    if (currentRouter.toLowerCase() !== lifiRouter.toLowerCase()) {
      const complete = await executor.tryOrQueue(
        async () => {
          await exchanger.setSwapRouter(lifiRouter);
          console.log(`    ➕ set swap router ${lifiRouter}`);
        },
        () => ({
          to: deployment.address,
          value: "0",
          data: exchanger.interface.encodeFunctionData("setSwapRouter", [lifiRouter]),
        }),
      );
      if (!complete) console.log(`    🔄 pending Safe tx to set swap router ${lifiRouter}`);
    }
  }

  console.log("Granting DEFAULT_ADMIN_ROLE on exchanger to governance multisig...");

  if (!(await exchanger.hasRole(DEFAULT_ADMIN_ROLE, governance))) {
    const complete = await executor.tryOrQueue(
      async () => {
        await exchanger.grantRole(DEFAULT_ADMIN_ROLE, governance);
        console.log(`    ➕ granted DEFAULT_ADMIN_ROLE to ${governance}`);
      },
      () => ({
        to: deployment.address,
        value: "0",
        data: exchanger.interface.encodeFunctionData("grantRole", [DEFAULT_ADMIN_ROLE, governance]),
      }),
    );
    if (!complete) console.log(`    🔄 pending Safe tx for DEFAULT_ADMIN_ROLE to ${governance}`);
  } else {
    console.log("    ✓ DEFAULT_ADMIN_ROLE already granted to governance");
  }

  console.log("Granting REDEMPTION_MANAGER_ROLE on RedeemerV2 to exchanger (for protocol redemptions)...");
  const REDEMPTION_MANAGER_ROLE = await redeemer.REDEMPTION_MANAGER_ROLE();

  if (!(await redeemer.hasRole(REDEMPTION_MANAGER_ROLE, deployment.address))) {
    const complete = await executor.tryOrQueue(
      async () => {
        await redeemer.grantRole(REDEMPTION_MANAGER_ROLE, deployment.address);
        console.log(`    ➕ granted REDEMPTION_MANAGER_ROLE to ${deployment.address}`);
      },
      () => createGrantRoleTransaction(redeemerDeployment.address, REDEMPTION_MANAGER_ROLE, deployment.address, redeemer.interface),
    );
    if (!complete) console.log(`    🔄 pending Safe tx for REDEMPTION_MANAGER_ROLE to ${deployment.address}`);
  } else {
    console.log("    ✓ role already granted");
  }

  console.log("Granting OPERATOR_ROLE on exchanger to governance multisig...");
  const OPERATOR_ROLE = await exchanger.OPERATOR_ROLE();

  if (!(await exchanger.hasRole(OPERATOR_ROLE, governance))) {
    const complete = await executor.tryOrQueue(
      async () => {
        await exchanger.grantRole(OPERATOR_ROLE, governance);
        console.log(`    ➕ granted OPERATOR_ROLE to ${governance}`);
      },
      () => createGrantRoleTransaction(deployment.address, OPERATOR_ROLE, governance, exchanger.interface),
    );
    if (!complete) console.log(`    🔄 pending Safe tx for OPERATOR_ROLE to ${governance}`);
  } else {
    console.log("    ✓ OPERATOR_ROLE already granted to governance");
  }

  console.log("Queueing revocation of deployer admin/operator roles for post-test cleanup...");

  const maybeQueueRevocation = async (role: string, label: string): Promise<void> => {
    const hasRole = await exchanger.hasRole(role, deployer);

    if (!hasRole) {
      console.log(`    ✓ ${label} already revoked from deployer`);
      return;
    }
    const complete = await executor.tryOrQueue(
      async () => {
        if (executor.useSafe) {
          throw new Error("queue_only");
        }
        await exchanger.revokeRole(role, deployer);
        console.log(`    ➖ revoked ${label} from deployer`);
      },
      () => ({
        to: deployment.address,
        value: "0",
        data: exchanger.interface.encodeFunctionData("revokeRole", [role, deployer]),
      }),
    );
    if (!complete) console.log(`    🔄 pending Safe tx to revoke ${label} from deployer`);
  };

  await maybeQueueRevocation(DEFAULT_ADMIN_ROLE, "DEFAULT_ADMIN_ROLE");
  await maybeQueueRevocation(OPERATOR_ROLE, "OPERATOR_ROLE");

  await executor.flush("FlashMintCollateralExchanger setup (dUSD)");
  console.log(`≻ ${__filename.split("/").slice(-2).join("/")}: ✅`);

  return true;
};

func.tags = ["dusd", "flash-exchanger"];
func.dependencies = [DUSD_REDEEMER_CONTRACT_ID, DUSD_ISSUER_V2_CONTRACT_ID, DUSD_COLLATERAL_VAULT_CONTRACT_ID, DUSD_TOKEN_ID];
func.id = "DUSD_FLASH_MINT_COLLATERAL_EXCHANGER";

export default func;
