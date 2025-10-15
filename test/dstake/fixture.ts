import { BigNumberish, ethers } from "ethers";
import { deployments } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import { ERC20 } from "../../typechain-types";
import { IERC20 } from "../../typechain-types/@openzeppelin/contracts/token/ERC20/IERC20";
import { resolveRoleSigner, ensureRoleGranted } from "./utils/roleHelpers";
import {
  DETH_A_TOKEN_WRAPPER_ID,
  DUSD_A_TOKEN_WRAPPER_ID,
  SDETH_COLLATERAL_VAULT_ID,
  SDETH_DSTAKE_TOKEN_ID,
  SDETH_ROUTER_ID,
  SDUSD_COLLATERAL_VAULT_ID,
  SDUSD_DSTAKE_TOKEN_ID,
  SDUSD_ROUTER_ID,
} from "../../typescript/deploy-ids";
import { getTokenContractForSymbol } from "../../typescript/token/utils";
import { DETH_CONFIG, DStableFixtureConfig, DUSD_CONFIG } from "../dstable/fixtures";

export interface DStakeFixtureConfig {
  dStableSymbol: "dUSD" | "dETH";
  DStakeTokenV2Symbol: string;
  DStakeTokenV2ContractId: string;
  collateralVaultContractId: string;
  routerContractId: string;
  defaultStrategyShareSymbol: string;
  name?: string;
  underlyingDStableConfig: DStableFixtureConfig;
  deploymentTags: string[];
}

export const SDUSD_CONFIG: DStakeFixtureConfig = {
  dStableSymbol: "dUSD",
  DStakeTokenV2Symbol: "sdUSD",
  DStakeTokenV2ContractId: SDUSD_DSTAKE_TOKEN_ID,
  collateralVaultContractId: SDUSD_COLLATERAL_VAULT_ID,
  routerContractId: SDUSD_ROUTER_ID,
  defaultStrategyShareSymbol: "wddUSD",
  underlyingDStableConfig: DUSD_CONFIG,
  deploymentTags: [
    "local-setup", // mock tokens and oracles
    "oracle", // mock oracle setup uses this tag
    "dusd", // underlying dStable token tag
    "dUSD-aTokenWrapper", // static aToken wrapper for dUSD
    "dlend", // dLend core and periphery
    "dStake", // dStake core, adapters, and configuration
    "ds", // Required by the Redstone plain feed setup
  ],
};

export const SDETH_CONFIG: DStakeFixtureConfig = {
  dStableSymbol: "dETH",
  DStakeTokenV2Symbol: "sdETH",
  DStakeTokenV2ContractId: SDETH_DSTAKE_TOKEN_ID,
  collateralVaultContractId: SDETH_COLLATERAL_VAULT_ID,
  routerContractId: SDETH_ROUTER_ID,
  defaultStrategyShareSymbol: "wdETH",
  underlyingDStableConfig: DETH_CONFIG,
  deploymentTags: ["local-setup", "oracle", "deth", "dETH-aTokenWrapper", "dlend", "dStake"],
};

// Array of all DStake configurations
export const DSTAKE_CONFIGS: DStakeFixtureConfig[] = [SDUSD_CONFIG, SDETH_CONFIG];

// Core logic for fetching dStake components *after* deployments are done
/**
 *
 * @param hreElements
 * @param hreElements.deployments
 * @param hreElements.getNamedAccounts
 * @param hreElements.ethers
 * @param hreElements.globalHre
 * @param config
 */
async function fetchDStakeComponents(
  hreElements: {
    deployments: HardhatRuntimeEnvironment["deployments"];
    getNamedAccounts: HardhatRuntimeEnvironment["getNamedAccounts"];
    ethers: HardhatRuntimeEnvironment["ethers"];
    globalHre: HardhatRuntimeEnvironment; // For getTokenContractForSymbol
  },
  config: DStakeFixtureConfig,
) {
  const { deployments, getNamedAccounts, ethers, globalHre } = hreElements;
  const namedAccounts = await getNamedAccounts();
  const deployer = namedAccounts.deployer;
  const governance = namedAccounts.governance;
  const deployerSigner = await ethers.getSigner(deployer);

  const { contract: dStableToken, tokenInfo: dStableInfo } = await getTokenContractForSymbol(globalHre, deployer, config.dStableSymbol);

  const dStakeTokenDeployment = await deployments.get(config.DStakeTokenV2ContractId);
  const collateralVaultDeployment = await deployments.get(config.collateralVaultContractId);
  const routerDeployment = await deployments.get(config.routerContractId);

  const DStakeTokenV2 = await ethers.getContractAt("DStakeTokenV2", dStakeTokenDeployment.address);
  const collateralVault = await ethers.getContractAt("DStakeCollateralVaultV2", collateralVaultDeployment.address);
  const router = await ethers.getContractAt("DStakeRouterV2", routerDeployment.address);

  const signers = await ethers.getSigners();
  const testOwner = signers[0];

  const routerAdminRole = await router.DEFAULT_ADMIN_ROLE();
  const routerAdminSigner = await resolveRoleSigner(
    router,
    routerAdminRole,
    [testOwner.address, deployerSigner.address, governance, routerDeployment.receipt?.from],
    deployerSigner,
  );

  await ensureRoleGranted(router, routerAdminRole, routerAdminSigner, routerAdminSigner);
  await ensureRoleGranted(router, routerAdminRole, testOwner, routerAdminSigner);

  const configManagerRole = await router.CONFIG_MANAGER_ROLE();
  const adapterManagerRole = await router.ADAPTER_MANAGER_ROLE();
  const vaultManagerRole = await router.VAULT_MANAGER_ROLE();

  await ensureRoleGranted(router, configManagerRole, testOwner, routerAdminSigner);
  await ensureRoleGranted(router, adapterManagerRole, testOwner, routerAdminSigner);
  await ensureRoleGranted(router, vaultManagerRole, testOwner, routerAdminSigner);

  let strategyShareAddress = await router.defaultDepositStrategyShare();
  if (strategyShareAddress === ethers.ZeroAddress) {
    const expectedDeploymentId = config.dStableSymbol === "dUSD" ? DUSD_A_TOKEN_WRAPPER_ID : DETH_A_TOKEN_WRAPPER_ID;
    const wrapperDeployment = await deployments.getOrNull(expectedDeploymentId);
    if (!wrapperDeployment) {
      throw new Error(`Router missing default deposit strategy share and expected deployment ${expectedDeploymentId} is not available`);
    }
    strategyShareAddress = wrapperDeployment.address;
  }
  const wrappedAToken = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", strategyShareAddress);
  const adapterAddress = await router.strategyShareToAdapter(strategyShareAddress);
  if (adapterAddress === ethers.ZeroAddress) {
    throw new Error(`Adapter missing for strategy share ${strategyShareAddress}`);
  }
  const adapter = await ethers.getContractAt("IDStableConversionAdapterV2", adapterAddress);

  const collateralAdminRole = await collateralVault.DEFAULT_ADMIN_ROLE();
  const collateralAdminSigner = await resolveRoleSigner(
    collateralVault,
    collateralAdminRole,
    [testOwner.address, deployerSigner.address, governance, collateralVaultDeployment.receipt?.from],
    deployerSigner,
  );

  await ensureRoleGranted(collateralVault, collateralAdminRole, testOwner, collateralAdminSigner);

  const routerRole = await collateralVault.ROUTER_ROLE();
  const routerAddress = await router.getAddress();
  if ((await collateralVault.router()).toLowerCase() !== routerAddress.toLowerCase()) {
    await collateralVault.connect(testOwner).setRouter(routerAddress);
  }
  if (!(await collateralVault.hasRole(routerRole, routerAddress))) {
    await collateralVault.connect(testOwner).grantRole(routerRole, routerAddress);
  }
  if (!(await collateralVault.hasRole(routerRole, testOwner.address))) {
    await collateralVault.connect(testOwner).grantRole(routerRole, testOwner.address);
  }

  const supportedShares = await collateralVault.getSupportedStrategyShares();
  if (!supportedShares.includes(strategyShareAddress)) {
    await collateralVault.connect(testOwner).addSupportedStrategyShare(strategyShareAddress);
  }

  let activeVaults: string[] = [];
  try {
    activeVaults = await router.getActiveVaultsForDeposits();
  } catch {
    activeVaults = [];
  }

  if (activeVaults.length === 0) {
    if (!(await router.hasRole(adapterManagerRole, testOwner.address))) {
      await router.connect(routerAdminSigner).grantRole(adapterManagerRole, testOwner.address);
    }
    if (!(await router.hasRole(configManagerRole, testOwner.address))) {
      await router.connect(routerAdminSigner).grantRole(configManagerRole, testOwner.address);
    }
    if (!(await router.hasRole(vaultManagerRole, testOwner.address))) {
      await router.connect(routerAdminSigner).grantRole(vaultManagerRole, testOwner.address);
    }

    if (!(await router.vaultExists(strategyShareAddress))) {
      await router.connect(testOwner).addVaultConfig(strategyShareAddress, adapterAddress, 1_000_000, 0);
    } else {
      await router.connect(testOwner).updateVaultConfig(strategyShareAddress, adapterAddress, 1_000_000, 0);
    }

    await router.connect(testOwner).setDefaultDepositStrategyShare(strategyShareAddress);
  }

  return {
    config,
    DStakeTokenV2,
    collateralVault,
    router,
    dStableToken: dStableToken as unknown as ERC20,
    dStableInfo,
    strategyShareToken: wrappedAToken as unknown as IERC20,
    strategyShareAddress: strategyShareAddress,
    adapter,
    adapterAddress,
    deployer: deployerSigner,
  };
}

// Note: dLEND reward setup functions have been removed as dLEND support is deprecated.
// Use MetaMorpho reward management instead.

export const createDStakeFixture = (config: DStakeFixtureConfig) => {
  return deployments.createFixture(async (hreFixtureEnv: HardhatRuntimeEnvironment) => {
    // Clean slate: run all default deployment scripts
    await hreFixtureEnv.deployments.fixture();
    // Run DStake-specific deployment tags
    await hreFixtureEnv.deployments.fixture(config.deploymentTags);
    // Fetch DStake components using fixture environment
    return fetchDStakeComponents(
      {
        deployments: hreFixtureEnv.deployments,
        getNamedAccounts: hreFixtureEnv.getNamedAccounts,
        ethers: hreFixtureEnv.ethers,
        globalHre: hreFixtureEnv,
      },
      config,
    );
  });
};

// Note: dLEND reward fixtures have been removed.
// Use MetaMorpho-specific test fixtures from MetaMorpho test files instead.
