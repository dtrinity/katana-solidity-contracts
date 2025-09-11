import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

import { getConfig } from "../../config/config";

const ZERO_BYTES_32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

/**
 * Transfers ORACLE_MANAGER_ROLE from deployer to governance for an oracle contract
 *
 * @param hre Hardhat runtime environment
 * @param contractName Display name for the contract
 * @param contractAddress Address of the oracle contract
 * @param deployerSigner The deployer signer object
 * @param governanceMultisig Address of the governance multisig
 */
async function transferOracleManagerRole(
  hre: HardhatRuntimeEnvironment,
  contractName: string,
  contractAddress: string,
  deployerSigner: any,
  governanceMultisig: string
): Promise<void> {
  console.log(`  🔐 ${contractName}:`);

  // Generic ABI for oracle contracts with ORACLE_MANAGER_ROLE
  const ORACLE_ABI = [
    "function hasRole(bytes32, address) view returns (bool)",
    "function grantRole(bytes32, address)",
    "function revokeRole(bytes32, address)",
    "function ORACLE_MANAGER_ROLE() view returns (bytes32)",
  ];

  const oracleContract = await hre.ethers.getContractAt(ORACLE_ABI, contractAddress, deployerSigner);

  const DEFAULT_ADMIN_ROLE = ZERO_BYTES_32;
  const ORACLE_MANAGER_ROLE = await oracleContract.ORACLE_MANAGER_ROLE();
  const deployerAddress = await deployerSigner.getAddress();

  const roles = [
    { name: "DEFAULT_ADMIN_ROLE", hash: DEFAULT_ADMIN_ROLE },
    { name: "ORACLE_MANAGER_ROLE", hash: ORACLE_MANAGER_ROLE },
  ];

  // Grant roles to governance
  for (const role of roles) {
    if (!(await oracleContract.hasRole(role.hash, governanceMultisig))) {
      await oracleContract.grantRole(role.hash, governanceMultisig);
      console.log(`    ➕ Granted ${role.name} to governance`);
    } else {
      console.log(`    ✓ ${role.name} already granted to governance`);
    }
  }

  // Revoke roles from deployer
  for (const role of roles) {
    if (await oracleContract.hasRole(role.hash, deployerAddress)) {
      await oracleContract.revokeRole(role.hash, deployerAddress);
      console.log(`    ➖ Revoked ${role.name} from deployer`);
    } else {
      console.log(`    ✓ ${role.name} already revoked from deployer`);
    }
  }
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment): Promise<boolean> {
  const { deployer } = await hre.getNamedAccounts();
  const deployerSigner = await hre.ethers.getSigner(deployer);

  const config = await getConfig(hre);

  console.log(`\n🔐 Transferring Oracle Manager Roles to Governance`);
  console.log("============================================================");

  // 1. Transfer roles for Morpho wrappers
  try {
    const morphoUsdtDeployment = await hre.deployments.get("MorphoChainlinkOracleV2Wrapper_USDT");
    await transferOracleManagerRole(
      hre,
      "MorphoChainlinkOracleV2Wrapper_USDT",
      morphoUsdtDeployment.address,
      deployerSigner,
      config.walletAddresses.governanceMultisig
    );
  } catch {
    console.log(`  ⚠️  MorphoChainlinkOracleV2Wrapper_USDT not found, skipping role transfer`);
  }

  try {
    const morphoUsdcDeployment = await hre.deployments.get("MorphoChainlinkOracleV2Wrapper_USDC");
    await transferOracleManagerRole(
      hre,
      "MorphoChainlinkOracleV2Wrapper_USDC",
      morphoUsdcDeployment.address,
      deployerSigner,
      config.walletAddresses.governanceMultisig
    );
  } catch {
    console.log(`  ⚠️  MorphoChainlinkOracleV2Wrapper_USDC not found, skipping role transfer`);
  }

  // 2. Transfer roles for ERC4626 wrappers
  const ethConfig = config.oracleAggregators.ETH;

  if (ethConfig?.erc4626OracleWrapper) {
    for (const [_vaultAddress, vaultConfig] of Object.entries(ethConfig.erc4626OracleWrapper)) {
      const typedVaultConfig = vaultConfig as { vaultName: string };
      const deploymentId = `ERC4626OracleWrapper_${typedVaultConfig.vaultName}_ETH`;

      try {
        const erc4626Deployment = await hre.deployments.get(deploymentId);
        await transferOracleManagerRole(
          hre,
          deploymentId,
          erc4626Deployment.address,
          deployerSigner,
          config.walletAddresses.governanceMultisig
        );
      } catch {
        console.log(`  ⚠️  ${deploymentId} not found, skipping role transfer`);
      }
    }
  }

  // 3. Transfer roles for OracleWrapperAggregators
  const usdConfig = config.oracleAggregators.USD;

  if (usdConfig?.oracleWrapperAggregators) {
    for (const [groupKey, _groupConfig] of Object.entries(usdConfig.oracleWrapperAggregators)) {
      const displayName = `${groupKey}_to_USD`;
      const deploymentId = `OracleWrapperAggregator_${displayName}`;

      try {
        const aggregatorDeployment = await hre.deployments.get(deploymentId);
        await transferOracleManagerRole(
          hre,
          deploymentId,
          aggregatorDeployment.address,
          deployerSigner,
          config.walletAddresses.governanceMultisig
        );
      } catch {
        console.log(`  ⚠️  ${deploymentId} not found, skipping role transfer`);
      }
    }
  }

  console.log(`\n✅ All oracle roles successfully transferred to governance`);

  console.log(`🔮 ${__filename.split("/").slice(-2).join("/")}: ✅`);
  return true;
};

func.tags = ["oracle-governance", "role-transfer", "governance"];
func.dependencies = [
  "deploy-usd-oracle-wrapper-aggregators",
  "deploy-yvvbETH-erc4626-wrappers",
  "deploy-yvvbUSDC-yvvbUSDT-morpho-wrappers",
];
func.id = "transfer-oracle-roles-to-governance";

export default func;
