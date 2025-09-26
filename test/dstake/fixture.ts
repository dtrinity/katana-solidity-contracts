import { BigNumberish, ethers } from "ethers";
import { deployments } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import { ERC20 } from "../../typechain-types";
import { IERC20 } from "../../typechain-types/@openzeppelin/contracts/token/ERC20/IERC20";
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
  config: DStakeFixtureConfig
) {
  const { deployments, getNamedAccounts, ethers, globalHre } = hreElements;
  const { deployer } = await getNamedAccounts();
  const deployerSigner = await ethers.getSigner(deployer);

  const { contract: dStableToken, tokenInfo: dStableInfo } = await getTokenContractForSymbol(globalHre, deployer, config.dStableSymbol);

  const DStakeTokenV2 = await ethers.getContractAt("DStakeTokenV2", (await deployments.get(config.DStakeTokenV2ContractId)).address);

  const collateralVault = await ethers.getContractAt(
    "DStakeCollateralVaultV2",
    (await deployments.get(config.collateralVaultContractId)).address
  );

  const router = await ethers.getContractAt("DStakeRouterV2", (await deployments.get(config.routerContractId)).address);

  // Setup basic admin permissions for DStakeRouterV2
  // Grant DEFAULT_ADMIN_ROLE to the first test signer (standard test owner)
  const signers = await ethers.getSigners();
  const testOwner = signers[0]; // Standard test owner address
  const DEFAULT_ADMIN_ROLE = await router.DEFAULT_ADMIN_ROLE();

  try {
    const ownerHasRole = await router.hasRole(DEFAULT_ADMIN_ROLE, testOwner.address);
    if (!ownerHasRole) {
      const deployerHasRole = await router.hasRole(DEFAULT_ADMIN_ROLE, deployer);
      if (deployerHasRole) {
        await router.connect(deployerSigner).grantRole(DEFAULT_ADMIN_ROLE, testOwner.address);
      }
    }
  } catch (error) {
    // Ignore permission setup errors in testing
  }

  let strategyShareAddress: string;
  let adapterAddress: string;
  let adapter;
  let wrappedAToken;

  try {
    const wrappedATokenDeployment = await deployments.get(
      config.dStableSymbol === "dUSD" ? DUSD_A_TOKEN_WRAPPER_ID : DETH_A_TOKEN_WRAPPER_ID
    );
    strategyShareAddress = wrappedATokenDeployment.address;
    wrappedAToken = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", strategyShareAddress);
    adapterAddress = await router.strategyShareToAdapter(strategyShareAddress);
    if (adapterAddress !== ethers.ZeroAddress) {
      adapter = await ethers.getContractAt("IDStableConversionAdapterV2", adapterAddress);
    } else {
      adapter = null;
    }
  } catch (error) {
    const mockAdapterFactory = await ethers.getContractFactory("MockAdapterPositiveSlippage");
    const fallbackAdapter = await mockAdapterFactory.deploy(await dStableToken.getAddress(), await collateralVault.getAddress());
    adapterAddress = await fallbackAdapter.getAddress();
    strategyShareAddress = await fallbackAdapter.strategyShare();
    wrappedAToken = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", strategyShareAddress);
    try {
      await router.connect(deployerSigner).addAdapter(strategyShareAddress, adapterAddress);
      adapter = fallbackAdapter;
    } catch (addAdapterError) {
      adapter = fallbackAdapter;
    }
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
      config
    );
  });
};

// Note: dLEND reward fixtures have been removed.
// Use MetaMorpho-specific test fixtures from MetaMorpho test files instead.
