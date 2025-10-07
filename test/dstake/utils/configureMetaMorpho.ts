import { ethers } from "hardhat";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import type { Deployment } from "hardhat-deploy/types";

import type {
  DStakeRouterV2,
  DStakeCollateralVaultV2,
  MetaMorphoConversionAdapter,
  MockMetaMorphoVault,
} from "../../../typechain-types";

type NamedAccounts = Record<string, string | undefined> | undefined;

export interface ConfigureMetaMorphoParams {
  router: DStakeRouterV2;
  routerDeployment: Deployment;
  collateralVault: DStakeCollateralVaultV2;
  collateralVaultDeployment: Deployment;
  vault: MockMetaMorphoVault;
  adapter: MetaMorphoConversionAdapter;
  operator: SignerWithAddress;
  namedAccounts?: NamedAccounts;
  targetBps?: number;
  vaultStatus?: number;
}

export async function configureMetaMorphoRouter({
  router,
  routerDeployment,
  collateralVault,
  collateralVaultDeployment,
  vault,
  adapter,
  operator,
  namedAccounts,
  targetBps = 1_000_000,
  vaultStatus = 0,
}: ConfigureMetaMorphoParams): Promise<void> {
  const routerAdminSigner = await findAdminSigner(router, routerDeployment, operator, namedAccounts);

  const vaultManagerRole = await router.VAULT_MANAGER_ROLE();
  const adapterManagerRole = await router.ADAPTER_MANAGER_ROLE();
  const configManagerRole = await router.CONFIG_MANAGER_ROLE();

  if (!(await router.hasRole(vaultManagerRole, operator.address))) {
    await router.connect(routerAdminSigner).grantRole(vaultManagerRole, operator.address);
  }
  if (!(await router.hasRole(adapterManagerRole, operator.address))) {
    await router.connect(routerAdminSigner).grantRole(adapterManagerRole, operator.address);
  }
  if (!(await router.hasRole(configManagerRole, operator.address))) {
    await router.connect(routerAdminSigner).grantRole(configManagerRole, operator.address);
  }

  const collateralAdminSigner = await findAdminSigner(collateralVault, collateralVaultDeployment, operator, namedAccounts);
  const routerAddress = await router.getAddress();
  const routerRole = await collateralVault.ROUTER_ROLE();
  if (!(await collateralVault.hasRole(routerRole, routerAddress))) {
    await collateralVault.connect(collateralAdminSigner).setRouter(routerAddress);
  }

  const strategyShare = await vault.getAddress();
  const adapterAddress = await adapter.getAddress();

  // Register adapter and ensure collateral vault tracks the share
  await router.connect(operator).addAdapter(strategyShare, adapterAddress);

  const supportedShares = await collateralVault.getSupportedStrategyShares();
  if (!supportedShares.map((addr: string) => addr.toLowerCase()).includes(strategyShare.toLowerCase())) {
    const routerSigner = await impersonate(routerAddress, operator);
    await collateralVault.connect(routerSigner).addSupportedStrategyShare(strategyShare);
  }

  if (!(await router.vaultExists(strategyShare))) {
    await router.connect(operator).addVaultConfig(strategyShare, adapterAddress, targetBps, vaultStatus);
  } else {
    await router.connect(operator).updateVaultConfig(strategyShare, adapterAddress, targetBps, vaultStatus);
  }

  if ((await router.defaultDepositStrategyShare()).toLowerCase() !== strategyShare.toLowerCase()) {
    await router.connect(operator).setDefaultDepositStrategyShare(strategyShare);
  }
}

export interface EnsureRoleParams {
  contract: { DEFAULT_ADMIN_ROLE(): Promise<string>; hasRole(role: string, account: string): Promise<boolean>; grantRole(role: string, account: string): Promise<void> };
  deployment: Deployment;
  role: string;
  operator: SignerWithAddress;
  namedAccounts?: NamedAccounts;
}

export async function ensureRole({ contract, deployment, role, operator, namedAccounts }: EnsureRoleParams): Promise<void> {
  if (await contract.hasRole(role, operator.address)) {
    return;
  }
  const adminSigner = await findAdminSigner(contract, deployment, operator, namedAccounts);
  await contract.connect(adminSigner).grantRole(role, operator.address);
}

async function findAdminSigner(
  contract: { DEFAULT_ADMIN_ROLE(): Promise<string>; hasRole(role: string, account: string): Promise<boolean> },
  deployment: Deployment,
  operator: SignerWithAddress,
  namedAccounts?: NamedAccounts
): Promise<SignerWithAddress> {
  const defaultAdminRole = await contract.DEFAULT_ADMIN_ROLE();

  const candidates = new Set<string>();
  candidates.add(operator.address);
  if (deployment?.receipt?.from) {
    candidates.add(deployment.receipt.from);
  }
  if (namedAccounts) {
    Object.values(namedAccounts).forEach((addr) => {
      if (addr) {
        candidates.add(addr);
      }
    });
  }

  for (const candidate of candidates) {
    if (!(await contract.hasRole(defaultAdminRole, candidate))) {
      continue;
    }
    if (candidate.toLowerCase() === operator.address.toLowerCase()) {
      return operator;
    }
    return impersonate(candidate, operator);
  }

  throw new Error("Unable to locate admin signer for contract");
}

async function impersonate(address: string, funder: SignerWithAddress): Promise<SignerWithAddress> {
  const signer = await ethers.getImpersonatedSigner(address);
  const balance = await ethers.provider.getBalance(address);
  if (balance === 0n) {
    await funder.sendTransaction({ to: address, value: ethers.parseEther("1") });
  }
  return signer;
}
