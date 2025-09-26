import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { deployments } from "hardhat";

import {
  DStakeRouterV2,
  MockMetaMorphoVault,
  MockUniversalRewardsDistributor,
  TestMintableERC20,
  DStakeCollateralVaultV2,
  MetaMorphoConversionAdapter,
  DStakeTokenV2
} from "../../typechain-types";
import { DStakeFixtureConfig, SDUSD_CONFIG } from "./fixture";
import { getTokenContractForSymbol } from "../../typescript/token/utils";
import { resolveRoleSigner, ensureRoleGranted } from "./utils/roleHelpers";

export const VaultStatus = {
  Active: 0,
  Suspended: 1,
  Impaired: 2
} as const;

export interface DStakeRouterV2FixtureResult {
  owner: SignerWithAddress;
  alice: SignerWithAddress;
  bob: SignerWithAddress;
  charlie: SignerWithAddress;
  guardian: SignerWithAddress;
  collateralExchanger: SignerWithAddress;
  dStable: TestMintableERC20;
  router: DStakeRouterV2;
  collateralVault: DStakeCollateralVaultV2;
  dStakeToken: DStakeTokenV2;
  vault1: MockMetaMorphoVault;
  vault2: MockMetaMorphoVault;
  vault3: MockMetaMorphoVault;
  adapter1: MetaMorphoConversionAdapter;
  adapter2: MetaMorphoConversionAdapter;
  adapter3: MetaMorphoConversionAdapter;
  urd: MockUniversalRewardsDistributor;
  vault1Address: string;
  vault2Address: string;
  vault3Address: string;
  adapter1Address: string;
  adapter2Address: string;
  adapter3Address: string;
}

const DEFAULT_DEPLOY_TAGS = [
  "local-setup",
  "oracle",
  "dusd",
  "deth",
  "dUSD-aTokenWrapper",
  "dETH-aTokenWrapper",
  "dlend",
  "dStake",
  "mock-metamorpho-vaults",
  "mock-urd",
  "metamorpho-adapters",
  "mock-metamorpho-rewards",
  "test-permissions"
];

export const createDStakeRouterV2Fixture = (
  config: DStakeFixtureConfig = SDUSD_CONFIG
) => {
  return deployments.createFixture(async ({ deployments, ethers, getNamedAccounts }) => {
    await deployments.fixture();
    await deployments.fixture(DEFAULT_DEPLOY_TAGS);

    const { deployer } = await getNamedAccounts();
    const [
      ownerSigner,
      aliceSigner,
      bobSigner,
      charlieSigner,
      guardianSigner,
      collateralExchangerSigner
    ] = await ethers.getSigners();

    const { contract: dStableBaseContract } = await getTokenContractForSymbol(
      { deployments, getNamedAccounts, ethers } as any,
      deployer,
      config.dStableSymbol
    );

    const dStableAddress = await dStableBaseContract.getAddress();
    const dStableContract = await ethers.getContractAt(
      "ERC20StablecoinUpgradeable",
      dStableAddress
    );

    const dStakeTokenDeployment = await deployments.get(config.DStakeTokenV2ContractId);
    const collateralVaultDeployment = await deployments.get(config.collateralVaultContractId);

    const dStakeTokenAddress = dStakeTokenDeployment?.address;
    const collateralVaultAddress = collateralVaultDeployment?.address;

    if (!dStakeTokenAddress || !ethers.isAddress(dStakeTokenAddress)) {
      throw new Error(`Invalid dStakeToken address: ${dStakeTokenAddress}`);
    }
    if (!collateralVaultAddress || !ethers.isAddress(collateralVaultAddress)) {
      throw new Error(`Invalid collateralVault address: ${collateralVaultAddress}`);
    }

    const routerDeployment = await deployments.deploy("Test_DStakeRouterV2_Shared", {
      contract: "DStakeRouterV2",
      from: deployer,
      args: [dStakeTokenAddress, collateralVaultAddress],
      log: false,
      skipIfAlreadyDeployed: false
    });

    const routerContract = await ethers.getContractAt("DStakeRouterV2", routerDeployment.address);
    const dStakeTokenContract = await ethers.getContractAt("DStakeTokenV2", dStakeTokenDeployment.address);
    const collateralVaultContract = await ethers.getContractAt(
      "DStakeCollateralVaultV2",
      collateralVaultDeployment.address
    );

    const MockMetaMorphoFactory = await ethers.getContractFactory("MockMetaMorphoVault");
    const vault1Contract = await MockMetaMorphoFactory.deploy(
      dStableAddress,
      "MetaMorpho Vault 1",
      "MM1"
    );
    await vault1Contract.waitForDeployment();

    const vault2Contract = await MockMetaMorphoFactory.deploy(
      dStableAddress,
      "MetaMorpho Vault 2",
      "MM2"
    );
    await vault2Contract.waitForDeployment();

    const vault3Contract = await MockMetaMorphoFactory.deploy(
      dStableAddress,
      "MetaMorpho Vault 3",
      "MM3"
    );
    await vault3Contract.waitForDeployment();

    const vault1Address = await vault1Contract.getAddress();
    const vault2Address = await vault2Contract.getAddress();
    const vault3Address = await vault3Contract.getAddress();

    const MetaMorphoAdapterFactory = await ethers.getContractFactory("MetaMorphoConversionAdapter");
    const adapter1Contract = await MetaMorphoAdapterFactory.deploy(
      dStableAddress,
      vault1Address,
      collateralVaultAddress,
      ownerSigner.address
    );
    await adapter1Contract.waitForDeployment();

    const adapter2Contract = await MetaMorphoAdapterFactory.deploy(
      dStableAddress,
      vault2Address,
      collateralVaultAddress,
      ownerSigner.address
    );
    await adapter2Contract.waitForDeployment();

    const adapter3Contract = await MetaMorphoAdapterFactory.deploy(
      dStableAddress,
      vault3Address,
      collateralVaultAddress,
      ownerSigner.address
    );
    await adapter3Contract.waitForDeployment();

    const adapter1Address = await adapter1Contract.getAddress();
    const adapter2Address = await adapter2Contract.getAddress();
    const adapter3Address = await adapter3Contract.getAddress();

    const urdDeployment = await deployments.get("MockUniversalRewardsDistributor");
    const urdContract = await ethers.getContractAt(
      "MockUniversalRewardsDistributor",
      urdDeployment.address
    );

    const vaultConfigs = [
      {
        strategyVault: vault1Address,
        adapter: adapter1Address,
        targetBps: 500000,
        status: VaultStatus.Active
      },
      {
        strategyVault: vault2Address,
        adapter: adapter2Address,
        targetBps: 300000,
        status: VaultStatus.Active
      },
      {
        strategyVault: vault3Address,
        adapter: adapter3Address,
        targetBps: 200000,
        status: VaultStatus.Active
      }
    ];

    const routerAdminRole = await routerContract.DEFAULT_ADMIN_ROLE();
    const routerAdminSigner = await resolveRoleSigner(
      routerContract,
      routerAdminRole,
      [
        ownerSigner.address,
        deployer,
        routerDeployment.receipt?.from,
      ],
      ownerSigner,
    );

    await ensureRoleGranted(routerContract, routerAdminRole, ownerSigner, routerAdminSigner);

    const VAULT_MANAGER_ROLE = await routerContract.VAULT_MANAGER_ROLE();
    const ADAPTER_MANAGER_ROLE = await routerContract.ADAPTER_MANAGER_ROLE();
    await ensureRoleGranted(routerContract, VAULT_MANAGER_ROLE, ownerSigner, routerAdminSigner);
    await ensureRoleGranted(routerContract, ADAPTER_MANAGER_ROLE, ownerSigner, routerAdminSigner);

    const routerContractAddress = await routerContract.getAddress();
    if (!(await routerContract.hasRole(ADAPTER_MANAGER_ROLE, routerContractAddress))) {
      await routerContract.connect(routerAdminSigner).grantRole(ADAPTER_MANAGER_ROLE, routerContractAddress);
    }

    const DSTAKE_TOKEN_ROLE = await routerContract.DSTAKE_TOKEN_ROLE();
    const STRATEGY_REBALANCER_ROLE = await routerContract.STRATEGY_REBALANCER_ROLE();
    const PAUSER_ROLE = await routerContract.PAUSER_ROLE();
    const ROUTER_ROLE = await collateralVaultContract.ROUTER_ROLE();

    const dStakeTokenContractAddress = await dStakeTokenContract.getAddress();
    const routerAddress = await routerContract.getAddress();

    if (!(await routerContract.hasRole(DSTAKE_TOKEN_ROLE, dStakeTokenContractAddress))) {
      await routerContract.connect(routerAdminSigner).grantRole(DSTAKE_TOKEN_ROLE, dStakeTokenContractAddress);
    }
    if (!(await routerContract.hasRole(STRATEGY_REBALANCER_ROLE, collateralExchangerSigner.address))) {
      await routerContract.connect(routerAdminSigner).grantRole(STRATEGY_REBALANCER_ROLE, collateralExchangerSigner.address);
    }
    if (!(await routerContract.hasRole(STRATEGY_REBALANCER_ROLE, routerAddress))) {
      await routerContract.connect(routerAdminSigner).grantRole(STRATEGY_REBALANCER_ROLE, routerAddress);
    }
    await ensureRoleGranted(routerContract, PAUSER_ROLE, ownerSigner, routerAdminSigner);

    const DEFAULT_ADMIN_ROLE_VAULT = await collateralVaultContract.DEFAULT_ADMIN_ROLE();
    const collateralAdminSigner = await resolveRoleSigner(
      collateralVaultContract,
      DEFAULT_ADMIN_ROLE_VAULT,
      [
        ownerSigner.address,
        deployer,
        collateralVaultDeployment.receipt?.from,
      ],
      ownerSigner,
    );

    await ensureRoleGranted(collateralVaultContract, DEFAULT_ADMIN_ROLE_VAULT, ownerSigner, collateralAdminSigner);

    if ((await collateralVaultContract.router()).toLowerCase() !== routerAddress.toLowerCase()) {
      await collateralVaultContract.connect(ownerSigner).setRouter(routerAddress);
    }
    if (!(await collateralVaultContract.hasRole(ROUTER_ROLE, routerAddress))) {
      await collateralVaultContract.connect(ownerSigner).grantRole(ROUTER_ROLE, routerAddress);
    }

    await routerContract.connect(ownerSigner).setVaultConfigs(vaultConfigs);

    let supportedAssets = await collateralVaultContract.getSupportedStrategyShares();
    for (const configEntry of vaultConfigs) {
      if (!supportedAssets.includes(configEntry.strategyVault)) {
        await routerContract
          .connect(ownerSigner)
          .addAdapter(configEntry.strategyVault, configEntry.adapter);
        supportedAssets = await collateralVaultContract.getSupportedStrategyShares();
      }
    }

    const DEFAULT_ADMIN_ROLE_TOKEN = await dStakeTokenContract.DEFAULT_ADMIN_ROLE();
    const tokenAdminSigner = await resolveRoleSigner(
      dStakeTokenContract,
      DEFAULT_ADMIN_ROLE_TOKEN,
      [
        ownerSigner.address,
        deployer,
        dStakeTokenDeployment.receipt?.from,
      ],
      ownerSigner,
    );

    await ensureRoleGranted(dStakeTokenContract, DEFAULT_ADMIN_ROLE_TOKEN, ownerSigner, tokenAdminSigner);

    const desiredRouter = routerAddress;
    const desiredVault = collateralVaultAddress!;
    const currentRouter = await dStakeTokenContract.router();
    const currentVault = await dStakeTokenContract.collateralVault();

    const needsMigration = currentRouter !== desiredRouter || currentVault !== desiredVault;

    if (needsMigration) {
      await dStakeTokenContract
        .connect(ownerSigner)
        .migrateCore(desiredRouter, desiredVault);
    }

    const initialBalance = ethers.parseEther("100000");
    await dStableContract.mint(aliceSigner.address, initialBalance);
    await dStableContract.mint(bobSigner.address, initialBalance);
    await dStableContract.mint(charlieSigner.address, initialBalance);

    return {
      owner: ownerSigner,
      alice: aliceSigner,
      bob: bobSigner,
      charlie: charlieSigner,
      guardian: guardianSigner,
      collateralExchanger: collateralExchangerSigner,
      dStable: dStableContract as unknown as TestMintableERC20,
      router: routerContract,
      collateralVault: collateralVaultContract,
      dStakeToken: dStakeTokenContract,
      vault1: vault1Contract,
      vault2: vault2Contract,
      vault3: vault3Contract,
      adapter1: adapter1Contract,
      adapter2: adapter2Contract,
      adapter3: adapter3Contract,
      urd: urdContract,
      vault1Address,
      vault2Address,
      vault3Address,
      adapter1Address,
      adapter2Address,
      adapter3Address
    } as DStakeRouterV2FixtureResult;
  });
};
