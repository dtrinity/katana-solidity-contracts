import { HardhatRuntimeEnvironment } from "hardhat/types";
import { AbiItem } from "web3-utils";
import * as fs from "fs";
import * as path from "path";

import { DEFAULT_MULTICALL3_ADDRESS, executeMulticall, MulticallRequest } from "./multicall";
// Type guards for ABI fragments
function isAbiFunctionFragment(
  item: AbiItem,
): item is AbiItem & { type: "function"; name: string; stateMutability?: string; inputs?: any[]; outputs?: any[] } {
  return item.type === "function";
}

export interface RoleInfo {
  name: string;
  hash: string;
}

export interface RolesContractInfo {
  deploymentName: string;
  name: string;
  address: string;
  abi: AbiItem[];
  roles: RoleInfo[];
  rolesHeldByDeployer: RoleInfo[];
  rolesHeldByGovernance: RoleInfo[];
  defaultAdminRoleHash?: string;
  governanceHasDefaultAdmin: boolean;
}

export interface OwnableContractInfo {
  deploymentName: string;
  name: string;
  address: string;
  abi: AbiItem[];
  owner: string;
  deployerIsOwner: boolean;
  governanceIsOwner: boolean;
}

export interface ScanResult {
  rolesContracts: RolesContractInfo[];
  ownableContracts: OwnableContractInfo[];
}

export interface ScanOptions {
  hre: HardhatRuntimeEnvironment;
  deployer: string;
  governanceMultisig: string;
  deploymentsPath?: string;
  logger?: (message: string) => void;
  multicallAddress?: string;
}

export async function scanRolesAndOwnership(options: ScanOptions): Promise<ScanResult> {
  const { hre, deployer, governanceMultisig, logger } = options;
  const ethers = (hre as any).ethers;
  const network = (hre as any).network;
  const log = logger || (() => {});
  const multicallAddress = options.multicallAddress ?? DEFAULT_MULTICALL3_ADDRESS;

  const deploymentsPath = options.deploymentsPath || path.join((hre as any).config.paths.deployments, network.name);
  if (!fs.existsSync(deploymentsPath)) {
    throw new Error(`Deployments directory not found for network ${network.name}: ${deploymentsPath}`);
  }

  const deploymentFiles = fs
    .readdirSync(deploymentsPath)
    .filter((f) => f.endsWith(".json") && f !== ".migrations.json" && f !== "solcInputs");

  const rolesContracts: RolesContractInfo[] = [];
  const ownableContracts: OwnableContractInfo[] = [];

  for (const filename of deploymentFiles) {
    try {
      const artifactPath = path.join(deploymentsPath, filename);
      const deployment = JSON.parse(fs.readFileSync(artifactPath, "utf-8"));
      const abi: AbiItem[] = deployment.abi;
      const contractAddress: string = deployment.address;
      const deploymentName: string = filename.replace(".json", "");
      const contractName: string = deployment.contractName || deploymentName;

      // Detect AccessControl
      const hasRoleFn = abi.find(
        (item) =>
          isAbiFunctionFragment(item) &&
          item.name === "hasRole" &&
          item.inputs?.length === 2 &&
          item.inputs[0].type === "bytes32" &&
          item.inputs[1].type === "address" &&
          item.outputs?.length === 1 &&
          item.outputs[0].type === "bool",
      );

      if (hasRoleFn) {
        log(`  Contract ${contractName} has a hasRole function.`);
        log(`\nChecking roles for contract: ${contractName} at ${contractAddress}`);
        const contract = await ethers.getContractAt(abi as any, contractAddress);
        const contractInterface = (contract as any).interface;

        const roleHashes = new Map<string, string>();
        const recordRoleHash = (name: string, hash: string) => {
          if (!roleHashes.has(name)) {
            roleHashes.set(name, hash);
            log(`  - Found role: ${name} with hash ${hash}`);
          }
        };

        const constantFragments = abi.filter(
          (item) =>
            isAbiFunctionFragment(item) &&
            item.stateMutability === "view" &&
            ((item.name?.endsWith("_ROLE") as boolean) || item.name === "DEFAULT_ADMIN_ROLE") &&
            (item.inputs?.length ?? 0) === 0 &&
            item.outputs?.length === 1 &&
            item.outputs[0].type === "bytes32" &&
            item.name,
        );

        if (constantFragments.length > 0) {
          const constantCalls: MulticallRequest[] = constantFragments.map((item) => ({
            target: contractAddress,
            allowFailure: true,
            callData: contractInterface.encodeFunctionData(item.name!, []),
          }));

          const constantResults = await executeMulticall(
            hre as any,
            constantCalls,
            { address: multicallAddress, logger: log },
          );

          const fallbackConstants: string[] = [];

          if (constantResults) {
            for (let index = 0; index < constantResults.length; index += 1) {
              const fragment = constantFragments[index];
              const result = constantResults[index];

              if (!result || !result.success) {
                fallbackConstants.push(fragment.name!);
                continue;
              }

              try {
                const decoded = contractInterface.decodeFunctionResult(fragment.name!, result.returnData);
                const hashValue = String(decoded[0]);
                recordRoleHash(fragment.name!, hashValue);
              } catch {
                fallbackConstants.push(fragment.name!);
              }
            }
          } else {
            fallbackConstants.push(...constantFragments.map((fragment) => fragment.name!));
          }

          for (const name of fallbackConstants) {
            try {
              const roleHash: string = await (contract as any)[name]();
              recordRoleHash(name, roleHash);
            } catch {
              // ignore role hash failures for this item
            }
          }
        }

        const roles: RoleInfo[] = Array.from(roleHashes.entries()).map(([name, hash]) => ({ name, hash }));

        const rolesHeldByDeployer: RoleInfo[] = [];
        const rolesHeldByGovernance: RoleInfo[] = [];
        const deployerRoleHashes = new Set<string>();
        const governanceRoleHashes = new Set<string>();

        const recordHolder = (holder: "deployer" | "governance", role: RoleInfo) => {
          if (holder === "deployer") {
            if (!deployerRoleHashes.has(role.hash)) {
              deployerRoleHashes.add(role.hash);
              rolesHeldByDeployer.push(role);
              log(`    Deployer HAS role ${role.name}`);
            }
          } else if (!governanceRoleHashes.has(role.hash)) {
            governanceRoleHashes.add(role.hash);
            rolesHeldByGovernance.push(role);
            log(`    Governance HAS role ${role.name}`);
          }
        };

        if (roles.length > 0) {
          const hasRoleCalls: MulticallRequest[] = [];
          const hasRoleMetadata: { role: RoleInfo; holder: "deployer" | "governance" }[] = [];

          for (const role of roles) {
            hasRoleMetadata.push({ role, holder: "deployer" });
            hasRoleCalls.push({
              target: contractAddress,
              allowFailure: true,
              callData: contractInterface.encodeFunctionData("hasRole", [role.hash, deployer]),
            });

            hasRoleMetadata.push({ role, holder: "governance" });
            hasRoleCalls.push({
              target: contractAddress,
              allowFailure: true,
              callData: contractInterface.encodeFunctionData("hasRole", [role.hash, governanceMultisig]),
            });
          }

          const hasRoleResults = await executeMulticall(
            hre as any,
            hasRoleCalls,
            { address: multicallAddress, logger: log },
          );

          const fallbackChecks: { role: RoleInfo; holder: "deployer" | "governance" }[] = [];

          if (hasRoleResults) {
            for (let index = 0; index < hasRoleResults.length; index += 1) {
              const query = hasRoleMetadata[index];
              const result = hasRoleResults[index];

              if (!result || !result.success) {
                fallbackChecks.push(query);
                continue;
              }

              try {
                const decoded = contractInterface.decodeFunctionResult("hasRole", result.returnData);
                const holds = Boolean(decoded[0]);
                if (holds) {
                  recordHolder(query.holder, query.role);
                }
              } catch {
                fallbackChecks.push(query);
              }
            }
          } else {
            fallbackChecks.push(...hasRoleMetadata);
          }

          for (const query of fallbackChecks) {
            try {
              const holder = query.holder === "deployer" ? deployer : governanceMultisig;
              if (await (contract as any).hasRole(query.role.hash, holder)) {
                recordHolder(query.holder, query.role);
              }
            } catch {
              // ignore failures
            }
          }
        }

        const defaultAdmin = roles.find((r) => r.name === "DEFAULT_ADMIN_ROLE");
        const governanceHasDefaultAdmin =
          defaultAdmin !== undefined ? governanceRoleHashes.has(defaultAdmin.hash) : false;
        if (defaultAdmin) {
          log(`    governanceHasDefaultAdmin: ${governanceHasDefaultAdmin}`);
        }

        rolesContracts.push({
          deploymentName,
          name: contractName,
          address: contractAddress,
          abi,
          roles,
          rolesHeldByDeployer,
          rolesHeldByGovernance,
          defaultAdminRoleHash: defaultAdmin?.hash,
          governanceHasDefaultAdmin,
        });
      }

      // Detect Ownable (owner() view returns address)
      const ownerFn = abi.find(
        (item) =>
          isAbiFunctionFragment(item) &&
          item.name === "owner" &&
          (item.inputs?.length ?? 0) === 0 &&
          item.outputs?.length === 1 &&
          item.outputs[0].type === "address",
      );

      if (ownerFn) {
        try {
          const contract = await ethers.getContractAt(abi as any, contractAddress);
          const owner: string = await (contract as any).owner();
          const ownerLower = owner.toLowerCase();
          const deployerLower = deployer?.toLowerCase?.();
          const governanceLower = governanceMultisig?.toLowerCase?.();
          log(`  Contract ${contractName} appears to be Ownable. owner=${owner}`);
          ownableContracts.push({
            deploymentName,
            name: contractName,
            address: contractAddress,
            abi,
            owner,
            deployerIsOwner: deployerLower ? ownerLower === deployerLower : false,
            governanceIsOwner: governanceLower ? ownerLower === governanceLower : false,
          });
        } catch (error) {
          log(`    Failed to resolve owner for ${contractName}: ${error}`);
        }
      }
    } catch {
      // ignore malformed artifact
    }
  }

  return { rolesContracts, ownableContracts };
}
